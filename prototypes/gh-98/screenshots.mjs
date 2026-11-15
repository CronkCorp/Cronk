import { chromium } from "/home/christiaan/orca/workspaces/Cronk/gh-98-review-the-phase-1-ui-and-set-a-design-d/node_modules/playwright/index.mjs";
const out = process.argv[2];
const b = await chromium.launch();
const f = "file://" + process.cwd() + "/proto/cronk-ui.html";
async function shot(name, hash, { dark = false, w = 1280, h = 860, mode, full = false } = {}) {
  const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: dark ? "dark" : "light" });
  await p.goto(f + "#" + hash); await p.waitForTimeout(300);
  if (mode) { await p.click(`[data-mode="${mode}"]`); await p.waitForTimeout(100); }
  await p.addStyleTag({ content: ".proto-bar,.switcher,.variant-note{display:none!important} body{padding-bottom:0!important} .frame{min-height:100vh}" });
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: full });
  await p.close();
}
await shot("frame", "frame-a");
await shot("inbox", "inbox-a");
await shot("ticket", "ticket-a", { full: true });
await shot("ticket-dark", "ticket-a", { dark: true });
await shot("document-read", "document-a");
await shot("document-edit", "document-a", { mode: "edit" });
await shot("document-merge", "document-a", { mode: "merge" });
await shot("agents", "agents-a");
await shot("tokens-light", "tokens-a", { full: true });
await shot("tokens-dark", "tokens-a", { dark: true, full: true });
await shot("phone-inbox", "inbox-a", { w: 400, h: 860 });
await b.close();
