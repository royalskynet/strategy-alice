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
process.exit(r.status === 0 ? 0 : 1);
