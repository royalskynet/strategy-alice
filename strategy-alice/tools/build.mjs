#!/usr/bin/env node
/**
 * 把 core/engine.js 內嵌進 index.html 的 CORE-BEGIN 到 CORE-END 標記之間。
 *
 * 用法：
 *   node tools/build.mjs          寫入 index.html
 *   node tools/build.mjs --check  只檢查，不寫入；不一致就 exit 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "core/engine.js");
const HTML = path.join(ROOT, "index.html");

const BEGIN = "/*CORE-BEGIN*/";
const END = "/*CORE-END*/";

export function extractCore(html) {
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error("index.html 找不到 CORE-BEGIN / CORE-END 標記");
  return { start: a, end: b + END.length, text: html.slice(a, b + END.length) };
}

export function buildCore() {
  const engine = fs.readFileSync(ENGINE, "utf8").trim();
  if (!engine.startsWith(BEGIN) || !engine.endsWith(END)) {
    throw new Error("core/engine.js 必須以 " + BEGIN + " 開頭、" + END + " 結尾");
  }
  return engine;
}

function readHtml() { return fs.readFileSync(HTML, "utf8"); }

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  const html = readHtml();
  const { start, end } = extractCore(html);
  const core = buildCore();
  const next = html.slice(0, start) + core + html.slice(end);
  if (check) {
    if (next !== html) {
      console.error("FAIL：index.html 的 CORE 區塊與 core/engine.js 不一致，請跑 node tools/build.mjs");
      process.exit(1);
    }
    console.log("OK：CORE 區塊與 core/engine.js 逐字相同（" + core.length + " bytes）");
  } else {
    fs.writeFileSync(HTML, next);
    console.log("已寫入 index.html（CORE " + core.length + " bytes）");
  }
}
