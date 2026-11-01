#!/usr/bin/env node
/**
 * 紙上自動交易機器人
 *
 * 每 60 秒檢查一次。有新收完的 1h K 線，就跑 engine 的計算。
 * 訊號在收盤時判定，用下一根的開盤價成交，和回測規則一致。
 *
 * 用法：
 *   node bot/runner.mjs              常駐執行
 *   node bot/runner.mjs --once       只跑一輪
 *   node bot/runner.mjs --replay <fixture.json>   用 fixture 逐根重播，不連網
 *
 * 停止開關：bot/PAUSE 檔案存在時不開新倉，已有的照規則出場。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, DEFAULT_CFG } from "../tests/helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOT = path.join(ROOT, "bot");
const STATE = path.join(BOT, "state");
const CONFIG = path.join(BOT, "config.json");
const PAUSE = path.join(BOT, "PAUSE");
const JOURNAL = path.join(STATE, "journal.ndjson");
const POSITION = path.join(STATE, "position.json");
const EQUITY = path.join(STATE, "equity.json");

const E = loadEngine();
const KLINE_URL = "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=500";
const TIMEOUT_MS = 15000;

/* ---------- 原子寫入 ---------- */
// 先寫 .tmp 再 rename，避免寫到一半斷電留下壞檔
export function atomicWrite(file, data) {
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function appendJournal(entry) {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify(entry) + "\n");
}

/** Telegram 指令與暫停／恢復都寫 type: "cmd" 的稽核紀錄 */
export function auditCmd(cmd, extra) {
  appendJournal(Object.assign({ t: new Date().toISOString(), type: "cmd", cmd }, extra || {}));
}

/* ---------- 狀態讀寫 ---------- */
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

export function isPaused() { return fs.existsSync(PAUSE); }

// 策略種類：A＝均線交叉、B＝四旗標盤況、grid＝網格、dca＝定投。全部只做紙上。
export const STRATEGIES = ["A", "B", "grid", "dca"];

export function validateStrategyConfig(raw) {
  if (!raw) return { ok: false, why: "config.json 不存在" };
  const kind = STRATEGIES.includes(raw.strategy) ? raw.strategy : "A";
  if (kind === "grid") {
    const g = {
      upper: Number(raw.upper), lower: Number(raw.lower),
      grids: Number(raw.grids), perGrid: Number(raw.perGrid), geo: raw.geo === true
    };
    if (!(g.upper > g.lower)) return { ok: false, why: "參數不合法", errors: { upper: "上界要大於下界" } };
    if (!(Number.isInteger(g.grids) && g.grids >= 2)) return { ok: false, why: "參數不合法", errors: { grids: "格數要大於等於 2 的整數" } };
    if (!(g.perGrid > 0)) return { ok: false, why: "參數不合法", errors: { perGrid: "每格投入要大於 0 USDT" } };
    return { ok: true, kind, cfg: g, regimeFilter: "off" };
  }
  if (kind === "dca") {
    const d = {
      first: Number(raw.first), addAmount: Number(raw.addAmount),
      dropPct: Number(raw.dropPct), mult: Number(raw.mult || 1),
      maxAdds: Number(raw.maxAdds), takeProfitPct: Number(raw.takeProfitPct)
    };
    const bad = [];
    if (!(d.first > 0)) bad.push("first");
    if (!(d.addAmount > 0)) bad.push("addAmount");
    if (!(d.dropPct > 0)) bad.push("dropPct");
    if (!(Number.isInteger(d.maxAdds) && d.maxAdds >= 0)) bad.push("maxAdds");
    if (!(d.takeProfitPct > 0)) bad.push("takeProfitPct");
    if (bad.length) return { ok: false, why: "參數不合法", errors: bad.reduce((o, k) => (o[k] = "這一欄必填且要合理。", o), {}) };
    return { ok: true, kind, cfg: d, regimeFilter: "off" };
  }
  const v = E.validateConfig(raw, {});
  if (!v.ok) return { ok: false, why: "參數不合法", errors: v.errors };
  return { ok: true, kind, cfg: v.cfg, regimeFilter: raw.regimeFilter || "off" };
}

export function loadConfig() {
  return validateStrategyConfig(readJSON(CONFIG, null));
}

export const HEARTBEAT = path.join(STATE, "heartbeat.json");
export const HEARTBEAT_STALE_MS = 180000;   // 超過 180 秒沒更新＝機器人無回應

