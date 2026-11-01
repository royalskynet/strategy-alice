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

/* ---------- 狀態讀寫 ---------- */
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

export function isPaused() { return fs.existsSync(PAUSE); }

export function loadConfig() {
  const raw = readJSON(CONFIG, null);
  if (!raw) return { ok: false, why: "config.json 不存在" };
  const v = E.validateConfig(raw, {});
  if (!v.ok) return { ok: false, why: "參數不合法", errors: v.errors };
  return { ok: true, cfg: v.cfg, regimeFilter: raw.regimeFilter || "off" };
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
export function decide(cfg, bars, state) {
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

  let bars;
  try {
    bars = opts.bars || await (opts.fetcher || fetchKlines)();
  } catch (e) {
    // 資料失效：不交易，記一筆，下一輪重試
    appendJournal({ t: new Date().toISOString(), type: "data_fail", why: String(e.message || e) });
    return { ok: false, why: "資料失效：" + (e.message || e) };
  }

  const state = opts.state || loadState();
  const d = decide(cfg, bars, state);
  const equity = state.equity || { balance: cfg.equity || cfg.stake, peak: cfg.equity || cfg.stake, trades: 0, wins: 0 };

  if (d.action === "enter") {
    const pos = {
      inTime: bars[bars.length - 1][0],
      entry: d.price,
      size: cfg.stake / d.price,
      sl: d.price * (1 - cfg.sl / 100),
      tp: d.price * (1 + cfg.tp / 100),
      trailLine: -Infinity,
      trailOn: false,
      high: bars[bars.length - 1][2],
      held: 0
    };
    if (!opts.dryRun) atomicWrite(POSITION, pos);
    appendJournal({ t: new Date().toISOString(), type: "enter", price: d.price, size: pos.size, why: d.why });
    return { ok: true, action: "enter", price: d.price };
  }

  if (d.action === "exit") {
    const pos = state.position;
    if (!pos) return { ok: true, action: "none", why: "無持倉" };
    const slip = (cfg.slip || 0) / 100, fee = (cfg.fee || 0) / 100;
    const realIn = pos.entry * (1 + slip), realOut = d.price * (1 - slip);
    const pnl = cfg.stake * (realOut / realIn - 1) - cfg.stake * fee * 2;
    equity.balance += pnl;
    equity.trades += 1;
    if (pnl > 0) equity.wins += 1;
    if (equity.balance > equity.peak) equity.peak = equity.balance;
    if (!opts.dryRun) {
      atomicWrite(POSITION, null);
      atomicWrite(EQUITY, equity);
    }
    appendJournal({ t: new Date().toISOString(), type: "exit", price: d.price, pnl, why: d.why });
    return { ok: true, action: "exit", price: d.price, pnl, why: d.why };
  }

  return { ok: true, action: d.action, why: d.why };
}

/* ---------- 主迴圈 ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
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
    const r = await tick();
    console.log(new Date().toISOString() + " " + JSON.stringify(r));
    if (once) process.exit(r.ok ? 0 : 1);
  };
  await loop();
  if (!once) setInterval(loop, 60_000);
}
