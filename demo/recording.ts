// Shared machinery for the demo videos (demo/record.ts, demo/walkthrough.ts): a throwaway server,
// Chrome screencast capture, in-page captions and cards, narration, and ffmpeg encoding.
// Needs Google Chrome and ffmpeg. Narration uses the open-source Kokoro-82M model (kokoro-js, runs
// locally; the model downloads on first use), or macOS `say` with NARRATOR=say.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "playwright-core";
import { tachiNetwork } from "@tachi-hack/agent-sdk";
import type { KokoroTTS } from "kokoro-js";

/** Written form → how the narrator should say it (subtitles keep the written form). */
const PRONOUNCE: [RegExp, string][] = [
  [/\bx402\b/g, "x 4 0 2"],
  [/\bNIP-17\b/g, "nip seventeen"],
  [/\bNostr\b/g, "Noster"],
  [/\bvTXOs\b/g, "V T X Os"],
  [/\bnpm\b/g, "N P M"],
  [/\bBTC\b/g, "B T C"],
  [/\b402\b/g, "4 0 2"],
  [/\b4402\b/g, "44 0 2"],
];

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
const ffmpeg = (args: string[]) => run("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const duration = (file: string) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());

/** Starts a fresh server (empty dashboard) on `port`, so recordings never touch the one you're using. */
export async function startServer(port: number): Promise<{ base: string; stop: () => void }> {
  const base = `http://localhost:${port}`;
  const up = () => fetch(`${base}/health`).then((r) => r.ok, () => false);
  if (await up()) throw new Error(`Port ${port} is busy; set RECORD_PORT to a free port`);
  const proc: ChildProcess = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    stdio: "ignore",
    env: { ...process.env, PORT: String(port), TACHI_NETWORK: tachiNetwork().name },
  });
  for (let i = 0; i < 60 && !(await up()); i++) await wait(300);
  if (!(await up())) {
    proc.kill();
    throw new Error("The recording server didn't start");
  }
  return { base, stop: () => proc.kill() };
}

// Captions and title cards are drawn in the page, in the dashboard's own typeface.
const OVERLAY_CSS = `
  #rec-cap{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:10001;width:max-content;max-width:1120px;
    background:#15202b;color:#e4e9ee;font:600 25px/1.4 "Schibsted Grotesk",system-ui,sans-serif;text-align:center;
    padding:14px 26px;border-radius:4px;letter-spacing:-.01em}
  #rec-cap:empty{display:none}
  #rec-cap b{color:#e8840f;font-weight:700}
  #rec-card{position:fixed;inset:0;z-index:10000;background:#e4e9ee;color:#15202b;display:flex;flex-direction:column;
    justify-content:center;padding:0 160px;font-family:"Schibsted Grotesk",system-ui,sans-serif;transition:opacity .5s}
  #rec-card h1{font-size:92px;line-height:1.02;font-weight:800;letter-spacing:-.03em;margin:0 0 28px;max-width:16ch}
  #rec-card p{font-size:34px;line-height:1.35;color:#4b5a6a;margin:0;max-width:40ch}
  #rec-card i{font-style:normal;display:inline-block;width:22px;height:22px;background:#e8840f;margin-right:16px;vertical-align:middle}
  #rec-card code{font-family:"JetBrains Mono",monospace;font-size:30px;color:#15202b}`;

interface Frame {
  file: string;
  t: number;
}
interface Line {
  frame: number; // index of the first frame shown with this line
  text: string;
  audio?: string;
  seconds: number;
}

export class Recorder {
  readonly work = mkdtempSync(path.join(tmpdir(), "tachi-record-"));
  private frames: Frame[] = [];
  private lines: Line[] = [];
  private cdp: CDPSession | null = null;
  private endedAt = 0;
  private cutAt = 0;
  /** Wall time skipped by cut() (page loads, narration generation). */
  private paused = 0;
  private now = () => Date.now() / 1000 - this.paused;
  browser!: Browser;
  ctx!: BrowserContext;

