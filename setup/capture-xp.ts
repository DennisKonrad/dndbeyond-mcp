/**
 * Capture D&D Beyond write requests via a real headed Chrome (untracked dev tool).
 *
 * Opens the character sheet (saved auth) and logs every WRITE request to
 * character-service (url/method/body/response). Edit something in the browser;
 * the requests are captured and written to setup/captured-xp.json.
 *
 *   npx tsx setup/capture-xp.ts            # default: Krakzinn's sheet
 *   CAPTURE_CHAR_ID=123 npx tsx setup/capture-xp.ts
 *
 * NixOS: provide a real Chromium via
 *   nix-shell -p chromium --run 'DNDBEYOND_MCP_BROWSER_PATH="$(command -v chromium)" npx tsx setup/capture-xp.ts'
 *
 * Exit: close the browser OR press Ctrl+C — both finalize cleanly. Captured data
 * is also flushed to disk after every request, so nothing is lost even if the
 * process is killed.
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

  const flush = () => { try { writeFileSync(OUTPUT_PATH, JSON.stringify(captured, null, 2)); } catch { /* ignore */ } };

  // Idempotent shutdown: print the write summary, persist, close, exit. Triggered
  // by ANY of several signals — browser "disconnected" alone is unreliable under
  // some launchers (e.g. nix-shell-wrapped Chromium), which left the old version
  // hanging with no output.
  let done = false;
  const finish = (reason: string) => {
    if (done) return;
    done = true;
    flush();
    const writes = captured;
    console.log(`\n=== ${writes.length} write request(s) erfasst -> ${OUTPUT_PATH} (${reason}) ===`);
    for (const r of writes) {
      console.log(`\n${r.method} ${new URL(r.url).pathname}`);
      console.log(`  body:     ${JSON.stringify(r.body)}`);
      console.log(`  status:   ${r.status}`);
      console.log(`  response: ${r.response}`);
    }
    browser.close().catch(() => {});
    process.exit(0);
  };

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("character-service.dndbeyond.com")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method())) return;
    let body: unknown = null;
    try { body = JSON.parse(req.postData() || "null"); } catch { body = req.postData(); }
    captured.push({ timestamp: new Date().toISOString(), method: req.method(), url, body, status: null, response: null });
    flush();
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
    flush();
    console.log(`<< ${res.status()} ${url}`);
  });

  await page.goto(SHEET_URL, { waitUntil: "domcontentloaded" });
  console.error(`\n--- Chrome offen auf ${SHEET_URL}. Mach deine Aenderung, dann Browser schliessen ODER Ctrl+C. ---\n`);

  // Multiple exit triggers so we never hang waiting on a single unreliable event.
  browser.on("disconnected", () => finish("browser disconnected"));
  context.on("close", () => finish("context closed"));
  page.on("close", () => finish("page closed"));
  process.on("SIGINT", () => finish("SIGINT"));
  process.on("SIGTERM", () => finish("SIGTERM"));

  // Park forever; finish() (via a trigger above) is what ends the process.
  await new Promise<void>(() => { /* until a trigger fires */ });
}
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
