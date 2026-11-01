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
// 12 個指令，對照 freqtrade。查詢類只讀狀態，控制類只動紙上狀態。
export const COMMANDS = [
  "/status", "/profit", "/daily", "/weekly", "/performance", "/balance", "/trades",
  "/stopentry", "/start", "/forceexit", "/show_config", "/help"
];

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

/** 從 journal 撈指定時間窗內的出場紀錄 */
function exitsSince(journal, sinceMs) {
  return (journal || []).filter((x) => x.type === "exit" && Date.parse(x.t) >= sinceMs);
}

function summarize(list) {
  const pnl = list.reduce((a, x) => a + (x.pnl || 0), 0);
  const wins = list.filter((x) => (x.pnl || 0) > 0).length;
  return { n: list.length, wins, pnl, winRate: list.length ? wins / list.length * 100 : null };
}

export function handleCommand(text, ctx = {}) {
  const cmd = String(text || "").trim().split(/\s+/)[0].replace(/@\w+$/, "");
  const journal = ctx.journal || [];
  const eq = ctx.equity || (ctx.status && ctx.status.equity) || {};
  const balance = Number(eq.balance);
  const now = ctx.now === undefined ? Date.now() : ctx.now;
  const H = 3600000, D = 24 * H;
  const audit = ctx.audit || function () {};

  switch (cmd) {
    case "/status": {
      const s = ctx.status || {};
      const pos = s.position
        ? `持倉 ${s.position.kind || "A"}　進場 ${s.position.entry || s.position.avg}`
        : "無持倉";
      const hb = ctx.heartbeat;
      const alive = hb ? (hb.alive ? "心跳正常" : "機器人無回應") : "";
      return [`${s.paused ? "已暫停" : "運行中"}`, pos,
        `權益 ${Number.isFinite(balance) ? balance.toFixed(2) : "—"} USDT`,
        alive].filter(Boolean).join("\n");
    }
    case "/profit": {
      const all = journal.filter((x) => x.type === "exit");
      const s = summarize(all);
      return `總損益 ${fmtMoney(s.pnl)} USDT\n出場 ${s.n} 筆，勝 ${s.wins} 筆` +
        (s.winRate === null ? "" : `\n勝率 ${s.winRate.toFixed(1)}%`);
    }
    case "/daily": {
      const t0 = now - now % D;
      const s = summarize(exitsSince(journal, t0));
      return `今日（24h）\n出場 ${s.n} 筆，勝 ${s.wins} 筆\n損益 ${fmtMoney(s.pnl)} USDT`;
    }
    case "/weekly": {
      const s = summarize(exitsSince(journal, now - 7 * D));
      return `近 7 天\n出場 ${s.n} 筆，勝 ${s.wins} 筆\n損益 ${fmtMoney(s.pnl)} USDT`;
    }
    case "/performance": {
      const all = journal.filter((x) => x.type === "exit");
      const s = summarize(all);
      const wins = all.filter((x) => (x.pnl || 0) > 0);
      const losses = all.filter((x) => (x.pnl || 0) < 0);
      const aw = wins.length ? wins.reduce((a, x) => a + x.pnl, 0) / wins.length : null;
      const al = losses.length ? losses.reduce((a, x) => a + -x.pnl, 0) / losses.length : null;
      return `績效\n勝率 ${s.winRate === null ? "—" : s.winRate.toFixed(1) + "%"}\n` +
        `平均賺 ${aw === null ? "—" : aw.toFixed(2)}\n平均賠 ${al === null ? "—" : al.toFixed(2)}\n` +
        `賺賠比 ${aw !== null && al ? (aw / al).toFixed(2) : "—"}`;
    }
    case "/balance": {
      const peak = Number(eq.peak);
      const dd = Number.isFinite(peak) && peak > 0 && Number.isFinite(balance)
        ? ((peak - balance) / peak * 100).toFixed(2) + "%" : "—";
      return `平衡 ${Number.isFinite(balance) ? balance.toFixed(2) : "—"} USDT\n峰值 ${Number.isFinite(peak) ? peak.toFixed(2) : "—"} USDT\n目前回撤 ${dd}`;
    }
    case "/trades": {
      const last = journal.filter((x) => x.type === "exit").slice(-5).reverse();
      if (!last.length) return "還沒有出場紀錄";
      return last.map((x, i) =>
        `${i + 1}. ${fmtMoney(x.pnl)} USDT　${x.why || ""}　${String(x.t).slice(0, 16).replace("T", " ")}`).join("\n");
    }
    case "/stopentry":
      fs.mkdirSync(path.dirname(PAUSE), { recursive: true });
      fs.writeFileSync(PAUSE, new Date().toISOString());
      audit("/stopentry");
      return "已停止進場（等同 /pause）。持有的倉位照規則出場。";
    case "/start":
      try { fs.unlinkSync(PAUSE); } catch (err) { /* 本來就沒有 */ }
      audit("/start");
      return "已恢復，會依規則開新倉。";
    case "/pause":
      return handleCommand("/stopentry", ctx);
    case "/resume":
      return handleCommand("/start", ctx);
    case "/forceexit": {
      const s = ctx.status || {};
      if (!s.position) return "目前沒有紙上持倉，無需平倉";
      audit("/forceexit");
      return "已平倉（紙上）\n請注意：這是紙上紀錄，沒有送出任何真實訂單。";
    }
    case "/show_config":
      return "目前參數\n" + JSON.stringify(ctx.cfg || {}, null, 2);
    case "/help":
      return "指令\n查詢：" + COMMANDS.slice(0, 7).join(" ") +
        "\n控制：" + COMMANDS.slice(7, 10).join(" ") +
        "\n其他：" + COMMANDS.slice(10).join(" ");
    case "/params":
      return handleCommand("/show_config", ctx);
    case "/report":
      return handleCommand("/weekly", ctx);
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
