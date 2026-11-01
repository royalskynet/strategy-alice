/** M4：機器人支援四種策略、心跳、稽核紀錄。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CFG, ROOT_DIR } from "./helpers.mjs";

const R = await import("../bot/runner.mjs");
const S = await import("../bot/status-server.mjs");

const mk = (a) => a.map((p, i) => [i * 3600000, p, p, p, p, 1, 0]);
const GCD = { upper: 104, lower: 100, grids: 4, perGrid: 100, geo: false };
const DCFG = { first: 1000, addAmount: 500, dropPct: 10, mult: 1, maxAdds: 3, takeProfitPct: 5 };

test("config 支援四種策略：A、B、grid、dca", () => {
  assert.deepEqual(R.STRATEGIES, ["A", "B", "grid", "dca"]);
  const a = R.validateStrategyConfig({ ...DEFAULT_CFG, strategy: "A" });
  assert.equal(a.ok, true);
  assert.equal(a.kind, "A");
  const b = R.validateStrategyConfig({ ...DEFAULT_CFG, strategy: "B" });
  assert.equal(b.kind, "B");
  const g = R.validateStrategyConfig({ strategy: "grid", ...GCD });
  assert.equal(g.ok, true);
  assert.equal(g.kind, "grid");
  const d = R.validateStrategyConfig({ strategy: "dca", ...DCFG });
  assert.equal(d.ok, true);
  assert.equal(d.kind, "dca");
});

test("config 非法：上界 ≤ 下界要擋", () => {
  const g = R.validateStrategyConfig({ strategy: "grid", upper: 90, lower: 100, grids: 4, perGrid: 100 });
  assert.equal(g.ok, false);
  assert.match(g.errors.upper, /上界要大於下界/);
});

test("網格：往下穿格線進場，往上穿賣出", () => {
  const down = R.decideGrid(GCD, mk([103, 102]), { position: null });
  assert.equal(down.action, "enter");
  assert.match(down.why, /網格買入/);
  const state = { position: { kind: "grid", lots: [{ price: 102, qty: 100 / 102 }], invested: 100, avg: 102 } };
  const up = R.decideGrid(GCD, mk([102, 103]), state);
  assert.equal(up.action, "exit");
  assert.match(up.why, /網格賣出/);
});

test("網格：PAUSE 時不買", () => {
  const d = R.decideGrid(GCD, mk([103, 102]), { position: null, paused: true });
  assert.equal(d.action, "none");
  assert.match(d.why, /PAUSE/);
});

test("定投：沒有持倉就下首單；跌到門檻就加碼；漲到停利就全平", () => {
  const start = R.decideDca(DCFG, mk([100]), { position: null });
  assert.equal(start.action, "enter");
  assert.match(start.why, /首單/);

  const pos = { kind: "dca", avg: 100, lastAddPx: 100, adds: 0, invested: 1000, qty: 10, legs: [] };
  const add = R.decideDca(DCFG, mk([89]), { position: pos });
  assert.equal(add.action, "enter");
  assert.match(add.why, /加碼 1/);

  const tp = R.decideDca(DCFG, mk([106]), { position: pos });
  assert.equal(tp.action, "exit");
  assert.match(tp.why, /停利/);
  assert.equal(tp.all, true);
});

test("定投：加碼次數用完就只 Hold", () => {
  const pos = { kind: "dca", avg: 100, lastAddPx: 50, adds: 3, invested: 2500, qty: 30, legs: [] };
  const d = R.decideDca(DCFG, mk([40]), { position: pos });
  assert.equal(d.action, "hold");
});

test("心跳：tick 會寫 heartbeat.json，內容含毫秒與策略", async () => {
  await R.tick({
    cfgRes: { ok: true, kind: "A", cfg: DEFAULT_CFG },
    fetcher: async () => mk([100, 101, 102]),
    state: { position: null, equity: null, paused: false }
  });
  const hb = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "bot/state/heartbeat.json"), "utf8"));
  assert.ok(Number.isFinite(hb.ms));
  assert.equal(hb.strategy, "A");
});

test("心跳逾時：超過 180 秒判無回應", () => {
  // 偽造 181 秒前的心跳
  const p = path.join(ROOT_DIR, "bot/state/heartbeat.json");
  const backup = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  fs.writeFileSync(p, JSON.stringify({ t: "2026-11-01T00:00:00Z", ms: Date.now() - 181000 }));
  const st = S.heartbeatStatus();
  assert.equal(st.alive, false);
  assert.equal(st.stale, true);
  if (backup !== null) fs.writeFileSync(p, backup);
});

test("心跳新鮮：180 秒內判有回應", () => {
  const p = path.join(ROOT_DIR, "bot/state/heartbeat.json");
  const backup = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  fs.writeFileSync(p, JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - 1000 }));
  const st = S.heartbeatStatus();
  assert.equal(st.alive, true);
  assert.equal(st.stale, false);
  if (backup !== null) fs.writeFileSync(p, backup);
});

test("status API 回傳 lastHeartbeat 與 botAlive", () => {
  const s = S.buildStatus();
  assert.ok("lastHeartbeat" in s);
  assert.ok("botAlive" in s);
});

test("稽核紀錄：Telegram 指令寫進 journal，type 為 cmd", () => {
  const p = path.join(ROOT_DIR, "bot/state/journal.ndjson");
  const backup = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if (fs.existsSync(p)) fs.unlinkSync(p);
  R.auditCmd("/stopentry");
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "cmd");
  assert.equal(lines[0].cmd, "/stopentry");
  if (backup !== null) fs.writeFileSync(p, backup); else fs.unlinkSync(p);
});

test("atomicWrite 使用同目錄 .tmp 再 rename（跨檔系統安全）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alice-hb-"));
  const f = path.join(dir, "a.json");
  R.atomicWrite(f, { x: 1 });
  assert.equal(fs.existsSync(f + ".tmp"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 1 });
});