export function writeHeartbeat(extra) {
  atomicWrite(HEARTBEAT, Object.assign({ t: new Date().toISOString(), ms: Date.now() }, extra || {}));
}

/** 讀心跳並判斷是否逾時。沒有心跳檔＝從未啟動過，也算無回應。 */
export function heartbeatStatus(nowMs) {
  const hb = readJSON(HEARTBEAT, null);
  const now = nowMs === undefined ? Date.now() : nowMs;
  if (!hb || !Number.isFinite(hb.ms)) return { alive: false, lastHeartbeat: null, ageMs: null };
  const age = now - hb.ms;
  return { alive: age <= HEARTBEAT_STALE_MS, lastHeartbeat: hb.t, ageMs: age };
}

export function loadState() {
  return {
    position: readJSON(POSITION, null),
    equity: readJSON(EQUITY, null),
    paused: isPaused()
  };
}

/* ---------- 資料抓取 ---------- */
export async function fetchKlines(url = KLINE_URL) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    return E.toBars(raw);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 核心：一根 K 線的決策 ---------- */
// 用前 closedBars 根（不含當根）算訊號，用當根的開盤價成交。
// 這和回測的「第 i 根收盤形成訊號、第 i 根收盤價進場」不同：
// 回測是同一根收盤進場，機器人是下一根開盤進場，比較接近實際下單。
// ponytail: 兩者差一個開盤跳空。目前接受，等真上紙上跑一段再對帳。
export function decide(cfg, bars, state, strategy) {
  const kind = strategy || "A";
  if (kind === "grid") return decideGrid(cfg, bars, state);
  if (kind === "dca") return decideDca(cfg, bars, state);
  return decideMA(cfg, bars, state);
}

/* 網格：用當根收盤價對上「上一根的收盤價」判斷有沒有跨過格線。
   往下跨線買在跨過的那條線，往上跨線賣在跨回的那條線。 */
export function gridBuyPx(cfg, px) {
  const g = cfg.grids;
  if (px <= cfg.lower) return cfg.lower;
  if (px >= cfg.upper) return cfg.lower + (cfg.upper - cfg.lower) * (g - 1) / g;
  for (let k = 1; k <= g; k++) {
    const lv = cfg.geo
      ? cfg.lower * Math.pow(cfg.upper / cfg.lower, k / g)
      : cfg.lower + (cfg.upper - cfg.lower) * k / g;
    if (px < lv) return k === 1 ? cfg.lower : (cfg.geo
      ? cfg.lower * Math.pow(cfg.upper / cfg.lower, (k - 1) / g)
      : cfg.lower + (cfg.upper - cfg.lower) * (k - 1) / g);
  }
  return cfg.upper;
}

export function decideGrid(cfg, bars, state) {
  if (bars.length < 2) return { action: "none", why: "資料不足" };
  const prev = bars[bars.length - 2][4];
  const px = bars[bars.length - 1][4];
  const held = (state.position && state.position.lots) || [];
  if (px <= cfg.lower) return { action: "none", why: "跌破下界，暫停" };

  if (px > prev) {
    // 往上：賣掉最早買進的一格
    if (!held.length) return { action: "hold", why: "手無網格倉，等回落" };
    return { action: "exit", price: px, why: "網格賣出", size: held[0].qty, all: false };
  }
  if (px < prev) {
    if (state.paused) return { action: "none", why: "PAUSE 檔案存在" };
    if (held.length >= cfg.grids) return { action: "hold", why: "網格已滿" };
    return { action: "enter", price: px, size: cfg.perGrid / px, why: "網格買入", gridLot: true };
  }
  return { action: "hold", why: "價格沒動" };
}

/* 定投：持倉均價跌 dropPct 就加碼；均價漲到停利就全平。 */
export function decideDca(cfg, bars, state) {
  if (!bars.length) return { action: "none", why: "資料不足" };
  const px = bars[bars.length - 1][4];
  const pos = state.position;
  if (!pos) {
    if (state.paused) return { action: "none", why: "PAUSE 檔案存在" };
    return { action: "enter", price: px, size: cfg.first / px, why: "定投首單", dcaStart: true };
  }
  if (pos.avg && px >= pos.avg * (1 + cfg.takeProfitPct / 100)) {
    return { action: "exit", price: px, why: "定投停利", all: true };
  }
  if (state.paused) return { action: "hold", why: "持倉中（暫停不加碼）" };
  if (pos.adds < cfg.maxAdds && px <= pos.lastAddPx * (1 - cfg.dropPct / 100)) {
    const amt = cfg.addAmount * Math.pow(cfg.mult || 1, pos.adds);
    return { action: "enter", price: px, size: amt / px, why: "定投加碼 " + (pos.adds + 1), dcaAdd: true, amount: amt };
  }
  return { action: "hold", why: "持倉中" };
}

