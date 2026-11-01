/*CORE-BEGIN*/
/**
 * strategy-alice 共用引擎
 *
 * 網頁（index.html）和機器人（bot/runner.mjs）都用這一份計算。
 * index.html 裡 CORE-BEGIN 到 CORE-END 之間的內容由 tools/build.mjs 從這裡產生，
 * 不要手改 index.html 那一段。
 *
 * 環境無關：不碰 DOM、不碰 localStorage、不碰 fetch。純函式。
 */
"use strict";

/* ---------- 均線 ---------- */
function sma(closes, n) {
  var out = new Array(closes.length).fill(null);
  var sum = 0;
  for (var i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(closes, n) {
  var out = new Array(closes.length).fill(null);
  var k = 2 / (n + 1), prev = 0, sum = 0;
  for (var i = 0; i < closes.length; i++) {
    if (i < n) { sum += closes[i]; if (i === n - 1) { prev = sum / n; out[i] = prev; } }
    else { prev = closes[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

function movingAvg(closes, n, type) { return type === "ema" ? ema(closes, n) : sma(closes, n); }

/* ---------- 4h 合成 ---------- */
// 連續 4 根 1h 合併：開＝第一根開、高＝最高、低＝最低、收＝最後一根收、量＝加總
// ponytail: 只處理「從第一根起每 4 根一組」的對齊。真實行情若首根不是 4h 邊界，會有相位差；
//           真實模式目前只用 1h 畫圖、4h 另外向 Binance 抓，不走這條。
function to4h(bars) {
  var out = [];
  for (var i = 0; i + 3 < bars.length; i += 4) {
    var q = bars.slice(i, i + 4);
    out.push([bars[i][0], q[0][1], Math.max.apply(null, q.map(function (b) { return b[2]; })),
      Math.min.apply(null, q.map(function (b) { return b[3]; })), q[3][4],
      q.reduce(function (a, b) { return a + b[5]; }, 0)]);
  }
  return out;
}

/* ---------- 回測 ---------- */
// barsIn：[[時, 開, 高, 低, 收, 量], ...]
// cfg：見 validate() 的輸出
function backtestOn(barsIn, cfg, clock) {
  var src = cfg.tf === "4h" ? to4h(barsIn) : barsIn;
  var slip = (cfg.slip || 0) / 100, fee = (cfg.fee || 0) / 100;
  var closes = src.map(function (b) { return b[4]; });
  var fastMA = movingAvg(closes, cfg.fast, cfg.maType);
  var slowMA = movingAvg(closes, cfg.slow, cfg.maType);
  var trades = [];
  var pos = null;
  var dailyLoss = {};
  var blockedDays = {};
  var blockedCount = 0;
  var cooldownUntil = -1;       // 停損後冷卻：最早可再進場的索引
  var equityStart = cfg.equity || cfg.stake;
  var equity = equityStart, peakEq = equityStart, ddHalt = false, ddHaltIdx = -1;
  var ddLimit = (cfg.ddStop || 0) / 100;
  var totalCost = 0;
  // clock：把索引轉成可讀時間。預設用 Date；示範資料用固定起始時間
  var clockFn = clock || function (h) { return h; };

  for (var i = 1; i < src.length; i++) {
    var bar = src[i];
    var f = fastMA[i], s2 = slowMA[i], fp = fastMA[i - 1], sp = slowMA[i - 1];
    var crossUp = fp !== null && sp !== null && fp <= sp && f > s2;
    var crossDown = fp !== null && sp !== null && fp >= sp && f < s2;

    if (pos) {
      // 停損線：基本＝進場價 ×(1−停損%)；移動停損啟動後只上移
      var stop = pos.sl;
      if (cfg.trail) {
        var highRet = (pos.high / pos.entry - 1) * 100;
        if (highRet >= cfg.trailStart) {
          var line = pos.high * (1 - cfg.trailDist / 100);
          if (line > pos.trailLine) pos.trailLine = line;
          if (pos.trailLine > stop) { stop = pos.trailLine; pos.trailOn = true; }
        }
      }
      var exit = null, why = "";
      // 同一根同時碰到停損與停利 → 一律當作先碰停損（保守算法）
      if (bar[3] <= stop) { exit = stop; why = pos.trailOn && stop > pos.sl ? "移動停損" : "停損"; }
      else if (bar[2] >= pos.tp) { exit = pos.tp; why = "停利"; }
      else if (cfg.revExit && crossDown) { exit = bar[4]; why = "均線下穿"; }
      else if (cfg.maxHold > 0 && i - pos.inIdx >= cfg.maxHold) { exit = bar[4]; why = "逾時"; }

      // 最高價要在一根結束時更新（不能讓同一根的停損看到同一根的高點）
      if (bar[2] > pos.high) pos.high = bar[2];

      if (exit !== null) {
        var rawIn = pos.entry, rawOut = exit;
        var realIn = rawIn * (1 + slip), realOut = rawOut * (1 - slip);
        var pnl = cfg.stake * (realOut / realIn - 1) - cfg.stake * fee * 2;
        totalCost += cfg.stake * (slip * 2 + fee * 2);
        trades.push({
          inIdx: pos.inIdx, outIdx: i,
          inTime: clockFn(src[pos.inIdx][0]), outTime: clockFn(i),
          entry: rawIn, exit: rawOut, size: pos.size, pnl: pnl, why: why,
          hold: i - pos.inIdx
        });
        var dk = dayKey(src[pos.inIdx][0], clockFn);
        if (pnl < 0) dailyLoss[dk] = (dailyLoss[dk] || 0) - pnl;
        if (why === "停損" || why === "移動停損") cooldownUntil = i + (cfg.cool || 0);
        equity += pnl;
        if (equity > peakEq) peakEq = equity;
        if (ddLimit > 0 && !ddHalt && (peakEq - equity) / peakEq > ddLimit) { ddHalt = true; ddHaltIdx = i; }
        pos = null;
      }
    } else if (crossUp) {
      if (i < cooldownUntil) continue;
      if (ddHalt) continue;
      var dk2 = dayKey(src[i][0], clockFn);
      if ((dailyLoss[dk2] || 0) >= cfg.cap) { blockedDays[dk2] = true; blockedCount++; continue; }
      var entry = bar[4];
      pos = {
        inIdx: i, entry: entry, size: cfg.stake / entry, high: bar[2],
        sl: entry * (1 - cfg.sl / 100), tp: entry * (1 + cfg.tp / 100),
        trailLine: -Infinity, trailOn: false
      };
    }
  }

  var totalPnl = 0, wins = 0, grossWin = 0, grossLoss = 0, holdSum = 0, holdN = 0;
  var peak = 0, curve = 0, mdd = 0, mddAt = null, mddPct = 0;
  var curvePts = [{ i: 0, eq: equityStart }];
  trades.forEach(function (t) {
    totalPnl += t.pnl;
    if (t.pnl > 0) { wins++; grossWin += t.pnl; } else if (t.pnl < 0) { grossLoss += -t.pnl; }
    holdSum += t.hold; holdN++;
    curve += t.pnl;
    curvePts.push({ i: t.outIdx, eq: equityStart + curve });
    if (curve > peak) peak = curve;
    if (peak - curve > mdd) { mdd = peak - curve; mddAt = t; mddPct = equityStart > 0 ? (peak - curve) / (equityStart + peak) * 100 : 0; }
  });

  return {
    trades: trades,
    totalPnl: totalPnl,
    totalRet: totalPnl / cfg.stake * 100,
    netRet: totalPnl / cfg.stake * 100,
    wins: wins,
    n: trades.length,
    winRate: trades.length ? wins / trades.length * 100 : null,
    mdd: mdd,
    mddPct: mddPct,
    equityStart: equityStart,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgHold: holdN ? holdSum / holdN : null,
    cost: totalCost,
    curve: curvePts,
    openPos: pos,
    blockedDays: Object.keys(blockedDays),
    blockedCount: blockedCount,
    dailyLoss: dailyLoss,
    ddHalt: ddHalt,
    ddHaltIdx: ddHaltIdx,
    bars: src
  };
}

function dayKey(t, clockFn) {
  var ms = clockFn(t);
  var d = new Date(ms);
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

/* ---------- 期間分解 ---------- */
// 把已完成的交易按日／按月彙總
// kind: "day" | "month"
function periodBreakdown(trades, kind, clockFn) {
  var buckets = {};
  var order = [];
  trades.forEach(function (t) {
    var ms = clockFn(t.outTime);
    var d = new Date(ms);
    var key = kind === "month"
      ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
      : d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    if (!buckets[key]) { buckets[key] = { key: key, pnl: 0, n: 0, wins: 0 }; order.push(key); }
    buckets[key].pnl += t.pnl;
    buckets[key].n += 1;
    if (t.pnl > 0) buckets[key].wins += 1;
  });
  order.sort();
  return order.map(function (k) {
    var b = buckets[k];
    return { key: k, pnl: b.pnl, n: b.n, wins: b.wins, winRate: b.n ? b.wins / b.n * 100 : null };
  });
}

/* ---------- 前視偏誤檢查 ---------- */
// 把資料切一半，對每半各跑一次；若前半的結果隨「未來資料是否存在」而變，就代表有偷看未來。
// 正確的實作：前半（K[:cut]）跑出來的交易，必須與「全資料但只留下在 cut 之前出場的交易」一致。
function lookaheadCheck(barsIn, cfg, clock) {
  var cut = Math.floor(barsIn.length / 2);
  var clockFn = clock || function (h) { return h; };
  var full = backtestOn(barsIn, cfg, clockFn);
  var half = backtestOn(barsIn.slice(0, cut), cfg, clockFn);
  var fullBefore = full.trades.filter(function (t) { return t.outIdx < cut; });
  var diffs = [];
  var m = Math.min(half.trades.length, fullBefore.length);
  for (var i = 0; i < m; i++) {
    var a = half.trades[i], b = fullBefore[i];
    if (a.inIdx !== b.inIdx || a.outIdx !== b.outIdx || Math.abs(a.pnl - b.pnl) > 1e-9) {
      diffs.push({ i: i, half: a.inIdx, full: b.inIdx });
    }
  }
  return {
    ok: diffs.length === 0 && half.trades.length === fullBefore.length,
    n: half.trades.length,
    cut: cut,
    total: barsIn.length,
    diff: diffs.length
  };
}

/* ---------- 參數驗證（環境無關） ---------- */
// 回傳 {ok:true, cfg} 或 {ok:false, errors:{id:訊息}}
// 訊息文字與網頁逐字相同，改這裡要同步改測試的預期字串。
function validateConfig(raw, opts) {
  var o = opts || {};
  var errors = {};
  var v = {};
  var NUM_KEYS = ["fast", "slow", "sl", "tp", "stake", "cap", "trailStart", "trailDist",
    "maxHold", "equity", "fee", "slip", "cool", "ddStop"];
  var INT_KEYS = { fast: 1, slow: 1, maxHold: 1, cool: 1 };

  NUM_KEYS.forEach(function (k) {
    var x = raw[k];
    if (x === undefined || x === null || String(x).trim() === "") { v[k] = null; errors[k] = "這一欄必填。"; return; }
    var n = Number(x);
    if (!Number.isFinite(n)) { v[k] = NaN; errors[k] = "請填數字。"; return; }
    v[k] = n;
  });

  function chk(k, cond, msg) { if (!errors[k] && v[k] !== null && !cond) errors[k] = msg; }
  var isInt = function (x) { return Number.isInteger(x); };

  chk("fast", isInt(v.fast) && v.fast > 0, "快均線週期要大於 0 的整數，例如 20");
  chk("slow", isInt(v.slow) && v.slow > 0, "慢均線週期要大於 0 的整數，例如 60");
  if (!errors.slow && v.fast !== null && v.slow !== null && isInt(v.fast) && isInt(v.slow) && !(v.slow > v.fast)) {
    errors.slow = "慢均線週期要大於快均線，請把慢線改大或快線改小";
  }
  chk("sl", v.sl >= 0.1 && v.sl <= 50, "停損要介於 0.1% 到 50% 之間");
  chk("tp", v.tp >= 0.1 && v.tp <= 50, "停利要介於 0.1% 到 50% 之間");
  chk("stake", v.stake > 0, "每筆投入要大於 0 USDT");
  chk("cap", v.cap > 0, "每日虧損上限要大於 0 USDT");
  chk("maxHold", isInt(v.maxHold) && v.maxHold >= 0, "最長持倉要填 0 或正整數");
  chk("cool", isInt(v.cool) && v.cool >= 0, "停損後冷卻要填 0 或正整數");
  chk("equity", v.equity > 0, "初始資金要大於 0 USDT");
  chk("fee", v.fee >= 0 && v.fee <= 1, "手續費要介於 0% 到 1% 之間");
  chk("slip", v.slip >= 0 && v.slip <= 2, "滑價要介於 0% 到 2% 之間");
  chk("ddStop", v.ddStop >= 0 && v.ddStop <= 90, "最大回撤停機要介於 0% 到 90% 之間");
  chk("trailStart", v.trailStart > 0, "移動停損啟動獲利要大於 0%");
  chk("trailDist", v.trailDist > 0, "移動停損回撤距離要大於 0%");

  var trailOn = raw.trail === true || raw.trail === 1 || raw.trail === "1";
  if (trailOn && !errors.trailStart && !errors.trailDist && v.trailStart !== null && v.trailDist !== null &&
      !(v.trailStart > v.trailDist)) {
    errors.trailStart = "移動停損啟動獲利要大於回撤距離，否則一啟動就立刻出場";
  }
  if (!errors.stake && v.stake !== null && v.equity !== null && v.stake > v.equity) {
    errors.stake = "每筆投入不能超過初始資金 " + v.equity + " USDT";
  }

  if (Object.keys(errors).length) return { ok: false, errors: errors };

  v.maType = raw.maType === "ema" ? "ema" : "sma";
  v.tf = raw.tf === "4h" ? "4h" : "1h";
  v.revExit = raw.revExit === true || raw.revExit === 1 || raw.revExit === "1";
  v.trail = trailOn;
  return { ok: true, cfg: v };
}

/* ---------- 策略 B：四條盤況規則 ---------- */
// 閾值與 btc_watch 一致
var B_TH = { burst: 6.5, volX: 3.17, netDir: -0.193, flatBars: 3, range: 3.5, highPos: 75, trendRet: 0.8 };

// 淨方向 = 2 × 主動買量 ÷ 量 − 1；量為 0 回 null
function netDir(b) {
  return b[5] > 0 ? 2 * b[6] / b[5] - 1 : null;
}

// bars4h：[[時, 開, 高, 低, 收, 量, 主動買量], ...]，至少 180 根
// 回傳 {ok, flags:[{n,on,label,detail}], ret48, pos30, width72, maxx48, volbase, n, lastOpenMs}
function evaluateRegime(bars4h, th) {
  var T = th || B_TH;
  var n = bars4h.length;
  if (n < 180) return { ok: false, reason: "資料不足", n: n };

  var last = bars4h[n - 1], c = last[4];
  var closes = bars4h.map(function (b) { return b[4]; });
  var vols = bars4h.map(function (b) { return b[5]; });

  // 前 120 根（不含當根）的量中位數；120 為偶數 → 取中間兩數平均
  var base = n >= 121 ? vols.slice(-121, -1).sort(function (a, b) { return a - b; }) : null;
  var volbase = null;
  if (base) {
    var mid = base.length / 2;
    volbase = base.length % 2 ? base[Math.floor(mid)] : (base[mid - 1] + base[mid]) / 2;
  }

  // 48h 報酬＝收盤 ÷ 11 根前開盤 − 1（比例，不是百分比）
  // ponytail: 前綴比 13 根短時回 null；btc_watch 在 n<MIN_BARS(180) 時整筆不評分，兩者行為一致。
  var ret48 = n >= 12 && bars4h[n - 12] ? c / bars4h[n - 12][1] - 1 : null;
  var win48 = bars4h.slice(-12);
  // 48h 內最大量倍數（btc_watch：max(k.v / base for k in w12)）
  var maxx48 = volbase !== null
    ? Math.max.apply(null, win48.map(function (b) { return b[5] / volbase; }))
    : null;
  // 48h 價格區間（原本誤用 maxx48 這個名字，改叫 range48）
  var range48 = Math.max.apply(null, win48.map(function (b) { return b[2]; })) /
    Math.min.apply(null, win48.map(function (b) { return b[3]; })) - 1;
  // 30 天位置＝(收盤 − 180 根最低) ÷ (180 根最高 − 180 根最低)
  var w30 = bars4h.slice(-180);
  var hi30 = Math.max.apply(null, w30.map(function (b) { return b[2]; }));
  var lo30 = Math.min.apply(null, w30.map(function (b) { return b[3]; }));
  var pos30 = hi30 > lo30 ? (c - lo30) / (hi30 - lo30) : null;
  // 72h 區間：18 根的最高、最低，以及區間寬 ÷ 現價（btc_watch 定義）
  var w72 = bars4h.slice(-18);
  var hi72 = Math.max.apply(null, w72.map(function (b) { return b[2]; }));
  var lo72 = Math.min.apply(null, w72.map(function (b) { return b[3]; }));
  var width72 = c > 0 ? (hi72 - lo72) / c : null;

  // 距 72h 高點已幾根沒創新高；同價取第一根（btc_watch 的 max(range) 行為）
  var iHi = 0;
  for (var j = 1; j < w72.length; j++) { if (w72[j][2] > w72[iHi][2]) iHi = j; }
  var barsSinceHi = w72.length - 1 - iHi;
  var stalled = barsSinceHi >= T.flatBars;

  // 規則 1：48h 報酬 ≥ 6.50%，且 48h 內有一根量 ≥ 基準量 3.17 倍
  var r1 = ret48 !== null && ret48 * 100 >= T.burst &&
    maxx48 !== null && maxx48 >= T.volX;

  // 規則 2：48h 內一根同時 量≥3.17倍、淨方向≤−0.193、收黑
  var bigBar = win48.some(function (b) {
    var nd = netDir(b);
    return b[5] >= volbase * T.volX && nd !== null && nd <= T.netDir && b[4] < b[1];
  });
  var r2 = bigBar && stalled;

  // 規則 3：已停滯、72h 區間寬 ≤ 3.50%、現價在 30 天區間 75% 以上
  var r3 = stalled && width72 !== null && width72 * 100 <= T.range &&
    pos30 !== null && pos30 * 100 >= T.highPos;

  // 規則 4：現價 > 72h 低點、48h 報酬 ≥ 0.80%、現價在 30 天區間 50% 以上
  var r4 = c > lo72 && ret48 !== null && ret48 * 100 >= T.trendRet &&
    pos30 !== null && pos30 * 100 >= 50;

  return {
    ok: true,
    n: n,
    lastOpenMs: last[0],
    flags: [
      { n: 1, on: r1, label: "90 度爆噴，別摸頂做空", detail: "48h " + fmtPct(ret48) },
      { n: 2, on: r2, label: "停下來、有反向放量", detail: "大根衝 " + (bigBar ? "有" : "無") },
      { n: 3, on: r3, label: "高位震盪", detail: "72h 區間 " + fmtNum(width72 * 100, 2) + "%" },
      { n: 4, on: r4, label: "上升趨勢，同點位低接", detail: "30 天位置 " + (pos30 === null ? "—" : fmtNum(pos30 * 100, 1) + "%") }
    ],
    ret48: ret48, pos30: pos30, width72: width72, maxx48: maxx48, range48: range48,
    volbase: volbase, barsSinceHi: barsSinceHi
  };
}

function fmtPct(v) { return v === null ? "—" : (v * 100).toFixed(2) + "%"; }
function fmtNum(v, dp) { return Number(v).toFixed(dp); }

/* ---------- M1 績效指標 ---------- */
// 每根 K 線之間的報酬率（以策略權益為基礎）：持倉時用該根的價格變動，空手為 0
function barReturns(bars, trades, stake) {
  var ret = new Array(bars.length).fill(0);
  trades.forEach(function (t) {
    for (var i = t.inIdx + 1; i <= t.outIdx; i++) {
      ret[i] = bars[i - 1][4] !== 0 ? bars[i][4] / bars[i - 1][4] - 1 : 0;
    }
  });
  return ret;
}

function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }

// 下行標準差：只算負報酬，以 0 為目標
function downsideDev(a) {
  var sq = a.map(function (r) { return Math.min(r, 0) * Math.min(r, 0); });
  return Math.sqrt(mean(sq));
}

function stddev(a) {
  if (a.length < 2) return 0;
  var m = mean(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}

// 年化係數：1h 一年 8760 根，4h 一年 2190 根
function barsPerYear(tf) { return tf === "4h" ? 2190 : 8760; }

/**
 * 專業回測報告。全部以「每筆投入（stake）」為基準。
 * 無風險利率固定 0。年化用 K 線根數換算，不假設日曆。
 */
function metricsOn(result, opts) {
  var o = opts || {};
  var cfg = o.cfg || {};
  var stake = cfg.stake || 1000;
  var tf = cfg.tf === "4h" ? "4h" : "1h";
  var bpy = barsPerYear(tf);
  var bars = result.bars || [];
  var trades = result.trades || [];
  var n = trades.length;

  // 回撤曲線：逐點累積權益，記錄峰值與回撤（百分比，相對峰值權益）
  // 空資料時 fallback 用每筆投入當基準，避免除零
  var startEq = (cfg.equity || cfg.stake || 1000);
  var peak = startEq, ddCurve = [], mddPct = 0;
  result.curve.forEach(function (p) {
    if (p.eq > peak) peak = p.eq;
    var dd = peak > 0 ? (peak - p.eq) / peak * 100 : 0;
    if (dd > mddPct) mddPct = dd;
    ddCurve.push({ i: p.i, dd: -dd });
  });

  var rets = barReturns(bars, trades, stake);
  var sd = stddev(rets);
  var dd = downsideDev(rets);
  var sharpe = sd > 0 ? mean(rets) / sd * Math.sqrt(bpy) : null;
  var sortino = dd > 0 ? mean(rets) / dd * Math.sqrt(bpy) : null;
  // 年化報酬：以總報酬換算到一年
  var totalRetPct = result.totalPnl / stake * 100;
  var nBars = bars.length || 1;
  var years = nBars / bpy;
  var annualPct = years > 0 ? (Math.pow(1 + totalRetPct / 100, 1 / years) - 1) * 100 : null;
  var calmar = annualPct !== null && mddPct > 0 ? annualPct / mddPct : null;

  var wins = trades.filter(function (t) { return t.pnl > 0; });
  var losses = trades.filter(function (t) { return t.pnl < 0; });
  var avgWin = wins.length ? mean(wins.map(function (t) { return t.pnl; })) : null;
  var avgLoss = losses.length ? mean(losses.map(function (t) { return -t.pnl; })) : null;
  var winLossRatio = avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null;
  var expectancy = n ? result.totalPnl / n : null;

  // 最長連贏、連虧
  var mw = 0, ml = 0, cw = 0, cl = 0;
  trades.forEach(function (t) {
    if (t.pnl > 0) { cw++; cl = 0; } else if (t.pnl < 0) { cl++; cw = 0; }
    if (cw > mw) mw = cw;
    if (cl > ml) ml = cl;
  });

  // 持倉時間占比
  var heldBars = trades.reduce(function (s, t) { return s + (t.outIdx - t.inIdx); }, 0);
  var timeInMarket = nBars ? heldBars / nBars * 100 : 0;

  // 買進持有：第一根收盤買、最後一根收盤賣
  var bhPct = null;
  if (bars.length > 1 && bars[0][4] > 0) {
    bhPct = (bars[bars.length - 1][4] / bars[0][4] - 1) * 100;
  }

  return {
    sharpe: sharpe,
    sortino: sortino,
    calmar: calmar,
    annualPct: annualPct,
    expectancy: expectancy,
    avgWin: avgWin,
    avgLoss: avgLoss,
    winLossRatio: winLossRatio,
    maxWinStreak: mw,
    maxLossStreak: ml,
    timeInMarket: timeInMarket,
    buyHoldPct: bhPct,
    excessPct: bhPct === null ? null : totalRetPct - bhPct,
    totalRetPct: totalRetPct,
    mddPct: mddPct,
    ddCurve: ddCurve,
    barReturns: rets,
    years: years
  };
}

/* ---------- 評估用：產生回測報告（含指標） ---------- */
function reportOn(barsIn, cfg, clock) {
  var result = backtestOn(barsIn, cfg, clock);
  return { result: result, metrics: metricsOn(result, { cfg: cfg }) };
}

/* ---------- 參數最佳化（M2） ---------- */
// 兩個參數的網格。combos ≤ 400，超過直接擋。
// cfgFor(combo) 產生回測參數；objective(kind, result, metrics) 回傳分數（越大越好）
var OPT_MAX = 400;

function gridCombos(rangeA, rangeB) {
  function vals(r) {
    var out = [];
    var step = Math.abs(r.step) || 1;
    var up = r.from <= r.to;
    for (var v = r.from; up ? v <= r.to + 1e-9 : v >= r.to - 1e-9; v += up ? step : -step) {
      out.push(Math.round(v * 1e6) / 1e6);
      if (out.length > 1000) break;
    }
    return out;
  }
  var a = vals(rangeA), b = vals(rangeB);
  return { a: a, b: b, count: a.length * b.length };
}

function objectiveScore(kind, metrics, result) {
  switch (kind) {
    case "sharpe": return metrics.sharpe === null ? -Infinity : metrics.sharpe;
    case "calmar": return metrics.calmar === null ? -Infinity : metrics.calmar;
    case "retdd": return metrics.mddPct > 0 ? metrics.totalRetPct / metrics.mddPct : metrics.totalRetPct;
    default: return metrics.totalRetPct;
  }
}

/**
 * inSample 前 70% 找最佳，後 30% 驗證。回傳格子陣列（含 is/oos 分數）。
 * 同步版；Web Worker 包在外面負責進度與取消。
 */
function optimizeOn(barsIn, baseCfg, rangeA, rangeB, keyA, keyB, objective, clock) {
  var g = gridCombos(rangeA, rangeB);
  if (g.count > OPT_MAX) {
    return { ok: false, error: "參數組合數 " + g.count + " 超過上限 " + OPT_MAX + "，請把範圍縮小或步長加大" };
  }
  var cut = Math.floor(barsIn.length * 0.7);
  var inBars = barsIn.slice(0, cut), outBars = barsIn.slice(cut - (baseCfg.slow || 60));
  var off = baseCfg.slow || 60;
  var clockIn = clock, clockOut = clock;
  var cells = [], best = null;
  g.a.forEach(function (va, i) {
    g.b.forEach(function (vb, j) {
      var cfg = Object.assign({}, baseCfg);
      cfg[keyA] = va; cfg[keyB] = vb;
      var v = validateConfig(cfg);
      if (!v.ok) { cells.push({ i: i, j: j, a: va, b: vb, skip: true }); return; }
      var rIn = backtestOn(inBars, v.cfg, clockIn);
      var mIn = metricsOn(rIn, { cfg: v.cfg });
      var rOut = backtestOn(outBars, v.cfg, clockOut);
      var mOut = metricsOn(rOut, { cfg: v.cfg });
      var sIn = objectiveScore(objective, mIn, rIn);
      var sOut = objectiveScore(objective, mOut, rOut);
      var cell = { i: i, j: j, a: va, b: vb, inScore: sIn, outScore: sOut,
        inRet: mIn.totalRetPct, outRet: mOut.totalRetPct, inN: rIn.n, outN: rOut.n,
        inSharpe: mIn.sharpe, outSharpe: mOut.sharpe };
      cells.push(cell);
      if (!best || sIn > best.inScore) best = cell;
    });
  });
  var overfit = null;
  if (best && Number.isFinite(best.inRet) && Number.isFinite(best.outRet)) {
    // 樣本外報酬低於樣本內一半 → 標過度擬合
    overfit = best.inRet > 0 && best.outRet < best.inRet * 0.5;
  }
  return { ok: true, cells: cells, a: g.a, b: g.b, keyA: keyA, keyB: keyB,
    best: best, overfit: overfit, cut: cut, objective: objective, off: off };
}

/* ---------- M3 網格策略 ---------- */
// cfg: { upper, lower, grids, perGrid, geo }
// 價格每穿過一格就成交一次：往下穿＝買、往上穿＝賣。
// 回傳 {trades:[{i,side,price,qty,pnl}], realized, unmatched, openQty, openCost}
function gridBacktest(bars, cfg) {
  var upper = cfg.upper, lower = cfg.lower, g = Math.max(2, Math.floor(cfg.grids));
  var per = cfg.perGrid;
  var levels = [];
  for (var k = 0; k <= g; k++) {
    var p = cfg.geo
      ? lower * Math.pow(upper / lower, k / g)
      : lower + (upper - lower) * k / g;
    levels.push(p);
  }
  var pos = [];          // 手上每一格的買單：{price, qty}
  var trades = [], realized = 0;
  // 格線離散化：價格落在哪個格區間，以及實際成交價
  // 買價＝該區間的下格線，賣價＝上格線。區間邊界不含下界，所以價格「剛好等於」格線時算已跨過。
  function segLow(px) {
    if (px <= lower) return 0;
    if (px >= upper) return g;
    for (var k = 1; k <= g; k++) if (px < levels[k]) return k;
    return g;
  }
  function buyPx(px) {
    var s = segLow(px);
    if (s <= 0) return levels[0];
    if (s >= g) return levels[g - 1];
    return levels[s - 1];
  }
  function sellPx(px) {
    var s = segLow(px);
    if (s >= g) return levels[g];
    return levels[s];
  }
  if (!bars.length) {
    return { levels: levels, trades: [], realized: 0, openQty: 0, openCost: 0,
      unrealized: 0, fills: 0, avgCost: null, lastPx: 0 };
  }
  var inZone = true;     // 是否已經在格區間內（第一次進區間不算「往下穿」）
  var lastSeg = segLow(bars[0][4]);
  inZone = bars[0][4] < upper && bars[0][4] > lower;
  for (var i = 1; i < bars.length; i++) {
    var px = bars[i][4];
    if (px >= upper) {
      // 衝出上界：把手上的全部賣在最後一條線
      while (pos.length) {
        var lot0 = pos.shift();
        var pnl0 = lot0.qty * (levels[g] - lot0.price);
        realized += pnl0;
        trades.push({ i: i, side: "sell", price: levels[g], qty: lot0.qty, pnl: pnl0 });
      }
      inZone = false;
      lastSeg = g;
      continue;
    }
    if (px <= lower) {
      // 跌破下界：只買一次最低格，避免無限加碼
      if (inZone || pos.length === 0) {
        var qb = per / levels[0];
        pos.push({ price: levels[0], qty: qb, i: i });
        trades.push({ i: i, side: "buy", price: levels[0], qty: qb, pnl: 0 });
      }
      inZone = true;
      lastSeg = 0;
      continue;
    }
    var seg = segLow(px);
    if (!inZone) {
      // 重新進入區間：從上界滑進來就當作往下穿一次，買在上一條線
      if (px < upper) {
        var qr = per / levels[g - 1];
        pos.push({ price: levels[g - 1], qty: qr, i: i });
        trades.push({ i: i, side: "buy", price: levels[g - 1], qty: qr, pnl: 0 });
      }
      inZone = true;
      lastSeg = seg;
      continue;
    }
    var guard = 0;
    while (seg < lastSeg && guard++ < g * 2) {
      // 往下穿：買在剛跨過的上一格
      var bp = lastSeg >= g ? levels[g - 1] : levels[lastSeg - 1];
      var q = per / bp;
      pos.push({ price: bp, qty: q, i: i });
      trades.push({ i: i, side: "buy", price: bp, qty: q, pnl: 0 });
      lastSeg--;
    }
    while (seg > lastSeg && guard++ < g * 2) {
      lastSeg++;
      if (pos.length) {
        // 往上穿：賣回剛跨過的那條線，先進先出
        var sp = levels[lastSeg];
        var lot = pos.shift();
        var pnl = lot.qty * (sp - lot.price);
        realized += pnl;
        trades.push({ i: i, side: "sell", price: sp, qty: lot.qty, pnl: pnl });
      }
    }
  }
  var openQty = pos.reduce(function (s, p) { return s + p.qty; }, 0);
  var openCost = pos.reduce(function (s, p) { return s + p.qty * p.price; }, 0);
  var lastPx = bars.length ? bars[bars.length - 1][4] : 0;
  return {
    levels: levels, trades: trades, realized: realized,
    openQty: openQty, openCost: openCost,
    unrealized: openQty ? openQty * lastPx - openCost : 0,
    fills: trades.length,
    avgCost: openQty ? openCost / openQty : null,
    lastPx: lastPx
  };
}

/* ---------- M3 定投（DCA）策略 ---------- */
// cfg: { first, addAmount, dropPct, mult, maxAdds, takeProfitPct, stake }
// 第一筆進場後，價格每再跌 dropPct，就加碼 addAmount × mult^次數，最多 maxAdds 次。
// 全部持倉的均價漲到 均價×(1+takeProfitPct) 就全部停利，接著等下一筆首單。
function dcaBacktest(bars, cfg) {
  var cyclesDone = [];
  var trades = [];      // 明細：buy / add / sell
  var startIdx = -1;
  var cycle = null;
  function avgOf(ls) {
    var q = ls.reduce(function (s, l) { return s + l.qty; }, 0);
    var c = ls.reduce(function (s, l) { return s + l.qty * l.price; }, 0);
    return { qty: q, cost: c, avg: q ? c / q : null };
  }
  for (var i = 0; i < bars.length; i++) {
    var px = bars[i][4];
    if (!cycle) {
      if (startIdx < 0) startIdx = i;
      var q0 = cfg.first / px;
      cycle = { inIdx: i, legs: [{ price: px, qty: q0 }], adds: 0, maxCost: cfg.first, lastAddPx: px };
      continue;
    }
    var a = avgOf(cycle.legs);
    if (cycle.adds < cfg.maxAdds && px <= cycle.lastAddPx * (1 - cfg.dropPct / 100)) {
      var amt = cfg.addAmount * Math.pow(cfg.mult || 1, cycle.adds);
      var qa = amt / px;
      cycle.legs.push({ price: px, qty: qa });
      cycle.adds++;
      cycle.maxCost = Math.max(cycle.maxCost, avgOf(cycle.legs).cost);
      cycle.lastAddPx = px;
      trades.push({ i: i, side: "add", price: px, qty: qa, pnl: 0 });
      continue;
    }
    if (a.avg && px >= a.avg * (1 + cfg.takeProfitPct / 100)) {
      var pnl = a.qty * px - a.cost;
      trades.push({ i: i, side: "sell", price: px, qty: a.qty, pnl: pnl });
      cyclesDone.push({ inIdx: cycle.inIdx, outIdx: i, avg: a.avg, exit: px,
        invest: a.cost, pnl: pnl, adds: cycle.adds, maxCost: cycle.maxCost });
      cycle = null;
    }
  }
  var open = cycle ? avgOf(cycle.legs) : null;
  return {
    trades: trades,
    cycles: cyclesDone,
    open: cycle ? { avg: open.avg, qty: open.qty, cost: open.cost,
      unrealized: open.qty * (bars.length ? bars[bars.length - 1][4] : 0) - open.cost,
      adds: cycle.adds, maxCost: cycle.maxCost } : null
  };
}

/* ---------- M3 保護機制 ---------- */
// 連續停損後暫停：N 小時內停損 M 次 → 暫停 K 小時
// 低獲利暫停：最近 N 筆總報酬 < X% → 暫停 K 小時
/**
 * @param trades 已排序的交易（含 outTime 毫秒、pnl）
 * @param cfg { guardOn, guardN, guardM, guardK, lowOn, lowN, lowX, lowK, stake }
 * @returns 暫停區間 [{from, to, why}]
 */
function protectionWindows(trades, cfg) {
  var out = [];
  var H = 3600000;
  if (cfg.guardOn) {
    var stops = [];
    trades.forEach(function (t) {
      if (t.why !== "停損" && t.why !== "移動停損") return;
      stops.push(t.outTime);
      var from = t.outTime - cfg.guardN * H;
      var recent = stops.filter(function (x) { return x >= from && x <= t.outTime; });
      if (recent.length >= cfg.guardM) {
        out.push({ from: t.outTime, to: t.outTime + cfg.guardK * H, why: "連續停損" });
      }
    });
  }
  if (cfg.lowOn && cfg.lowN > 0) {
    for (var i = cfg.lowN - 1; i < trades.length; i++) {
      var win = trades.slice(i - cfg.lowN + 1, i + 1);
      var ret = win.reduce(function (s, t) { return s + t.pnl; }, 0) / cfg.stake * 100;
      if (ret < cfg.lowX) {
        out.push({ from: trades[i].outTime, to: trades[i].outTime + cfg.lowK * H, why: "低獲利" });
      }
    }
  }
  return out;
}

function inWindow(windows, ms) {
  return windows.some(function (w) { return ms >= w.from && ms < w.to; });
}

/* ---------- K 線原始資料轉換 ---------- */
// Binance /api/v3/klines 原始陣列 → 引擎用的緊湊陣列
// 回傳 [[毫秒時戳, 開, 高, 低, 收, 量, 主動買量], ...]
// 量為 0 的 K 線直接丟掉（btc_watch 的 parse() 同樣行為）
function toBars(raw) {
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var k = raw[i];
    var v = parseFloat(k[5]);
    if (!(v > 0)) continue;
    out.push([k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]),
      v, parseFloat(k[9])]);
  }
  return out;
}

// 4h 原始資料 → 引擎用的緊湊陣列（已經是真 4h，不需合成）
function toBars4h(raw) { return toBars(raw); }
/*CORE-END*/
