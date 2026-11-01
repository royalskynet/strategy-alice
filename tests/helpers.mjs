/** 載入 core/engine.js，回傳它的全部函式。環境無關，不碰 DOM。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = ROOT;

export function loadEngine() {
  const code = fs.readFileSync(path.join(ROOT, "core/engine.js"), "utf8")
    .replace(/\/\*CORE-BEGIN\*\//, "")
    .replace(/\/\*CORE-END\*\//, "");
  const factory = new Function(code + `
    return { sma, ema, movingAvg, to4h, backtestOn, periodBreakdown, lookaheadCheck,
             validateConfig, evaluateRegime, toBars, toBars4h, dayKey, B_TH,
             metricsOn, reportOn, gridCombos, objectiveScore, optimizeOn, OPT_MAX,
             gridBacktest, dcaBacktest, protectionWindows, inWindow, barsPerYear };`);
  return factory();
}

/** index.html 內嵌的示範資料 */
export function loadDemoBars() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = html.match(/var BARS = (\[\[.*?\]\]);/s);
  if (!m) throw new Error("index.html 找不到示範資料 BARS");
  const m2 = html.match(/var START_MS = (\d+);/);
  return { bars: JSON.parse(m[1]), startMs: Number(m2[1]) };
}

/** 預設參數（與網頁預設值一致） */
export const DEFAULT_CFG = {
  fast: 20, slow: 60, sl: 2, tp: 4, stake: 1000, cap: 300,
  trailStart: 3, trailDist: 1, maxHold: 0, equity: 1000,
  fee: 0, slip: 0, cool: 0, ddStop: 0,
  maType: "sma", tf: "1h", revExit: true, trail: false
};

export function demoClock(startMs) {
  return (h) => startMs + h * 3600000;
}
