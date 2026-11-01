/** 標準答案比對：fixtures/btc4h-regime-20261101.json
 *  來源：M4 btc_watch.py parse()+evaluate()
 *
 * 公式（見 優化執行方案-業界成熟度.md §7.1）：
 *   volbase     = 前 120 根（不含當根）的量中位數
 *   ret48       = 收盤 ÷ 11 根前開盤 − 1
 *   pos30       = (收盤 − 180 根最低) ÷ (180 根最高 − 180 根最低)
 *   maxx48      = 48h 內最大量倍數（v ÷ volbase）
 *   width72     = (18 根最高 − 18 根最低) ÷ 現價
 *   bars_since_hi = 72h 高點到當根的根數，同價取第一根
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadEngine, ROOT_DIR } from "./helpers.mjs";

const E = loadEngine();
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "fixtures/btc4h-regime-20261101.json"), "utf8"));
const BARS = E.toBars(FIX.klines_raw);
const IDX = new Map(BARS.map((b, i) => [b[0], i]));

const FLAG_KEYS = ["spike", "stall_reverse", "range_high", "uptrend"];
const TOL = 1e-6;

function prefixFor(exp) {
  const i = IDX.get(exp.last_open_ms);
  assert.ok(i !== undefined, "找不到時戳 " + exp.last_open_ms);
  return BARS.slice(0, i + 1);
}

test("fixture 載入：1000 根 K 線、821 筆標準答案、5 筆合成", () => {
  assert.equal(FIX.klines_raw.length, 1000);
  assert.equal(FIX.expected.length, 821);
  assert.equal(BARS.length, 1000, "量為 0 的 K 線會被丟掉，這份 fixture 宣稱沒有");
  assert.equal(FIX.synthetic.length, 5);
});

test("四旗標逐筆相等（821/821）", () => {
  const bad = [];
  for (const exp of FIX.expected) {
    const r = E.evaluateRegime(prefixFor(exp));
    if (!r.ok) { bad.push({ ms: exp.last_open_ms, why: r.reason }); continue; }
    FLAG_KEYS.forEach((k, j) => {
      if (r.flags[j].on !== exp.flags[k]) {
        bad.push({ ms: exp.last_open_ms, flag: k, got: r.flags[j].on, want: exp.flags[k] });
      }
    });
  }
  assert.equal(bad.length, 0,
    "旗標不一致 " + bad.length + " 筆，前三筆：" + JSON.stringify(bad.slice(0, 3)));
  console.log("旗標：821/821 一致");
});

test("五個欄位誤差 < 1e-6（821/821）", () => {
  const fields = ["width72", "ret48", "pos30", "volbase", "maxx48"];
  const bad = [];
  for (const exp of FIX.expected) {
    const r = E.evaluateRegime(prefixFor(exp));
    for (const f of fields) {
      const got = r[f], want = exp[f];
      if (got === null || want === null || Math.abs(got - want) > TOL) {
        bad.push({ ms: exp.last_open_ms, f, got, want });
      }
    }
  }
  assert.equal(bad.length, 0,
    "欄位不一致 " + bad.length + " 筆，前五筆：" + JSON.stringify(bad.slice(0, 5)));
  console.log("欄位：821/821 一致（" + fields.join("、") + "）");
});

test("bars_since_hi 逐筆相等（821/821）", () => {
  const bad = [];
  for (const exp of FIX.expected) {
    const r = E.evaluateRegime(prefixFor(exp));
    if (r.barsSinceHi !== exp.bars_since_hi) {
      bad.push({ ms: exp.last_open_ms, got: r.barsSinceHi, want: exp.bars_since_hi });
    }
  }
  assert.equal(bad.length, 0,
    "bars_since_hi 不一致 " + bad.length + " 筆，前三筆：" + JSON.stringify(bad.slice(0, 3)));
});

/** synthetic 的 bars 是已解析物件（t 秒、net），要轉成引擎的緊湊陣列 */
function syntheticToBars(s) {
  return s.bars.map((b) => {
    const v = b.v;
    const tb = v > 0 ? (b.net + 1) / 2 * v : 0;
    return [b.t * 1000, b.o, b.h, b.l, b.c, v, tb];
  });
}

test("五個合成案例的四旗標都相等（5/5）", () => {
  const bad = [];
  for (const s of FIX.synthetic) {
    const bars = syntheticToBars(s);
    const r = E.evaluateRegime(bars);
    if (s.name === "short179") {
      if (r.ok !== false) bad.push({ name: s.name, why: "應回傳資料不足，實際 ok=" + r.ok });
      continue;
    }
    if (!r.ok) { bad.push({ name: s.name, why: r.reason }); continue; }
    FLAG_KEYS.forEach((k, j) => {
      if (r.flags[j].on !== s.flags[k]) {
        bad.push({ name: s.name, flag: k, got: r.flags[j].on, want: s.flags[k] });
      }
    });
  }
  assert.equal(bad.length, 0, "合成案例不一致：" + JSON.stringify(bad));
  console.log("合成：5/5 一致（" + FIX.synthetic.map((s) => s.name).join("、") + "）");
});
