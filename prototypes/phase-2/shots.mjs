import { chromium } from "playwright";
const [file, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" });
async function shot(name, hash, { dark = false, w = 1280, h = 860, click = [], full = false } = {}) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: dark ? "dark" : "light" });
  await p.goto("file://" + file + "#" + hash); await p.waitForTimeout(600);
  for (const c of click) { await p.click(c); await p.waitForTimeout(150); }
  await p.addStyleTag({ content: ".proto-bar,.switcher,.variant-note,.proto-sim{display:none!important} body{padding-bottom:0!important} .frame{min-height:100vh}" });
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  await p.close();
}
await shot("suggestion", "inbox-a");
await shot("suggestion-side-by-side", "inbox-a", { click: ['[data-diffview="sxs"]'] });
await shot("suggestion-merge", "inbox-a", { click: ['[data-outdated="1"]', '[data-merging="1"]'], full: true });
await shot("reopen", "reopen-a");
await shot("triage", "triage-a");
await shot("terms", "terms-a", { full: true });
await shot("term", "terms-b");
await shot("decisions", "decisions-a", { full: true });
await shot("artifact", "artifact-a");
await shot("ticket-attachments", "ticket-a", { full: true });
await shot("terms-dark", "terms-a", { dark: true });
await b.close();
