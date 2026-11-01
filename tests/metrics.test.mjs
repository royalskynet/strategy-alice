/** M1：專業回測報告指標。用 4 筆示範交易手算，寫成固定值斷言。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine, loadDemoBars, DEFAULT_CFG, demoClock } from "./helpers.mjs";

const E = loadEngine();
const { bars, startMs } = loadDemoBars();
const clock = demoClock(startMs);
const close = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;

function rep(over) {
  return E.reportOn(bars, { ...DEFAULT_CFG, ...over }, clock);
}

test("四筆示範交易的逐筆損益（M1 指標的計算基礎）", () => {
  const { result } = rep({});
  assert.deepEqual(result.trades.map((t) => t.pnl.toFixed(4)),
    ["6.2928", "-0.0422", "10.6749", "40.0000"]);
});

test("期望值＝總損益 ÷ 筆數＝14.2314", () => {
  const { metrics } = rep({});
  assert.ok(close(metrics.expectancy, 14.2314), "expectancy=" + metrics.expectancy);
});

test("平均賺 18.9892、平均賠 0.0422、賺賠比 449.7085", () => {
  const { metrics } = rep({});
  assert.ok(close(metrics.avgWin, 18.9892), "avgWin=" + metrics.avgWin);
  assert.ok(close(metrics.avgLoss, 0.0422), "avgLoss=" + metrics.avgLoss);
  assert.ok(close(metrics.winLossRatio, 449.7085, 1e-3), "ratio=" + metrics.winLossRatio);
});

test("最長連贏 2、最長連虧 1", () => {
  const { metrics } = rep({});
  assert.equal(metrics.maxWinStreak, 2);
  assert.equal(metrics.maxLossStreak, 1);
});

test("持倉時間占比 219/500＝43.8%", () => {
  const { metrics } = rep({});
  assert.ok(close(metrics.timeInMarket, 43.8), "tim=" + metrics.timeInMarket);
});

test("最大回撤百分比＝0.0422 ÷ 10000 × 100＝0.000422%", () => {
  const { result, metrics } = rep({ equity: 10000 });
  assert.ok(close(result.mddPct, 0.000422, 1e-7), "mddPct=" + result.mddPct);
  assert.ok(close(metrics.mddPct, 0.000422, 1e-7), "metric mddPct=" + metrics.mddPct);
});

test("夏普 15.2876、索提諾 26.5800、年化 163.7895%", () => {
  const { metrics } = rep({});
  assert.ok(close(metrics.sharpe, 15.2876, 1e-3), "sharpe=" + metrics.sharpe);
  assert.ok(close(metrics.sortino, 26.58, 1e-3), "sortino=" + metrics.sortino);
  assert.ok(close(metrics.annualPct, 163.7895, 1e-2), "annual=" + metrics.annualPct);
});

test("買進持有 12.9748%，策略減買進持有 −7.2823%", () => {
  const { metrics } = rep({});
  assert.ok(close(metrics.buyHoldPct, 12.9748), "bh=" + metrics.buyHoldPct);
  assert.ok(close(metrics.excessPct, -7.2823), "ex=" + metrics.excessPct);
});

test("邊界：零交易時各指標不炸且為 null 或 0", () => {
  const empty = E.backtestOn([], DEFAULT_CFG, clock);
  const m = E.metricsOn(empty, { cfg: DEFAULT_CFG });
  assert.equal(m.expectancy, null);
  assert.equal(m.avgWin, null);
  assert.equal(m.avgLoss, null);
  assert.equal(m.winLossRatio, null);
  assert.equal(m.sharpe, null);
  assert.equal(m.buyHoldPct, null);
  assert.equal(m.excessPct, null);
});

test("邊界：全部獲利時最長連虧 0、平均賠為 null、獲利因子無限", () => {
  const onlyWins = {
    bars, curve: [{ i: 0, eq: 1000 }],
    trades: [{ pnl: 10 }, { pnl: 20 }, { pnl: 30 }, { pnl: 5 }],
    totalPnl: 65, n: 4, wins: 4
  };
  const m = E.metricsOn(onlyWins, { cfg: { ...DEFAULT_CFG, equity: 1000 } });
  assert.equal(m.maxLossStreak, 0);
  assert.equal(m.maxWinStreak, 4);
  assert.equal(m.avgLoss, null);
  assert.equal(m.winLossRatio, null);
  assert.ok(close(m.avgWin, 16.25), "avgWin=" + m.avgWin);
});

test("回撤曲線每一點都 ≤ 0，且最後一點等於 −最大回撤（單次回撤的示範資料）", () => {
  const { metrics } = rep({});
  assert.ok(metrics.ddCurve.every((p) => p.dd <= 1e-12), "回撤應為非正值");
  const min = Math.min(...metrics.ddCurve.map((p) => p.dd));
  assert.ok(close(min, -metrics.mddPct, 1e-6), "曲線最低 " + min + " vs " + -metrics.mddPct);
});
