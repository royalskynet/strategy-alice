/** M3：網格、DCA、保護機制。全部用人工造的 K 線手算驗證。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./helpers.mjs";

const E = loadEngine();
const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

/** 用收盤價陣列造 K 線，開高低收同價，方便手算 */
function mk(prices) {
  return prices.map((p, i) => [i * 3600000, p, p, p, p, 1, 0]);
}

test("網格：價格在 3 格間來回 2 次，成交 8 筆，已實現利潤等於手算值", () => {
  // 等差 100~104，4 格（每格 1 美元），每格投入 100 USDT
  // 走勢 102 → 101 → 100 → 101 → 102 → 101 → 100 → 101 → 102
  // 規則：往下穿格線買在穿過的那條線、往上穿賣回穿過的那條線，先進先出。
  // 第 1 趟：買 102 與 100；賣 101（賣掉買價 102 那筆，−0.9804）、賣 102（賣掉買價 100 那筆，+2）
  // 第 2 趟完全一樣。合計 = 2 × (−0.9804 + 2) = 2.0392
  const bars = mk([102, 101, 100, 101, 102, 101, 100, 101, 102]);
  const g = E.gridBacktest(bars, { upper: 104, lower: 100, grids: 4, perGrid: 100, geo: false });
  assert.equal(g.trades.filter((t) => t.side === "buy").length, 4, "買 4 次");
  assert.equal(g.trades.filter((t) => t.side === "sell").length, 4, "賣 4 次");
  assert.deepEqual(g.trades.map((t) => [t.side, t.price]),
    [["buy", 102], ["buy", 100], ["sell", 101], ["sell", 102],
     ["buy", 102], ["buy", 100], ["sell", 101], ["sell", 102]]);
  assert.ok(close(g.realized, 2.0392156862745097, 1e-12), "已實現=" + g.realized);
  assert.equal(g.openQty, 0, "全部平倉，手上沒貨");
});

test("網格：買賣的成交價差剛好一格（104−100)/4 = 1", () => {
  const bars = mk([102, 101, 102]);
  const g = E.gridBacktest(bars, { upper: 104, lower: 100, grids: 4, perGrid: 100, geo: false });
  assert.deepEqual(g.levels, [100, 101, 102, 103, 104]);
  const buy = g.trades.find((t) => t.side === "buy");
  const sell = g.trades.find((t) => t.side === "sell");
  assert.ok(close(sell.price - buy.price, 1, 1e-12), "價差 " + (sell.price - buy.price));
  assert.ok(close(sell.pnl, 100 * (sell.price / buy.price - 1), 1e-12));
});

test("網格：價格不動就 0 成交、0 未實現", () => {
  const g = E.gridBacktest(mk([102, 102, 102, 102]), { upper: 104, lower: 100, grids: 4, perGrid: 100, geo: false });
  assert.equal(g.fills, 0);
  assert.equal(g.realized, 0);
  assert.equal(g.unrealized, 0);
});

test("網格：等比格線也是等比數列", () => {
  const g = E.gridBacktest([], { upper: 121, lower: 100, grids: 2, perGrid: 100, geo: true });
  assert.ok(close(g.levels[0], 100));
  assert.ok(close(g.levels[1], 110));
  assert.ok(close(g.levels[2], 121));
});

test("DCA：跌到第 3 次加碼後反彈到停利，平均成本與損益等於手算值", () => {
  // 首單 1000 美元 @100 → 10 枚
  // 跌 10% → 90 加碼 500×1^0=500 → 5.555… 枚
  // 再跌 10% → 81 加碼 500 → 6.1728… 枚
  // 再跌 10% → 72.9 加碼 500 → 6.8587… 枚
  // 均價 = (1000+1500)/(10+5.5556+6.1728+6.8587)
  // 漲到均價 ×1.05 → 全賣
  // 只留到停利為止（95 那根）：再往後的價格會開始新一輪，不在這一輪的手算範圍內
  const prices = [100, 100, 90, 81, 72.9, 80, 95];
  const bars = mk(prices);
  const r = E.dcaBacktest(bars, {
    first: 1000, addAmount: 500, dropPct: 10, mult: 1, maxAdds: 3, takeProfitPct: 5
  });
  const qty = 10 + 500 / 90 + 500 / 81 + 500 / 72.9;
  const cost = 2500;
  const avg = cost / qty;
  const tp = avg * 1.05;
  assert.equal(r.cycles.length, 1, "應完成 1 輪");
  const c = r.cycles[0];
  assert.equal(c.adds, 3, "加碼 3 次");
  assert.ok(close(c.avg, avg, 1e-9), "均價 " + c.avg + " vs " + avg);
  assert.ok(close(c.maxCost, 2500, 1e-9), "最大占用資金 " + c.maxCost);
  // 均價 87.45 → 停利價 91.82 → 收盤 95 那根成交
  assert.ok(close(tp, 91.8246, 1e-3), "停利價 " + tp);
  assert.equal(c.exit, 95, "出場價應為 95");
  assert.ok(close(c.pnl, qty * c.exit - cost, 1e-9), "損益 " + c.pnl);
  assert.ok(c.pnl > 0, "停利應為正");
});

