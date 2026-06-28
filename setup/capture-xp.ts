/**
 * Capture the D&D Beyond XP-save request (untracked dev tool).
 *
 * Opens the character sheet in a real Chrome (saved auth), logs every WRITE
 * request to character-service. You edit the XP value in the browser and save;
 * the request (URL + method + body + response) is captured. Close the browser
 * when done — the XP-relevant writes are printed and saved to setup/captured-xp.json.
 *
 *   npx tsx setup/capture-xp.ts            # default: Krakzinn's sheet
 *   CAPTURE_CHAR_ID=123 npx tsx setup/capture-xp.ts
 */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

const CONFIG_PATH = `${process.env.HOME}/.dndbeyond-mcp/config.json`;
const CHAR_ID = process.env.CAPTURE_CHAR_ID ?? "167132826"; // Krakzinn
const SHEET_URL = `https://www.dndbeyond.com/characters/${CHAR_ID}`;
const OUTPUT_PATH = "setup/captured-xp.json";

interface Cap { timestamp: string; method: string; url: string; body: unknown; status: number | null; response: string | null; }

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  const cookies = config.cookies;
  if (!cookies?.length) { console.error("No cookies — run `npm run setup` first."); process.exit(1); }

  const browserPath = process.env.DNDBEYOND_MCP_BROWSER_PATH;
  const browser = await chromium.launch({
    headless: false,
    // No path set -> use Playwright's bundled Chromium (no system Chrome here).
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: ["--disable-blink-features=AutomationControlled", "--disable-infobars", "--no-first-run"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext();
  await context.addCookies(cookies.map((c: { name: string; value: string }) => ({
    name: c.name, value: c.value, domain: ".dndbeyond.com", path: "/",
  })));
  const page = await context.newPage();
  const captured: Cap[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("character-service.dndbeyond.com")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method())) return;
    let body: unknown = null;
    try { body = JSON.parse(req.postData() || "null"); } catch { body = req.postData(); }
    captured.push({ timestamp: new Date().toISOString(), method: req.method(), url, body, status: null, response: null });
    console.log(`>> ${req.method()} ${url} body=${JSON.stringify(body)}`);
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("character-service.dndbeyond.com")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(res.request().method())) return;
    const e = [...captured].reverse().find((x) => x.url === url && x.method === res.request().method() && x.status === null);
    if (!e) return;
    e.status = res.status();
    try { const t = await res.text(); e.response = t.slice(0, 400); } catch { e.response = "(unreadable)"; }
    console.log(`<< ${res.status()} ${url}`);
  });

  await page.goto(SHEET_URL, { waitUntil: "domcontentloaded" });
  console.error(`\n--- Chrome offen auf ${SHEET_URL}. Aendere die XP und speichere. Dann Browser schliessen. ---\n`);

  await new Promise<void>((resolve) => browser.on("disconnected", () => resolve()));

  writeFileSync(OUTPUT_PATH, JSON.stringify(captured, null, 2));
  console.log(`\n=== ${captured.length} write request(s) erfasst -> ${OUTPUT_PATH} ===`);
  for (const r of captured) {
    console.log(`\n${r.method} ${new URL(r.url).pathname}`);
    console.log(`  body:     ${JSON.stringify(r.body)}`);
    console.log(`  status:   ${r.status}`);
    console.log(`  response: ${r.response}`);
  }
}
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
