// Captures submission screenshots into docs/screenshots/ (1440×900 at 2x).
//   npm run screenshots
// Runs every dashboard action against a fresh server: real Tachi payments (~1,000 sats spent, plus
// a vault deposit that stays in the vault)
// and public Nostr relay traffic. Needs Google Chrome.
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { startServer, wait } from "./recording.js";

const DIR = path.resolve("docs/screenshots");

async function shot(page: Page, name: string, target?: ReturnType<Page["locator"]>, offset = 80) {
  if (target) {
    await target.first().evaluate((el, offset) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset }), offset);
  } else {
    await page.evaluate(() => window.scrollTo({ top: 0 }));
  }
  await wait(600);
  await page.screenshot({ path: path.join(DIR, name) });
  console.log(`  ${name}`);
}

/** Clicks a run-panel button and waits for the action's result line. */
async function act(page: Page, button: string, done: string | RegExp, timeout = 120_000) {
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: button }).click();
  await page.getByText(done).first().waitFor({ timeout });
  await wait(3500); // let the dashboard's poll catch up
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const server = await startServer(Number(process.env.RECORD_PORT || 4410));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
    await page.goto(server.base);
    await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 30_000 });
    const heading = (name: string) => page.getByRole("heading", { name, exact: true });

    await act(page, "Add demo agents", "Demo agents added.");
    await act(page, "Find a seller on Nostr", "Found DataVendor on Nostr");
    await shot(page, "04-nostr-discovery-and-private-messages.png");

    await page.getByRole("button", { name: "Make a real payment" }).click();
    await page.getByText(/Paying \d+ sats on Tachi/).waitFor({ timeout: 90_000 });
    await shot(page, "03-real-payment-in-progress.png");
    await page.getByText("Payment settled and verified.").waitFor({ timeout: 90_000 });
    await wait(3500);

    await act(page, "Buy a dataset", "Dataset bought and verified.");
    await shot(page, "05-dataset-sealed-delivery.png");
    await act(page, "Anchor the log on Tachi", /Anchored \d+ events/);
    await act(page, "Run 25 paid requests", /paid requests served/, 180_000);

    await shot(page, "01-high-frequency-payments.png");
    await shot(page, "02-payment-graph.png", page.getByRole("img", { name: "Payments between agents" }), 60);
    await act(page, "Deposit and withdraw", /Deposited [\d,]+ sats into the vault/);
    await act(page, "Lend to an agent", /ResearchBot borrowed/, 180_000);
    await shot(page, "11-agent-loan-repaid.png", page.getByText(/ResearchBot borrowed/), 640);
    await shot(page, "12-yield-vault.png", heading("Yield vault"));
    await page.getByRole("button", { name: "DataVendor", exact: true }).click();
    await page.getByText(/signed events verify against this key/).waitFor({ timeout: 15_000 });
    await shot(page, "06-agent-inspector.png", heading("Agents"));
    await shot(page, "07-offers-on-nostr.png", heading("On Nostr"));
    await shot(page, "08-dataset-marketplace.png", heading("For sale"));
    await page.getByText(/Show all \d+ events/).click();
    await shot(page, "09-audit-log-anchored.png", heading("Signed events"));

    const anchorTx = await page.locator("li a[href*='/tx/']").first().getAttribute("href");
    await page.goto(anchorTx!, { waitUntil: "domcontentloaded" });
    await page.getByText("Confirmed").first().waitFor({ timeout: 30_000 });
    await wait(1500);
    await shot(page, "10-explorer-confirmed.png");
    console.log(`Saved to ${DIR}.`);
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
