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

test("/pause 會建立 PAUSE 檔", () => {
  const p = new URL("../bot/PAUSE", import.meta.url).pathname;
  try { fs.unlinkSync(p); } catch (e) { /* 不存在 */ }
  const reply = T.handleCommand("/pause", {});
  assert.match(reply, /已暫停/);
  assert.equal(fs.existsSync(p), true);
  T.handleCommand("/resume", {});
  assert.equal(fs.existsSync(p), false);
});

test("/status 包含狀態欄位", () => {
  const s = T.handleCommand("/status", { status: { position: null, equity: { balance: 1000 }, paused: false, now: "x" } });
  assert.match(s, /無持倉/);
  assert.match(s, /1000\.00/);
});

test("未知指令回 null（不回應）", () => {
  assert.equal(T.handleCommand("/whatever", {}), null);
  assert.equal(T.handleCommand("hi", {}), null);
});
