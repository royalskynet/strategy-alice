#!/usr/bin/env node
/**
 * 唯讀狀態 API。只綁 127.0.0.1:8771，不接受 GET 以外的方法。
 *
 *   GET /api/state        持倉、權益、暫停狀態
 *   GET /api/journal      最近 N 筆（?limit=50，預設 50）
 *   GET /api/health       固定回 {ok:true}
 *
 * 唯讀：沒有任何寫入端點。控制只走 Telegram 或 bot/PAUSE 檔案。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "bot", "state");
const PAUSE = path.join(ROOT, "bot", "PAUSE");
const JOURNAL = path.join(STATE, "journal.ndjson");

const HOST = "127.0.0.1";
const PORT = 8771;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

export function buildStatus() {
  return {
    ok: true,
    now: new Date().toISOString(),
    paused: fs.existsSync(PAUSE),
    position: readJSON(path.join(STATE, "position.json"), null),
    equity: readJSON(path.join(STATE, "equity.json"), null)
  };
}

export function buildJournal(limit) {
  let lines = [];
  try { lines = fs.readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean); } catch (e) { return []; }
  return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(json);
}

export function handler(req, res) {
  if (req.method !== "GET") { send(res, 405, { ok: false, error: "只接受 GET" }); return; }
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/api/health") return send(res, 200, { ok: true });
  if (u.pathname === "/api/state") return send(res, 200, buildStatus());
  if (u.pathname === "/api/journal") {
    const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit")) || 50));
    return send(res, 200, { ok: true, items: buildJournal(limit) });
  }
  send(res, 404, { ok: false, error: "沒有這個路徑" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handler);
  server.listen(PORT, HOST, () => {
    console.log("狀態 API：http://" + HOST + ":" + PORT + "/api/state");
  });
}