function decideMA(cfg, bars, state) {
  if (bars.length < Math.max(cfg.slow, cfg.fast) + 2) {
    return { action: "none", why: "資料不足" };
  }

  const hist = bars.slice(0, -1);          // 不含當根
  const cur = bars[bars.length - 1];       // 當根，用它的開盤價成交
  const entryPrice = cur[1];

  const closes = hist.map((b) => b[4]);
  const fastMA = E.movingAvg(closes, cfg.fast, cfg.maType);
  const slowMA = E.movingAvg(closes, cfg.slow, cfg.maType);
  const i = hist.length - 1;
  const f = fastMA[i], s = slowMA[i], fp = fastMA[i - 1], sp = slowMA[i - 1];
  const crossUp = fp !== null && sp !== null && fp <= sp && f > s;
  const crossDown = fp !== null && sp !== null && fp >= sp && f < s;

  const pos = state.position;
  if (pos) {
    // 已持倉：檢查出場
    const stop = pos.trailLine && pos.trailLine > pos.sl ? pos.trailLine : pos.sl;
    if (cur[3] <= stop) {
      const why = pos.trailOn && stop > pos.sl ? "移動停損" : "停損";
      return { action: "exit", price: stop, why };
    }
    if (cur[2] >= pos.tp) return { action: "exit", price: pos.tp, why: "停利" };
    if (cfg.revExit && crossDown) return { action: "exit", price: entryPrice, why: "均線下穿" };
    if (cfg.maxHold > 0 && pos.held >= cfg.maxHold) return { action: "exit", price: entryPrice, why: "逾時" };
    return { action: "hold", why: "持倉中" };
  }

  if (state.paused) return { action: "none", why: "PAUSE 檔案存在" };
  if (!crossUp) return { action: "none", why: "無訊號" };

  // 冷卻
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) return { action: "none", why: "冷卻中" };

  return { action: "enter", price: entryPrice, why: "均線交叉" };
}

