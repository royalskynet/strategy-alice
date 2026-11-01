# 策略 Alice — GUI 優化計劃

> 版本：2026-11-01（台灣時間）。狀態：等你回覆「同意」。
> 前提：第一階段 `index.html` 已推上 repo，而且四個測試都驗收通過，才開始本計劃。
> 與其他計劃的關係：
> - 本計劃只改外觀和版面，不改功能。
> - [`執行計劃.md`](執行計劃.md) 的輸入、輸出、提示文字、計算全部照舊。
> - [`第二階段計劃.md`](第二階段計劃.md) 新增的畫面要沿用本計劃產出的 `DESIGN.md`。
> 順序：以 [總執行計劃](總執行計劃.md) 為準（第一階段收尾 → 專業設定與K線 → 介面架構 → 真實行情 → GUI 優化）。

## 0. 摘要

用兩個熱門的 UI/UX skill 分工。

1. **ui-ux-pro-max** 產出設計系統（`DESIGN.md`），只跑一次。
2. **impeccable** 照設計系統審查、修改、打磨，直到確定性檢查通過。

最後重跑第一階段的四個測試，結果要和優化前逐字相同，用這個證明功能沒被改壞。

## 1. 選用的 skill（/wheel 裁決：採用）

**ui-ux-pro-max**（nextlevelbuilder/ui-ux-pro-max-skill｜★143.5k｜MIT｜10-31 有更新）
- 用途：產出設計系統。
- 依據：README 有 Fintech/Crypto 產業規則、192 組配色、74 組字體搭配、25 種儀表板圖表建議、119 條 UX 準則，也支援純 HTML。

**impeccable**（pbakaus/impeccable｜★98.5k｜Apache-2.0｜10-31 有更新）
- 用途：審查與迭代。
  - `critique`：UX 評分
  - `audit`：無障礙、效能、手機適配，問題分 P0–P3
  - `polish`：最後打磨
  - `harden`：處理溢出和邊界情況
  - `adapt`：調整手機尺寸
- `detect`：62 條確定性規則，不用 LLM、不用金鑰，可以掃純 HTML。

**備案：anthropics/skills 的 frontend-design**（官方，Apache-2.0）
- 只有在 pro-max 的結果太像模板時才用，用來重定美感方向。

**淘汰**
- huashu-design（★28k）：擅長從零生成，跟「改既有頁面」重疊。
- elayadesign/ai-design-skills（★13k）：目前只有 landing page 技能。
- gstack：整套 Claude Code 設定，不是設計 skill。

**意見衝突時誰優先**（上面贏）
1. 工作坊規則
2. 本計劃 §3 的交易介面硬規則
3. `DESIGN.md`
4. impeccable 的建議

## 2. 範圍

這一版做三件事：

1. **設計系統**：
   - 用 pro-max 產出 `DESIGN.md`：色彩（含漲跌色）、字體、間距、元件樣式。
   - 用 impeccable `init` 產出 `PRODUCT.md`：使用者是誰、工具的主要用途、限制。
2. **版面重排**：
   - 手機直式、單手可操作，最重要的結果不用捲動就看得到。
   - 版面分三區：輸入、結果、紀錄，層級清楚。
   - 數字用等寬字、右對齊。
3. **審查迴圈**：
   - 依序跑 `critique` → 修 P0／P1 → `audit` → 修 P0／P1 → `polish`。
   - `detect` 沒有錯誤等級的問題才算過。

不做：
- 改計算或邏輯
- 新增功能或欄位
- 改任何提示文字
- 改瀏覽器紀錄格式
- 雙主題切換
- 特效動畫（不用 `overdrive`）
- 外部字體或 CDN

## 3. 交易介面硬規則（skill 必須遵守）

