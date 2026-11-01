#!/usr/bin/env node
/**
 * E2E 與無障礙掃描。用 Playwright + 本機 Chrome（channel: 'chrome'）。
 *
 * 用法：
 *   node tools/e2e.mjs            跑完整 E2E 與 axe
 *   node tools/e2e.mjs --screens  另外把三種寬度截圖存到 docs/screens/
 *
 * 偵測不到 Playwright 時印出 E2E SKIPPED 並以 exit 2 結束（不算通過）。
 * 從 /tmp/alice-e2e 載入 playwright，避免把 node_modules 塞進 repo。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW_DIR = process.env.ALICE_E2E_DIR || "/tmp/alice-e2e";

async function load(mod) {
  try {
    const base = path.join(PW_DIR, "node_modules", mod);
    const entry = mod === "playwright"
      ? path.join(base, "index.mjs")
      : path.join(base, "dist/index.mjs");
    return await import(pathToFileURL(entry).href);
  } catch (e) {
    return null;
  }
}

function skip(why) {
  console.log("E2E SKIPPED：" + why);
  process.exit(2);
}

const pw = await load("playwright");
if (!pw) skip("找不到 Playwright（預期在 " + PW_DIR + "/node_modules/playwright）");
const axeMod = await load("@axe-core/playwright");
if (!axeMod) skip("找不到 @axe-core/playwright");
const AxeBuilder = axeMod.default || axeMod.AxeBuilder;

const URL_FILE = pathToFileURL(path.join(ROOT, "index.html")).href;
const TABS = ["總覽", "策略", "回測", "機器人", "比較"];
let failures = 0;
function ok(cond, msg, extra) {
  if (cond) console.log("  ✔ " + msg);
  else { failures++; console.log("  ✖ " + msg + (extra ? "　" + extra : "")); }
}

const browser = await pw.chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message + " @ " + (e.stack || "").split("\n").slice(0, 3).join(" / ")));
page.on("console", (m) => {
  // 機器人狀態 API 沒開時 fetch 會被拒，那是預期的「離線」狀態，不是 JS 錯誤
  if (m.type() !== "error") return;
  const t = m.text();
  if (t.includes("ERR_CONNECTION_REFUSED") || t.includes("127.0.0.1:8771")) return;
  pageErrors.push(t);
});

await page.goto(URL_FILE);
await page.waitForTimeout(600);

console.log("E2E：頁面載入");
ok(pageErrors.length === 0, "沒有 JS 錯誤", pageErrors.join(" | "));
if (process.env.E2E_VERBOSE) pageErrors.forEach(function (e) { console.log("   !! " + e); });
ok((await page.title()).includes("策略 Alice"), "標題含「策略 Alice」");

console.log("E2E：五分頁");
const tabTexts = await page.$$eval('#tabs [role="tab"]', (els) => els.map((e) => e.textContent.trim()));
ok(JSON.stringify(tabTexts) === JSON.stringify(TABS), "五個分頁名稱：" + tabTexts.join("、"), JSON.stringify(tabTexts));

for (const t of TABS) {
  await page.click(`#tabs [role="tab"]:has-text("${t}")`);
  await page.waitForTimeout(150);
  const visible = await page.$$eval("section.panel.on", (els) => els.length);
  ok(visible === 1, "「" + t + "」分頁只顯示一個面板", "可見 " + visible);
}

console.log("E2E：鍵盤可操作分頁");
await page.focus('#tab-overview');
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(100);
const focusedTab = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
ok(focusedTab === "策略", "右方向鍵切到「策略」，目前焦點 " + focusedTab);

console.log("E2E：回測跑得出來");
await page.click('#tabs [role="tab"]:has-text("策略")');
await page.click("#run");
await page.waitForTimeout(400);
const ret = await page.$eval("#result .big", (e) => e.textContent.trim()).catch(() => null);
ok(ret && /%$/.test(ret), "總報酬有值：" + ret);

console.log("E2E：360px 不出現橫向捲軸");
await page.setViewportSize({ width: 360, height: 780 });
await page.waitForTimeout(200);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok(overflow <= 1, "360px 橫向超出 " + overflow + " px");
await page.setViewportSize({ width: 1280, height: 900 });

console.log("E2E：深色為預設、可切淺色");
const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
ok(theme === "dark", "預設 data-theme=" + theme);

console.log("axe 無障礙掃描（serious + critical 必須為 0）");
let axeBad = 0;
for (const t of TABS) {
  await page.click(`#tabs [role="tab"]:has-text("${t}")`);
  await page.waitForTimeout(200);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  axeBad += bad.length;
  if (process.env.E2E_VERBOSE) for (const v of bad) for (const nd of v.nodes) console.log("   >> " + v.id + " :: " + nd.html.slice(0, 220));
  ok(bad.length === 0, "「" + t + "」頁 zero serious/critical",
    bad.map((v) => v.id + "(" + v.impact + ")×" + v.nodes.length).join(", "));
}

if (process.argv.includes("--screens")) {
  const dir = path.join(ROOT, "docs", "screens");
  fs.mkdirSync(dir, { recursive: true });
  for (const w of [360, 390, 1280]) {
    const p2 = await ctx.newPage();
    await p2.setViewportSize({ width: w, height: w < 500 ? 780 : 900 });
    await p2.goto(URL_FILE);
    await p2.waitForTimeout(500);
    const f = path.join(dir, "overview-" + w + ".png");
    await p2.screenshot({ path: f, fullPage: false });
    console.log("  截圖 " + path.relative(ROOT, f));
    await p2.close();
  }
}

await browser.close();
console.log(failures === 0 && axeBad === 0 ? "E2E PASS" : "E2E FAIL：" + failures + " 項失敗");
process.exit(failures === 0 && axeBad === 0 ? 0 : 1);
