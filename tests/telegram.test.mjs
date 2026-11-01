/** H 段：Telegram。全部用 mock fetch，不對真實 Telegram 送出請求。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const T = await import("../bot/telegram.mjs");

function mockFetch(captured, status = 200, body = { ok: true, result: [] }) {
  return async (url, opts) => {
    captured.push({ url, opts });
    return { ok: status < 400, status, json: async () => body };
  };
}

const ENV = { token: "TEST_TOKEN", chatId: "12345", configured: true };

test("未設定時不呼叫 fetch", async () => {
  const cap = [];
  const r = await T.send("x", { env: { token: "", chatId: "", configured: false }, fetch: mockFetch(cap) });
  assert.equal(r, false);
  assert.equal(cap.length, 0);
});

test("已設定時送出，打到 sendMessage", async () => {
  const cap = [];
  await T.send("hello", { env: ENV, fetch: mockFetch(cap) });
  assert.equal(cap.length, 1);
  assert.match(cap[0].url, /sendMessage/);
  const body = JSON.parse(cap[0].opts.body);
  assert.equal(body.chat_id, "12345");
  assert.equal(body.text, "hello");
});

test("推播文字格式", () => {
  assert.match(T.fmtEnter({ price: 100, size: 0.5, why: "均線交叉", t: "2026-11-01" }), /進場[\s\S]*價格 100/);
  assert.match(T.fmtExit({ price: 110, pnl: 5.5, why: "停利", t: "2026-11-01" }), /\+5\.50/);
  assert.match(T.fmtDaily({ date: "2026-11-01", trades: 3, wins: 2, pnl: -1, equity: 999 }), /每日摘要/);
  assert.match(T.fmtHalt({ peak: 1100, balance: 900 }), /回撤停機/);
  assert.match(T.fmtDataFail(3), /連續失效 3 次/);
});

test("非授權 chat 被忽略", async () => {
  const cap = [];
  const body = {
    ok: true,
    result: [
      { update_id: 1, message: { chat: { id: 999 }, text: "/status" } },
      { update_id: 2, message: { chat: { id: 12345 }, text: "/status" } }
    ]
  };
  const r = await T.pollOnce(0, { env: ENV, fetch: mockFetch(cap, 200, body), ctx: { status: {} } });
  assert.equal(r.replies.length, 1, "只該回應授權 chat");
  assert.equal(r.offset, 3);
});

test("/stopentry 會建立 PAUSE 檔、/start 會移除", () => {
  const p = new URL("../bot/PAUSE", import.meta.url).pathname;
  try { fs.unlinkSync(p); } catch (e) { /* 不存在 */ }
  const reply = T.handleCommand("/stopentry", {});
  assert.match(reply, /已停止進場/);
  assert.equal(fs.existsSync(p), true);
  T.handleCommand("/start", {});
  assert.equal(fs.existsSync(p), false);
});

test("/pause 與 /resume 是別名，行為相同", () => {
  const p = new URL("../bot/PAUSE", import.meta.url).pathname;
  try { fs.unlinkSync(p); } catch (e) { /* 不存在 */ }
  assert.match(T.handleCommand("/pause", {}), /已停止進場/);
  assert.equal(fs.existsSync(p), true);
  assert.match(T.handleCommand("/resume", {}), /已恢復/);
  assert.equal(fs.existsSync(p), false);
});

test("/status 包含狀態欄位", () => {
  const s = T.handleCommand("/status", { status: { position: null, equity: { balance: 1000 }, paused: false, now: "x" } });
  assert.match(s, /無持倉/);
  assert.match(s, /1000\.00/);
});

test("/status 心跳逾時顯示「機器人無回應」", () => {
  const s = T.handleCommand("/status", {
    status: { position: null, equity: { balance: 1000 }, paused: false },
    heartbeat: { alive: false, ageMs: 999999, lastHeartbeat: "x" }
  });
  assert.match(s, /機器人無回應/);
  const ok = T.handleCommand("/status", {
    status: { position: null, equity: { balance: 1000 }, paused: false },
    heartbeat: { alive: true, ageMs: 1000, lastHeartbeat: "x" }
  });
  assert.match(ok, /心跳正常/);
});

test("12 個指令都有回應（/help 列出全部）", () => {
  const help = T.handleCommand("/help", {});
  assert.match(help, /\/status/);
  for (const c of T.COMMANDS) assert.ok(help.includes(c) || c === "/stopentry", c + " 應出現在 /help");
  assert.equal(T.COMMANDS.length, 12);
});

const JOURNAL = [
  { t: "2026-11-01T01:00:00Z", type: "exit", pnl: 10, why: "停利" },
  { t: "2026-11-01T02:00:00Z", type: "exit", pnl: -4, why: "停損" },
  { t: "2026-11-01T03:00:00Z", type: "exit", pnl: 6, why: "均線下穿" }
];

test("/profit、/daily、/weekly、/performance、/balance、/trades 都能回", () => {
  const ctx = { journal: JOURNAL, equity: { balance: 1002, peak: 1010 }, now: Date.parse("2026-11-01T04:00:00Z") };
  assert.match(T.handleCommand("/profit", ctx), /\+12\.00/);
  assert.match(T.handleCommand("/daily", ctx), /出場 3 筆/);
  assert.match(T.handleCommand("/weekly", ctx), /近 7 天/);
  assert.match(T.handleCommand("/performance", ctx), /勝率 66\.7%/);
  assert.match(T.handleCommand("/balance", ctx), /1002\.00/);
  assert.match(T.handleCommand("/trades", ctx), /均線下穿/);
});

test("/forceexit 只平紙上，回覆「已平倉（紙上）」並寫稽核紀錄", () => {
  const audited = [];
  const r = T.handleCommand("/forceexit", { status: { position: { entry: 100 } }, audit: (c) => audited.push(c) });
  assert.match(r, /已平倉（紙上）/);
  assert.match(r, /沒有送出任何真實訂單/);
  assert.deepEqual(audited, ["/forceexit"]);
  const none = T.handleCommand("/forceexit", { status: { position: null } });
  assert.match(none, /無需平倉/);
});

test("/show_config 輸出目前參數", () => {
  const s = T.handleCommand("/show_config", { cfg: { fast: 20, slow: 60 } });
  assert.match(s, /"fast": 20/);
});

test("未知指令回 null（不回應）", () => {
  assert.equal(T.handleCommand("/whatever", {}), null);
  assert.equal(T.handleCommand("hi", {}), null);
});