  private readonly engine = process.env.NARRATOR === "say" ? "say" : "kokoro";
  private readonly voice = process.env.NARRATOR_VOICE || (this.engine === "say" ? "Samantha" : "af_heart");
  private tts?: Promise<KokoroTTS>;

  async open(url: string): Promise<Page> {
    this.browser = await chromium.launch({ channel: "chrome", headless: true });
    this.ctx = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await this.ctx.newPage();
    await Recorder.load(page, () => page.goto(url));
    await this.prep(page);
    return page;
  }

  /**
   * Navigates and waits for the dashboard headline. (Not "networkidle": the dashboard polls slow
   * Nostr relays, so the network is never idle for long.)
   */
  static async load(page: Page, navigate: () => Promise<unknown>) {
    await navigate();
    await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 30_000 });
    await wait(1500);
  }

  async prep(page: Page) {
    await page.addStyleTag({ content: OVERLAY_CSS });
    await page
      .addStyleTag({ url: "https://fonts.googleapis.com/css2?family=JetBrains+Mono&family=Schibsted+Grotesk:wght@400;600;700;800&display=swap" })
      .catch(() => {});
  }

  /** Freezes the video here until the next capture(), e.g. while another page loads. */
  async cut() {
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.cdp?.detach().catch(() => {});
    this.cdp = null;
    this.cutAt = this.now();
  }

  /**
   * Records `page` from now on. Time since cut() (if any) is skipped. Keep to one tab: Chrome can
   * keep streaming a background tab's frames into the new session.
   */
  async capture(page: Page) {
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.cdp?.detach().catch(() => {});
    if (this.cutAt) {
      this.paused += this.now() - this.cutAt;
      this.cutAt = 0;
    }
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
      const file = path.join(this.work, `f${String(this.frames.length).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(data, "base64"));
      this.frames.push({ file, t: this.now() });
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2880, maxHeight: 1800 });
    this.cdp = cdp;
  }

  caption(page: Page, html: string) {
    return page.evaluate((html) => {
      let el = document.getElementById("rec-cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "rec-cap";
        document.body.appendChild(el);
      }
      el.innerHTML = html;
    }, html);
  }

  card(page: Page, html: string | null) {
    return page.evaluate((html) => {
      let el = document.getElementById("rec-card");
      if (!el) {
        el = document.createElement("div");
        el.id = "rec-card";
        document.body.appendChild(el);
      }
      if (html) {
        el.innerHTML = html;
        el.style.opacity = "1";
      } else {
        el.style.opacity = "0";
        setTimeout(() => el!.remove(), 600);
      }
    }, html);
  }

  /** A caption without narration, held for `ms`. */
  async show(page: Page, html: string, ms: number) {
    this.lines.push({ frame: this.frames.length, text: html.replace(/<[^>]+>/g, ""), seconds: ms / 1000 });
    await this.caption(page, html);
    await wait(ms);
  }

  /** Generates a narration line from its spoken form. */
  private async voice_(text: string) {
    const spoken = PRONOUNCE.reduce((t, [re, say]) => t.replace(re, say), text);
    if (this.engine === "say") {
      const audio = path.join(this.work, `line${this.lines.length}.aiff`);
      run("say", ["-v", this.voice, "-r", "182", "-o", audio, spoken]);
      return { audio, seconds: duration(audio) };
    }
    this.tts ??= import("kokoro-js").then((m) => m.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" }));
    const audio = path.join(this.work, `line${this.lines.length}.wav`);
    const tts = await this.tts;
    await (await tts.generate(spoken, { voice: this.voice as "af_heart" })).save(audio);
    return { audio, seconds: duration(audio) };
  }

  /**
   * Speaks `html` (tags stripped) and shows it as the subtitle; resolves when the line has finished.
   * Pass `during` to act while the line is spoken — the line waits for it, too.
   */
  async say(page: Page, html: string, during?: () => Promise<unknown>) {
    const text = html.replace(/<[^>]+>/g, "");
    // Generating takes a few seconds; pause the recording so it doesn't show as dead air.
    await this.cut();
    const { audio, seconds } = await this.voice_(text);
    await this.capture(page);
    this.lines.push({ frame: this.frames.length, text, audio, seconds });
    await this.caption(page, html);
    await Promise.all([wait(seconds * 1000 + 350), during?.()]);
  }

  async close() {
    this.endedAt ||= this.now();
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.browser?.close();
  }

  /**
   * Writes `output`. With `fitSeconds` the video is sped up or slowed to that length (no audio);
   * otherwise it keeps real time, with narration and subtitles (soft track + `.srt` beside it).
   */
  encode(output: string, opts: { fitSeconds?: number } = {}) {
    const { frames, lines } = this;
    if (frames.length < 2) throw new Error("No frames were captured");
    mkdirSync(path.dirname(output), { recursive: true });

    // Each frame is held until the next one arrived (time skipped by cut() and narration is already removed).
    const starts: number[] = [];
    let list = "";
    let clock = 0;
    for (let i = 0; i < frames.length; i++) {
      const next = frames[i + 1];
      const dur = Math.max((next ? next.t : this.endedAt) - frames[i].t, 0.001);
      starts.push(clock);
      clock += dur;
      list += `file '${frames[i].file}'\nduration ${dur.toFixed(4)}\n`;
    }
    list += `file '${frames.at(-1)!.file}'\n`;
    const listFile = path.join(this.work, "list.txt");
    const video = path.join(this.work, "video.mp4");
    writeFileSync(listFile, list);
    if (process.env.RECORD_DEBUG) writeFileSync(path.join(this.work, "timeline.json"), JSON.stringify({ frames, lines, starts, endedAt: this.endedAt }, null, 1));
    ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-vf", "scale=1920:1200:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1200:-1:-1:color=0xE4E9EE,fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", video]);

    if (opts.fitSeconds) {
      const seconds = duration(video);
      ffmpeg(["-i", video, "-vf", `setpts=PTS*${opts.fitSeconds}/${seconds},fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", "-t", String(opts.fitSeconds), output]);
      return { seconds: opts.fitSeconds, recorded: seconds };
    }

    // Line timing comes from the frame that first showed it, so speech and picture stay in sync.
    const at = (l: Line) => starts[Math.min(l.frame, starts.length - 1)];
    const ts = (s: number) => {
      const ms = Math.round(s * 1000);
      const p = (n: number, w = 2) => String(n).padStart(w, "0");
      return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
    };
    const srt = lines.map((l, i) => `${i + 1}\n${ts(at(l))} --> ${ts(at(l) + l.seconds)}\n${l.text}\n`).join("\n");
    const srtFile = output.replace(/\.mp4$/, ".srt");
    writeFileSync(srtFile, srt);

    const spoken = lines.filter((l) => l.audio);
    const inputs = spoken.flatMap((l) => ["-i", l.audio!]);
    const delays = spoken.map((l, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(at(l) * 1000)}:all=1[a${i}]`);
    const mix = `${delays.join(";")};${spoken.map((_, i) => `[a${i}]`).join("")}amix=inputs=${spoken.length}:normalize=0,apad[aout]`;
    ffmpeg([
      "-i", video, ...inputs, "-i", srtFile,
      "-filter_complex", mix,
      "-map", "0:v", "-map", "[aout]", "-map", `${spoken.length + 1}:s`,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
      "-shortest", "-movflags", "+faststart", output,
    ]);
    return { seconds: duration(output), recorded: clock, srt: srtFile };
  }

  cleanup() {
    if (process.env.RECORD_DEBUG) return console.log(`Kept ${this.work}`);
    rmSync(this.work, { recursive: true, force: true });
  }
}
