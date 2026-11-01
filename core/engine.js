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
  var peak = 0, curve = 0, mdd = 0, mddAt = null;
  var curvePts = [{ i: 0, eq: equityStart }];
  trades.forEach(function (t) {
    totalPnl += t.pnl;
    if (t.pnl > 0) { wins++; grossWin += t.pnl; } else if (t.pnl < 0) { grossLoss += -t.pnl; }
    holdSum += t.hold; holdN++;
    curve += t.pnl;
    curvePts.push({ i: t.outIdx, eq: equityStart + curve });
    if (curve > peak) peak = curve;
    if (peak - curve > mdd) { mdd = peak - curve; mddAt = t; }
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
