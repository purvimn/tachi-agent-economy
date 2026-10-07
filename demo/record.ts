// Records the silent 30-second preview: docs/demo-preview.mp4.
//   npm run record
// Makes one real ~50-sat payment from the treasury. See demo/recording.ts for requirements.
import path from "node:path";
import { Recorder, startServer, wait } from "./recording.js";

const OUTPUT = path.resolve("docs/demo-preview.mp4");

async function main() {
  const server = await startServer(Number(process.env.RECORD_PORT || 4410));
  const rec = new Recorder();
  try {
    const page = await rec.open(server.base);
    await rec.card(page, `<h1>Tachi Agent Economy</h1><p><i></i>AI agents that hire each other and pay in bitcoin, settled on Tachi.</p>`);
    await wait(800);
    await rec.capture(page);
    await wait(3400);
    await rec.card(page, null);
    await rec.show(page, "Every agent is a Nostr key. Start by adding a few.", 2400);

    await page.getByRole("button", { name: "Add demo agents" }).click();
    await rec.caption(page, "Five agents buy data, inference and coffee from each other over <b>x402</b>.");
    await page.getByText("Demo agents added.").waitFor({ timeout: 30_000 });
    await wait(1200);
    await page.evaluate(() => window.scrollTo({ top: 330, behavior: "smooth" }));
    await wait(3400);

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await wait(700);
    await page.getByRole("button", { name: "Make a real payment" }).click();
    await rec.caption(page, "Now a real one: TreasuryBot pays 50 sats with a transfer it signs itself.");
    await page.getByText("Server is verifying the payment on chain").waitFor({ timeout: 90_000 });
    await rec.caption(page, "The server checks the payment <b>on chain</b> before it serves the data.");
    await page.getByText("Payment settled and verified.").waitFor({ timeout: 90_000 });
    const tx = await page.getByRole("link", { name: "View the transaction" }).getAttribute("href");
    await wait(2200);
    await page.getByRole("button", { name: "Run 25 paid requests" }).click();
    await rec.caption(page, "High frequency: <b>25 paid requests at once</b>, each a real Tachi transfer.");
    await page.getByText(/paid requests served/).waitFor({ timeout: 180_000 });
    await wait(2500);
    await page.evaluate(() => window.scrollTo({ top: 420, behavior: "smooth" }));
    await rec.show(page, "<b>Orange</b> lines settled on Tachi. Dashed ones were simulated.", 3000);

    await rec.cut();
    const ex = page; // same tab, see Recorder.capture
    await ex.goto(tx!, { waitUntil: "domcontentloaded" });
    await ex.getByText("Confirmed").first().waitFor({ timeout: 30_000 });
    await rec.prep(ex);
    await wait(600);
    await rec.capture(ex);
    await rec.show(ex, "And it's on the Tachi explorer: <b>confirmed</b>.", 3800);
    await rec.caption(ex, ""); // the closing card stands alone
    await rec.card(ex, `<h1>Agents that pay agents.</h1><p><i></i>Nostr identity, x402 payments, bitcoin settlement on Tachi.</p><p style="margin-top:36px"><code>npm run server</code> → open localhost:4402</p>`);
    await wait(3400);
    await rec.close();

    const out = rec.encode(OUTPUT, { fitSeconds: 30 });
    console.log(`Wrote ${OUTPUT} (30s, recorded ${out.recorded.toFixed(1)}s). Payment: ${tx}`);
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