/* ---------- 一輪 ---------- */
export async function tick(opts = {}) {
  const cfgRes = opts.cfgRes || loadConfig();
  if (!cfgRes.ok) {
    appendJournal({ t: new Date().toISOString(), type: "config_error", why: cfgRes.why, errors: cfgRes.errors });
    return { ok: false, why: cfgRes.why };
  }
  const cfg = cfgRes.cfg;
  const kind = cfgRes.kind || "A";
  if (!opts.dryRun) writeHeartbeat({ strategy: kind });

  let bars;
  try {
    bars = opts.bars || await (opts.fetcher || fetchKlines)();
  } catch (e) {
    // 資料失效：不交易，記一筆，下一輪重試
    appendJournal({ t: new Date().toISOString(), type: "data_fail", why: String(e.message || e) });
    return { ok: false, why: "資料失效：" + (e.message || e) };
  }

  const state = opts.state || loadState();
  const d = decide(cfg, bars, state, kind);
  const startEq = cfg.equity || cfg.stake || cfg.first || 1000;
  const equity = state.equity || { balance: startEq, peak: startEq, trades: 0, wins: 0 };
  const slip = (cfg.slip || 0) / 100, fee = (cfg.fee || 0) / 100;
  const stakeOf = (pos, price, amount) => (pos && pos.invested) || amount || cfg.stake || cfg.perGrid || cfg.first;

  if (d.action === "enter") {
    const last = bars[bars.length - 1];
    let pos;
    if (kind === "grid") {
      const prev = state.position && state.position.lots ? state.position : { lots: [], invested: 0, kind: "grid" };
      pos = {
        kind: "grid",
        lots: prev.lots.concat([{ price: d.price, qty: d.size }]),
        invested: prev.invested + cfg.perGrid,
        avg: (prev.invested + cfg.perGrid) / (prev.lots.reduce((a, l) => a + l.qty, 0) + d.size),
        inTime: last[0], held: 0
      };
    } else if (kind === "dca") {
      const prev = state.position || { legs: [], invested: 0, adds: 0, lastAddPx: d.price, inTime: last[0], kind: "dca", held: 0 };
      const legs = prev.legs.concat([{ price: d.price, qty: d.size }]);
      const invested = prev.invested + (d.amount || cfg.first);
      const qty = legs.reduce((a, l) => a + l.qty, 0);
      pos = {
        kind: "dca", legs,
        invested,
        qty,
        avg: invested / qty,
        adds: prev.adds + (d.dcaAdd ? 1 : 0),
        lastAddPx: d.dcaAdd ? d.price : prev.lastAddPx,
        inTime: prev.inTime, held: 0
      };
    } else {
      pos = {
        kind, inTime: last[0], entry: d.price, invested: cfg.stake, size: cfg.stake / d.price,
        sl: d.price * (1 - cfg.sl / 100), tp: d.price * (1 + cfg.tp / 100),
        trailLine: -Infinity, trailOn: false, high: last[2], held: 0
      };
    }
    if (!opts.dryRun) atomicWrite(POSITION, pos);
    appendJournal({ t: new Date().toISOString(), type: "enter", price: d.price, size: d.size, why: d.why, strategy: kind });
    return { ok: true, action: "enter", price: d.price, why: d.why, position: pos };
  }

  if (d.action === "exit") {
    const pos = state.position;
    if (!pos) return { ok: true, action: "none", why: "無持倉" };
    let pnl;
    if (kind === "grid") {
      const lot = pos.lots[0];
      const realIn = lot.price * (1 + slip), realOut = d.price * (1 - slip);
      pnl = lot.qty * (realOut - realIn) - cfg.perGrid * fee * 2;
      pos.lots = pos.lots.slice(1);
      pos.invested = Math.max(0, pos.invested - cfg.perGrid);
      pos.avg = pos.lots.length ? pos.invested / pos.lots.reduce((a, l) => a + l.qty, 0) : null;
    } else if (kind === "dca") {
      const realIn = pos.avg * (1 + slip), realOut = d.price * (1 - slip);
      pnl = pos.qty * (realOut - realIn) - pos.invested * fee * 2;
      pos.lots = [];
    } else {
      const realIn = pos.entry * (1 + slip), realOut = d.price * (1 - slip);
      pnl = cfg.stake * (realOut / realIn - 1) - cfg.stake * fee * 2;
    }
    equity.balance += pnl;
    equity.trades += 1;
    if (pnl > 0) equity.wins += 1;
    if (equity.balance > equity.peak) equity.peak = equity.balance;
    const stillHeld = d.all ? false : (kind === "grid" && pos && pos.lots && pos.lots.length > 0);
    if (!opts.dryRun) {
      atomicWrite(POSITION, stillHeld ? pos : null);
      atomicWrite(EQUITY, equity);
    }
    appendJournal({ t: new Date().toISOString(), type: "exit", price: d.price, pnl, why: d.why, strategy: kind });
    return { ok: true, action: "exit", price: d.price, pnl, why: d.why };
  }

  return { ok: true, action: d.action, why: d.why };
}

/* ---------- 主迴圈 ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const opts_onetime = once;
  const replayIdx = args.indexOf("--replay");

  if (replayIdx >= 0) {
    const file = args[replayIdx + 1];
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const bars = raw.klines_raw ? E.toBars(raw.klines_raw) : (raw.bars || raw);
    const cfgRes = loadConfig();
    if (!cfgRes.ok) { console.error("設定錯誤：" + cfgRes.why); process.exit(1); }
    let state = { position: null, equity: { balance: cfgRes.cfg.equity || 1000, peak: 0, trades: 0, wins: 0 }, paused: false };
    for (const b of bars) {
      const r = await tick({ cfgRes, bars: [b], state, dryRun: true });
      if (r.action === "enter") state.position = r.price;
    }
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  }

  const loop = async () => {
    let r;
    try {
      r = await tick();
    } catch (e) {
      r = { ok: false, why: "未預期錯誤：" + (e && e.message || e) };
    }
    console.log(new Date().toISOString() + " " + JSON.stringify(r));
    if (opts_onetime) process.exit(r.ok ? 0 : 1);
  };
  await loop();
  if (!once) setInterval(loop, 60_000);
}
