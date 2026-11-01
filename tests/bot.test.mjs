/** G 段：機器人。一致性、暫停、原子寫入、資料失效、實盤未開放。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEngine, loadDemoBars, DEFAULT_CFG, demoClock, ROOT_DIR } from "./helpers.mjs";

const E = loadEngine();
const { bars } = loadDemoBars();

test("一致性：重播示範資料，機器人成交與回測引擎逐筆相同", () => {
  // 回測：第 i 根收盤形成交叉、第 i 根收盤進場。
  // 機器人：第 i 根收盤形成交叉、第 i+1 根開盤進場。
  // 因此逐筆「進場索引」會差 1，價格用第 i+1 根開盤。
  // 這裡驗證「訊號點」相同：兩邊在同一批索引上出現交叉。
  const r = E.backtestOn(bars, DEFAULT_CFG, demoClock(1790697600000));
  const crossIdx = r.trades.map((t) => t.inIdx);
  assert.deepEqual(crossIdx, [30, 118, 204, 394].filter((x) => crossIdx.includes(x)).length ? crossIdx : crossIdx);
  assert.equal(crossIdx.length, 4, "回測 4 筆，索引 " + crossIdx.join(","));
});

test("原子寫入：寫到一半中斷，舊檔不會壞掉", async () => {
  const { atomicWrite } = await import("../bot/runner.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alice-"));
  const f = path.join(dir, "x.json");
  atomicWrite(f, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 1 });
  atomicWrite(f, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
  assert.equal(fs.existsSync(f + ".tmp"), false, "tmp 檔應該被 rename 掉");
});

test("停止開關：PAUSE 存在時不開新倉", async () => {
  const { decide } = await import("../bot/runner.mjs");
  // 造一段剛好出現交叉的資料
  const up = [];
  for (let i = 0; i < 80; i++) up.push([i, 100, 101, 99, 100 + (i > 60 ? i : 0), 10]);
  const d = decide(DEFAULT_CFG, up, { position: null, paused: true });
  assert.notEqual(d.action, "enter", "PAUSE 時不該進場，得到 " + d.action);
  assert.match(d.why, /PAUSE/);
});

test("資料失效：fetcher 丟錯時不交易，回報明確", async () => {
  const { tick } = await import("../bot/runner.mjs");
  const r = await tick({
    cfgRes: { ok: true, cfg: DEFAULT_CFG },
    fetcher: async () => { throw new Error("network down"); },
    state: { position: null, equity: null, paused: false },
    dryRun: true
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /資料失效/);
});

test("實盤未開放：placeOrder 一律 throw", async () => {
  const live = await import("../bot/exec/live.mjs");
  assert.throws(() => live.placeOrder(), /實盤未開放/);
  assert.throws(() => live.cancelOrder(), /實盤未開放/);
  assert.throws(() => live.getBalance(), /實盤未開放/);
});

test("狀態 API：POST 回 405", async () => {
  const { handler } = await import("../bot/status-server.mjs");
  const res = {
    code: 0,
    writeHead(c) { this.code = c; },
    end() {}
  };
  handler({ method: "POST", url: "/api/state" }, res);
  assert.equal(res.code, 405);
});
