#!/usr/bin/env node
/**
 * Telegram 推播與指令。
 *
 * 讀環境變數 TG_BOT_TOKEN、TG_CHAT_ID。沒設定就在 log 寫「Telegram 未設定，略過」，機器人照常跑。
 * 用 long polling（getUpdates）。只回應 TG_CHAT_ID，其他人的訊息一律忽略。
 *
 * 測試一律用 mock fetch，**不准**對真實 Telegram 送出請求。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAUSE = path.join(ROOT, "bot", "PAUSE");
const STATE = path.join(ROOT, "bot", "state");

export const API = "https://api.telegram.org";

export function env() {
  const token = process.env.TG_BOT_TOKEN || "";
  const chatId = process.env.TG_CHAT_ID || "";
  return { token, chatId, configured: Boolean(token && chatId) };
}

/* ---------- 推播文字（只陳述事實，不寫建議） ---------- */
export function fmtEnter(e) {
  return `進場\n價格 ${e.price}\n數量 ${Number(e.size).toFixed(6)}\n原因 ${e.why}\n時間 ${e.t}`;
}

export function fmtExit(e) {
  const sign = e.pnl >= 0 ? "+" : "";
  return `出場\n價格 ${e.price}\n損益 ${sign}${Number(e.pnl).toFixed(2)} USDT\n原因 ${e.why}\n時間 ${e.t}`;
}

export function fmtDaily(d) {
  return `每日摘要 ${d.date}\n交易 ${d.trades} 筆，勝 ${d.wins} 筆\n今日損益 ${d.pnl >= 0 ? "+" : ""}${Number(d.pnl).toFixed(2)} USDT\n權益 ${Number(d.equity).toFixed(2)} USDT`;
}

export function fmtHalt(e) {
  return `回撤停機\n峰值 ${Number(e.peak).toFixed(2)} → 目前 ${Number(e.balance).toFixed(2)} USDT\n不再開新倉`;
}

export function fmtDataFail(n) {
  return `資料連續失效 ${n} 次\n不進行交易，下一輪重試`;
}

export function fmtRule2(t) {
  return `策略 B 規則 2 成立（停下來、有反向放量）\n4h K 線開盤 ${t}`;
}

/* ---------- 送出 ---------- */
// 回傳 true 表示已送；false 表示未設定、沒送
export async function send(text, opts = {}) {
  const e = opts.env || env();
  if (!e.configured) return false;
  const fetchFn = opts.fetch || fetch;
  const res = await fetchFn(`${API}/bot${e.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: e.chatId, text, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error("Telegram HTTP " + res.status);
  return true;
}

/* ---------- 指令 ---------- */
export function handleCommand(text, ctx = {}) {
  const cmd = String(text || "").trim().split(/\s+/)[0];
  switch (cmd) {
    case "/status": {
      const s = ctx.status || {};
      const pos = s.position ? `持倉 進場 ${s.position.entry}` : "無持倉";
      const eq = s.equity ? `權益 ${Number(s.equity.balance).toFixed(2)} USDT` : "權益 —";
      const pa = s.paused ? "已暫停" : "運行中";
      return `${pa}\n${pos}\n${eq}\n資料 ${s.now || "—"}`;
    }
    case "/pause":
      fs.mkdirSync(path.dirname(PAUSE), { recursive: true });
      fs.writeFileSync(PAUSE, new Date().toISOString());
      return "已暫停，不開新倉。持有的倉位照規則出場。";
    case "/resume":
      try { fs.unlinkSync(PAUSE); } catch (err) { /* 本來就沒有 */ }
      return "已恢復，會依規則開新倉。";
    case "/report": {
      const items = ctx.journal || [];
      const exits = items.filter((x) => x.type === "exit");
      const wins = exits.filter((x) => x.pnl > 0).length;
      const pnl = exits.reduce((a, x) => a + (x.pnl || 0), 0);
      return `近 7 天\n出場 ${exits.length} 筆\n勝 ${wins} 筆\n損益 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`;
    }
    case "/params":
      return "參數\n" + JSON.stringify(ctx.cfg || {}, null, 2);
    default:
      return null;
  }
}

/* ---------- long polling ---------- */
export async function pollOnce(offset, opts = {}) {
  const e = opts.env || env();
  if (!e.configured) return { ok: false, why: "未設定", offset };
  const fetchFn = opts.fetch || fetch;
  const res = await fetchFn(`${API}/bot${e.token}/getUpdates?timeout=25&offset=${offset}`);
  if (!res.ok) throw new Error("Telegram HTTP " + res.status);
  const data = await res.json();
  const updates = data.result || [];
  const replies = [];
  let nextOffset = offset;

  for (const u of updates) {
    nextOffset = u.update_id + 1;
    const msg = u.message;
    if (!msg) continue;
    // 只回應授權的 chat，其他一律忽略
    if (String(msg.chat.id) !== String(e.chatId)) continue;
    const reply = handleCommand(msg.text, opts.ctx || {});
    if (reply !== null) replies.push(reply);
  }
  return { ok: true, offset: nextOffset, replies };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = env();
  if (!e.configured) {
    console.log("Telegram 未設定，略過");
    process.exit(0);
  }
  let offset = 0;
  const loop = async () => {
    try {
      const r = await pollOnce(offset);
      offset = r.offset;
      for (const t of r.replies) await send(t);
    } catch (err) {
      console.error("poll 失敗：" + err.message);
    }
    setTimeout(loop, 1000);
  };
  loop();
}
