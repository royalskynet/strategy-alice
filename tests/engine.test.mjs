/** 回歸：A–C 段已驗收的數字，搬家到引擎後一位都不能變。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine, loadDemoBars, DEFAULT_CFG, demoClock } from "./helpers.mjs";

const E = loadEngine();
const { bars, startMs } = loadDemoBars();
const clock = demoClock(startMs);
const run = (over) => E.backtestOn(bars, { ...DEFAULT_CFG, ...over }, clock);

test("預設參數：4 筆、3 勝、總損益 56.9255、總報酬 5.6926%、最大回撤 0.0422", () => {
  const r = run({});
  assert.equal(r.n, 4);
  assert.equal(r.wins, 3);
  assert.ok(Math.abs(r.totalPnl - 56.9255) < 1e-4, "totalPnl=" + r.totalPnl);
  assert.ok(Math.abs(r.totalRet - 5.6926) < 1e-4, "totalRet=" + r.totalRet);
  assert.ok(Math.abs(r.mdd - 0.0422) < 1e-4, "mdd=" + r.mdd);
  assert.equal(r.winRate, 75);
});

test("逐筆損益與出場原因", () => {
  const r = run({});
  assert.deepEqual(r.trades.map((t) => t.pnl.toFixed(4)), ["6.2928", "-0.0422", "10.6749", "40.0000"]);
  assert.deepEqual(r.trades.map((t) => t.why), ["均線下穿", "均線下穿", "均線下穿", "停利"]);
});

test("成本：手續費 0.10%、滑價 0.05% 時淨報酬 4.4871%、成本 12.0000", () => {
  const r = run({ fee: 0.1, slip: 0.05 });
  assert.ok(Math.abs(r.netRet - 4.4871) < 1e-4, "netRet=" + r.netRet);
  assert.ok(Math.abs(r.cost - 12) < 1e-9, "cost=" + r.cost);
});

test("移動停損：啟動 2%、回撤 1% 時有 3 筆移動停損出場", () => {
  const r = run({ trail: true, trailStart: 2, trailDist: 1 });
  const n = r.trades.filter((t) => t.why === "移動停損").length;
  assert.equal(n, 3, "移動停損筆數=" + n + " 全部原因=" + r.trades.map((t) => t.why).join(","));
});

test("前視偏誤：{ok:true, diff:0}", () => {
  const c = E.lookaheadCheck(bars, DEFAULT_CFG, clock);
  assert.equal(c.ok, true);
  assert.equal(c.diff, 0);
});

test("4h 模式可跑且交易數少於 1h", () => {
  const a = run({});
  const b = run({ tf: "4h" });
  assert.ok(b.n <= a.n, "4h 筆數 " + b.n + " 應 ≤ 1h " + a.n);
});

test("空資料不炸", () => {
  const r = E.backtestOn([], DEFAULT_CFG, clock);
  assert.equal(r.n, 0);
  assert.equal(r.totalPnl, 0);
});

test("期金分解：按日與按月的總和等於總損益", () => {
  const r = run({});
  const day = E.periodBreakdown(r.trades, "day", clock);
  const mon = E.periodBreakdown(r.trades, "month", clock);
  const sum = (a) => a.reduce((x, y) => x + y.pnl, 0);
  assert.ok(Math.abs(sum(day) - r.totalPnl) < 1e-9);
  assert.ok(Math.abs(sum(mon) - r.totalPnl) < 1e-9);
});
