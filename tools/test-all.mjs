#!/usr/bin/env node
/** 一條指令跑完全部測試。exit 0 = 全過。 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(path.join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join("tests", f));

const build = spawnSync(process.execPath, ["tools/build.mjs", "--check"], { cwd: ROOT, stdio: "inherit" });
if (build.status !== 0) { console.error("build --check 失敗"); process.exit(1); }

const r = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, stdio: "inherit" });
if (r.status !== 0) { console.error("單元測試失敗"); process.exit(1); }

// E2E：偵測不到 Playwright 時 e2e.mjs 會印 E2E SKIPPED 並 exit 2，這裡照傳，不算通過
const e2e = spawnSync(process.execPath, ["tools/e2e.mjs"], { cwd: ROOT, stdio: "inherit" });
if (e2e.status === 2) { console.error("E2E SKIPPED：沒有 Playwright，這不算通過"); process.exit(2); }
if (e2e.status !== 0) { console.error("E2E 失敗"); process.exit(1); }
process.exit(0);
