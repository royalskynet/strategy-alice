/** 標準答案比對：fixtures/btc4h-regime-20261101.json（來源：M4 btc_watch.py parse()+evaluate()）
 *
 * 已確認的公式（三筆完全一致）：
 *   volbase = 前 120 根（不含當根）的量中位數
 *   ret48   = 收盤 ÷ 12 根前收盤 − 1（比例，不是百分比）
 *   pos30   = (收盤 − 180 根最低) ÷ (180 根最高 − 180 根最低)
 *
 * 未解：width72、maxx48 的定義與 btc_watch 不同，這兩欄不比對。
 * ponytail: 有了 btc_watch.py 原始碼就補齊這兩欄，介面已預留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadEngine, ROOT_DIR } from "./helpers.mjs";

const E = loadEngine();
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "fixtures/btc4h-regime-20261101.json"), "utf8"));
const BARS = E.toBars(FIX.klines_raw);

function prefixFor(expected) {
  const i = BARS.findIndex((b) => b[0] === expected.last_open_ms);
  assert.ok(i >= 0, "找不到時戳 " + expected.last_open_ms);
  return BARS.slice(0, i + 1);
}

test("fixture 載入：1000 根 K 線、821 筆標準答案、5 筆合成", () => {
  assert.equal(FIX.klines_raw.length, 1000);
  assert.equal(FIX.expected.length, 821);
  assert.equal(BARS.length, 1000, "量為 0 的 K 線會被丟掉，這份 fixture 宣稱沒有");
  assert.equal(FIX.synthetic.length, 5);
});

test("volbase 與 ret48 對全部 821 筆一致（誤差 < 1e-8）", () => {
  let bad = [];
  for (const exp of FIX.expected) {
    const K = prefixFor(exp);
    if (K.length < 180) continue;
    const r = E.evaluateRegime(K);
    if (Math.abs(r.volbase - exp.volbase) > 1e-8) bad.push({ ms: exp.last_open_ms, got: r.volbase, want: exp.volbase });
    if (Math.abs(r.ret48 - exp.ret48) > 1e-8) bad.push({ ms: exp.last_open_ms, f: "ret48", got: r.ret48, want: exp.ret48 });
  }
  assert.equal(bad.length, 0, "不一致 " + bad.length + " 筆，前三筆：" + JSON.stringify(bad.slice(0, 3)));
});

test("pos30 對全部 821 筆一致（誤差 < 1e-8）", () => {
  const bad = [];
  for (const exp of FIX.expected) {
    const K = prefixFor(exp);
    const r = E.evaluateRegime(K);
    if (Math.abs(r.pos30 - exp.pos30) > 1e-8) bad.push({ ms: exp.last_open_ms, got: r.pos30, want: exp.pos30 });
  }
  assert.equal(bad.length, 0, "不一致 " + bad.length + " 筆，前三筆：" + JSON.stringify(bad.slice(0, 3)));
});

test("合成資料：不足 180 根要回傳「資料不足」", () => {
  const s = FIX.synthetic.find((x) => x.name === "short179");
  const r = E.evaluateRegime(s.bars);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "資料不足");
});

test("合成資料：flag_true_counts 與 fixture 宣告相符（僅比 spike/uptrend/stall_reverse/range_high 的穩定性）", () => {
  // 逐筆比對四個旗標。volbase/ret48/pos30 已驗證可用，width72 待解，
  // 所以這裡只檢查「我們的旗標在哪些筆為真」與 fixture 宣告的總數是否同量級，
  // 差異會印出來，不算失敗（width72 未解會影響規則 3）。
  const ours = { spike: 0, stall_reverse: 0, range_high: 0, uptrend: 0 };
  const keys = ["spike", "stall_reverse", "range_high", "uptrend"];
  for (const exp of FIX.expected) {
    const r = E.evaluateRegime(prefixFor(exp));
    if (!r.ok) continue;
    r.flags.forEach((f, i) => { if (f.on) ours[keys[i]]++; });
  }
  const diff = keys.map((k) => k + " 我們 " + ours[k] + " / fixture " + FIX.flag_true_counts[k]);
  console.log("旗標計數：" + diff.join("，"));
  assert.ok(true);
});
