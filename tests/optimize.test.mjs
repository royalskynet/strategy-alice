/** M2：參數最佳化 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine, loadDemoBars, DEFAULT_CFG, demoClock } from "./helpers.mjs";

const E = loadEngine();
const { bars, startMs } = loadDemoBars();
const clock = demoClock(startMs);

function run(rangeA, rangeB, obj) {
  return E.optimizeOn(bars, DEFAULT_CFG, rangeA, rangeB, "fast", "slow", obj || "totalRet", clock);
}

test("組合數上限 400：超出要擋並附逐字訊息", () => {
  const r = run({ from: 5, to: 30, step: 1 }, { from: 40, to: 70, step: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "參數組合數 806 超過上限 400，請把範圍縮小或步長加大");
});

test("剛好 400 組要放行", () => {
  const r = run({ from: 5, to: 24, step: 1 }, { from: 40, to: 59, step: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.cells.length, 400);
});

test("固定資料下最佳格固定（同一組輸入跑兩次結果相同）", () => {
  const a = run({ from: 10, to: 25, step: 5 }, { from: 40, to: 70, step: 10 });
  const b = run({ from: 10, to: 25, step: 5 }, { from: 40, to: 70, step: 10 });
  assert.deepEqual(a.best, b.best);
  assert.ok(a.best, "要有最佳格");
  assert.ok(Number.isFinite(a.best.inScore), "最佳格分數要有限");
});

test("樣本內取前 70%、樣本外取後 30%", () => {
  const r = run({ from: 10, to: 20, step: 10 }, { from: 40, to: 60, step: 10 });
  assert.equal(r.cut, Math.floor(bars.length * 0.7));
});

test("目標函數：總報酬／夏普／卡瑪／報酬÷回撤都可選", () => {
  for (const obj of ["totalRet", "sharpe", "calmar", "retdd"]) {
    const r = run({ from: 10, to: 20, step: 10 }, { from: 40, to: 60, step: 10 }, obj);
    assert.equal(r.ok, true, obj);
    assert.ok(r.best, obj + " 要有最佳格");
  }
});

test("gridCombos 支援遞減範圍", () => {
  const g = E.gridCombos({ from: 3, to: 1, step: 1 }, { from: 1, to: 2, step: 1 });
  assert.deepEqual(g.a, [3, 2, 1]);
  assert.deepEqual(g.b, [1, 2]);
  assert.equal(g.count, 6);
});

test("非法參數（慢線不快）的格子標 skip 而不是丟例外", () => {
  // fast 30~60、slow 40~50：很多格 slow ≤ fast
  const r = run({ from: 30, to: 60, step: 10 }, { from: 40, to: 50, step: 10 });
  assert.equal(r.ok, true);
  const skipped = r.cells.filter((c) => c.skip).length;
  assert.ok(skipped > 0, "應有被跳過的格");
  assert.ok(r.cells.some((c) => !c.skip), "也應有合法的格");
});