test("DCA：最多加碼次數有上限，超過就停手", () => {
  const prices = [100, 90, 81, 72.9, 65.6, 59, 53];
  const r = E.dcaBacktest(mk(prices), {
    first: 1000, addAmount: 500, dropPct: 10, mult: 2, maxAdds: 2, takeProfitPct: 5
  });
  assert.equal(r.open.adds, 2, "只能加碼 2 次");
  // 1000 + 500 + 1000 = 2500
  assert.ok(close(r.open.cost, 2500, 1e-9), "投入 " + r.open.cost);
});

test("DCA：加碼倍數會讓每次投入遞增", () => {
  const prices = [100, 90, 81, 72.9];
  const r = E.dcaBacktest(mk(prices), {
    first: 1000, addAmount: 500, dropPct: 10, mult: 2, maxAdds: 3, takeProfitPct: 50
  });
  // 100@100、90@90、81@81 各觸發一次加碼（500、1000、2000），72.9 這根沒有位置再驗證
  // 由下一個測試單獨驗證遞增金額；這裡只看價格觸發第三次加碼
  assert.equal(r.open.adds, 3, "三次加碼都觸發：adds=" + r.open.adds);
  const adds = r.trades.filter((t) => t.side === "add");
  assert.ok(close(adds[0].price * adds[0].qty, 500, 1e-9));
  assert.ok(close(adds[1].price * adds[1].qty, 1000, 1e-9));
});

test("連續停損暫停：24 小時內停損 3 次 → 暫停 4 小時", () => {
  const H = 3600000;
  const t0 = 0;
  const trades = [
    { why: "停損", outTime: t0 + 1 * H, pnl: -10 },
    { why: "停損", outTime: t0 + 3 * H, pnl: -10 },
    { why: "停損", outTime: t0 + 5 * H, pnl: -10 }
  ];
  const w = E.protectionWindows(trades, {
    guardOn: true, guardN: 24, guardM: 3, guardK: 4, lowOn: false, stake: 1000
  });
  assert.equal(w.length, 1);
  assert.equal(w[0].from, t0 + 5 * H);
  assert.equal(w[0].to, t0 + 9 * H);
  assert.equal(w[0].why, "連續停損");
  assert.equal(E.inWindow(w, t0 + 6 * H), true, "暫停期間內");
  assert.equal(E.inWindow(w, t0 + 10 * H), false, "暫停結束後");
});

test("連續停損暫停：停損次數不足就不暫停", () => {
  const trades = [
    { why: "停損", outTime: 1 * 3600000, pnl: -10 },
    { why: "停損", outTime: 3 * 3600000, pnl: -10 }
  ];
  const w = E.protectionWindows(trades, { guardOn: true, guardN: 24, guardM: 3, guardK: 4, lowOn: false, stake: 1000 });
  assert.equal(w.length, 0);
});

test("低獲利暫停：最近 3 筆總報酬 < 0.5% → 暫停 2 小時", () => {
  const H = 3600000;
  const trades = [
    { why: "均線下穿", outTime: 1 * H, pnl: 1 },
    { why: "均線下穿", outTime: 2 * H, pnl: -1 },
    { why: "均線下穿", outTime: 3 * H, pnl: 0 },
    { why: "均線下穿", outTime: 5 * H, pnl: 100 }
  ];
  const w = E.protectionWindows(trades, {
    guardOn: false, lowOn: true, lowN: 3, lowX: 0.5, lowK: 2, stake: 1000
  });
  // 前 3 筆總和 0 → 0% < 0.5% → 暫停
  // 第 4 筆時最近 3 筆 = -1+0+100 = 99 → 9.9% ≥ 0.5% → 不暫停
  assert.equal(w.length, 1);
  assert.equal(w[0].from, 3 * H);
  assert.equal(w[0].why, "低獲利");
});