- **漲跌色**：綠漲紅跌（加密貨幣交易所慣例），一律同時加 ▲▼ 或 +／− 符號，不能只靠顏色。
- **數字**：等寬字（tabular-nums），右對齊；百分比到小數兩位，大數字加千分位。
- **「示範資料」橫幅**：維持最高視覺層級，設計上不能把它弱化。
- **結果只陳述事實**：不加「買進」「賣出」這類行動色塊或按鈕。
- **無障礙**：文字對比至少達 WCAG AA；按鈕和輸入框觸控區至少 44×44 px。
- **單檔、不連網**：只用系統字體堆疊，CSS 全部寫在 `index.html` 裡。
- **禁止 AI 模板感**：不要紫藍漸層、卡片套卡片、每個標題上方放圓角圖示。`detect` 會抓這些。

## 4. 安裝、秘密、對外動作

- **安裝**：要安裝兩個 skill，這正是第一階段規定「先停下來說明」的那一步。你回「同意」＝核准安裝。
  - ui-ux-pro-max：在 Claude Code 用 `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`，再 `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`。
  - impeccable：`npx impeccable install`，再在 agent 裡跑 `/impeccable init`。
  - 安裝程式產生的 skill 檔（例如 `.claude/`、`.agents/` 目錄）不 commit。repo 只 commit §7 列的檔案。
- **`npx impeccable detect`**：會下載套件到本機執行，只掃本機檔案，不上傳。
- **秘密**：不需要任何帳號、金鑰、密碼或付費服務。
- **對外**：不下單、不發訊息、不自己放上網路。

## 5. 執行步驟

1. **留底**：
   - 記下第一階段的 commit hash（下稱 base）。
   - 截一張手機寬度 390px 的畫面。
   - 抄下四個測試的實際輸出，作為對照。
2. **安裝**：照 §4 裝兩個 skill。
3. **產出設計系統**：
   - 給 pro-max 的描述：「加密貨幣策略回測與紙上交易工具，手機優先，繁體中文，使用者是每天交易的個人交易者」。
   - 結果先套用 §3 的硬規則，再寫成 `DESIGN.md`。
4. **產出產品說明**：跑 `/impeccable init`，產出 `PRODUCT.md`。
5. **改外觀**：照 `DESIGN.md` 改 `index.html` 的 CSS 和 HTML 結構。
   - 所有 `id` 保留。
   - `<script>` 區塊一個字都不動。
   - 如果非改 JS 不可，先停下來回報。
6. **審查迴圈**：照 §2 第 3 點的順序跑。每輪記下 critique 分數和 P0／P1 數量。
7. **回歸測試**：第一階段四個測試原樣重跑。
8. **commit**：只 commit §7 的檔案，推 `main`。

## 6. 驗收（每一項都能失敗）

- **功能沒變**：`<script>` 區塊和 base 完全相同。在 repo 根目錄跑這條，沒有任何輸出才算過：

  ```bash
  diff <(git show <base>:strategy-alice/index.html | sed -n '/<script/,/<\/script>/p') <(sed -n '/<script/,/<\/script>/p' strategy-alice/index.html)
  ```

- **回歸**：四個測試的數字和提示文字，和步驟 1 抄下的逐字相同。
- **檢查**：`npx impeccable detect strategy-alice/index.html` 沒有錯誤等級的問題，原始輸出貼進回報。
- **分數**：附上 critique 優化前後的分數，以及 audit 剩下的 P0／P1 數量（P0 必須是 0）。
- **手機**：附上 390px 寬的截圖，最上方的結果不用捲動就看得到。

## 7. 會建立或修改的檔案

只在 `strategy-alice/` 裡：

- `index.html`：修改，只改外觀
- `DESIGN.md`：新增
- `PRODUCT.md`：新增
- `GUI優化計劃.md`：本檔

## 8. 未驗證

- pro-max 執行時要不要 Python，以及 M2 上的版本夠不夠。
- `impeccable detect` 的結束碼代表什麼。目前先以原始輸出判斷。
- impeccable 安裝時實際會寫進專案資料夾哪些檔。裝完先列出來，確認不會被 commit。
- Condor 的 `/web` 不在本計劃範圍。上游的介面不改。
