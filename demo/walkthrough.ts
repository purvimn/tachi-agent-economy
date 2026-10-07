// Records the narrated end-to-end demo: docs/demo-walkthrough.mp4 (voice + subtitle track) and
// docs/demo-walkthrough.srt.
//   npm run walkthrough            (NARRATOR_VOICE=… to change the voice)
// Runs every dashboard action: real Tachi payments (~1,000 sats in total) and public Nostr relay
// traffic. See demo/recording.ts for requirements.
import path from "node:path";
import type { Page } from "playwright-core";
import { Recorder, startServer, wait } from "./recording.js";

const OUTPUT = path.resolve("docs/demo-walkthrough.mp4");

/** Smoothly scrolls so the element's top sits `offset` px below the viewport top. */
async function scrollToEl(page: Page, locator: ReturnType<Page["locator"]>, offset = 90) {
  await locator.first().evaluate((el, offset) => {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
  }, offset);
  await wait(700);
}
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
const toTop = async (page: Page) => {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await wait(800);
};
const click = (page: Page, name: string) => () => page.getByRole("button", { name, exact: true }).click();

async function main() {
  const server = await startServer(Number(process.env.RECORD_PORT || 4410));
  const rec = new Recorder();
  try {
    const page = await rec.open(server.base);
    const network = (await (await fetch(`${server.base}/config`)).json()).network as string;
    const job = async () => (await (await fetch(`${server.base}/demo/job`)).json()).result;

    // Intro
    await rec.card(page, `<h1>Tachi Agent Economy</h1><p><i></i>AI agents that find each other on Nostr, pay each other over x402, and settle in bitcoin on Tachi.</p>`);
    await wait(600);
    await rec.capture(page);
    await rec.say(page, "This is Tachi Agent Economy: AI agents that find each other, buy from each other, and pay in bitcoin.");
    await rec.say(page, "Every agent is a <b>Nostr</b> key, every payment uses <b>x402</b>, and it all settles on <b>Tachi</b>.");
    await rec.card(page, null);
    await rec.say(page, `Everything runs from this dashboard. TreasuryBot, on the right, holds about five bitcoin on Tachi ${network}.`);

    // Simulated economy
    await rec.say(page, "First, some demo agents. They buy data, inference and coffee from each other, in simulation.", click(page, "Add demo agents"));
    await page.getByText("Demo agents added.").waitFor({ timeout: 30_000 });

    // Nostr discovery and private messages
    await rec.say(page, "Now real agents. DataVendor publishes its profile and a data offer to three public <b>Nostr relays</b>.", click(page, "Find a seller on Nostr"));
    await rec.say(page, "TreasuryBot finds the offer on the relays, then asks about it in an encrypted <b>NIP-17</b> message.");
    await page.getByText("Found DataVendor on Nostr").waitFor({ timeout: 90_000 });
    await rec.say(page, "DataVendor replies with its price and endpoint. Both sides log the conversation as signed events.");

    // A real x402 payment
    await toTop(page);
    await rec.say(page, "TreasuryBot asks for the data and gets an HTTP <b>402</b>, in the standard x402 format, for fifty sats.", click(page, "Make a real payment"));
    await rec.say(page, "It pays with a Tachi transfer it signs itself, then sends back a proof signed with its own key.");
    await rec.say(page, "The server checks the transaction <b>on chain</b> before it serves the data.");
    await page.getByText("Payment settled and verified.").waitFor({ timeout: 120_000 });
    await rec.say(page, "Settled and verified. Replaying the proof fails, and so does a stranger claiming it, because only the payer can sign.");

    // The explorer
    const tx = await page.getByRole("link", { name: "View the transaction" }).getAttribute("href");
    await rec.cut();
    await page.goto(tx!, { waitUntil: "domcontentloaded" });
    await page.getByText("Confirmed").first().waitFor({ timeout: 30_000 });
    await rec.prep(page);
    await wait(800);
    await rec.capture(page);
    await rec.say(page, "Here's that payment on the Tachi explorer, <b>confirmed</b>: fifty sats to DataVendor, the change back to TreasuryBot.");
    await rec.cut();
    await Recorder.load(page, () => page.goBack());
    await rec.prep(page);
    await page.getByText("Payment settled and verified.").waitFor({ timeout: 30_000 });
    await wait(600);
    await rec.capture(page);

    // Dataset marketplace
    await rec.say(page, "Next, a training dataset. TreasuryBot buys it from DataVendor for three hundred sats.", click(page, "Buy a dataset"));
    await rec.say(page, "It arrives <b>sealed to TreasuryBot's Nostr key</b>, so only the buyer can read it.");
    await page.getByText("Dataset bought and verified.").waitFor({ timeout: 120_000 });
    await rec.say(page, "TreasuryBot opens it, checks it against its hash, and rates it. Only buyers who paid can rate.");

    // High-frequency payments
    await rec.say(page, "Agents also pay at high frequency. Here are twenty-five paid requests, all at once.", click(page, "Run 25 paid requests"));
    await page.getByText(/paid requests served/).waitFor({ timeout: 180_000 });
    const burst = await job();
    await rec.say(page, `${burst.served} real payments, served in ${Number(burst.seconds).toFixed(1)} seconds. Each one is its own Tachi transfer.`);

    // Graph, inspector, discovery, marketplace
    await scrollToEl(page, page.getByRole("img", { name: "Payments between agents" }), 40);
    await rec.say(page, "The graph shows who paid whom. <b>Orange</b> lines settled on Tachi; dashed ones were simulated.");
    await scrollToEl(page, heading(page, "Agents"));
    await rec.say(page, "Select any agent to inspect it: its Nostr identity, what it published, its payments, and every signed event, re-verified.", async () => {
      await page.getByRole("button", { name: "DataVendor", exact: true }).click();
      await wait(1200);
      await scrollToEl(page, page.getByText(/signed events verify against this key/), 200);
    });
    await scrollToEl(page, heading(page, "On Nostr"));
    await rec.say(page, "These offers come straight from the public relays. This is how agents discover each other.");
    await scrollToEl(page, heading(page, "For sale"));
    await rec.say(page, "The dataset now shows its sale and its rating from a verified buyer.");

    // Audit anchoring
    await toTop(page);
    await rec.say(page, "Finally, TreasuryBot anchors the whole event log on Tachi, as a hash written into a transaction.", click(page, "Anchor the log on Tachi"));
    await page.getByText(/Anchored \d+ events/).waitFor({ timeout: 120_000 });
    await wait(3500);
    await scrollToEl(page, heading(page, "Signed events"));
    await rec.say(page, "Every action is a signed Nostr event. If anyone edits the log later, it stops matching its anchor.", () =>
      page.getByText(/Show all \d+ events/).click(),
    );

    // Funding and outro
    await toTop(page);
    await rec.say(page, "To fund a treasury, send bitcoin to its address and paste the transaction ID. The page deposits it to Tachi.", () =>
      page.getByText(/Add funds from Bitcoin/).click(),
    );
    await rec.card(page, `<h1>Agents that pay agents.</h1><p><i></i>Nostr identity and discovery, x402 payments, private data delivery, bitcoin settlement on Tachi.</p><p style="margin-top:36px"><code>npm install · npm run build · npm run server</code></p>`);
    await rec.say(page, "To run it yourself: npm install, npm run build, npm run server, then open localhost port 4402.");
    await wait(1200);
    await rec.close();

    const out = rec.encode(OUTPUT);
    console.log(`Wrote ${OUTPUT} (${out.seconds.toFixed(1)}s) and ${out.srt}. Payment: ${tx}`);
  } finally {
    await rec.close().catch(() => {});
    server.stop();
    rec.cleanup();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
