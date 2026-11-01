# 策略 Alice

BTC-USDT 現貨的**回測、盤況判讀與紙上（模擬）自動交易**工具。單一 HTML 檔，打開就能用，不需要帳號、不需要金鑰。

線上版：https://strategy-alice.vercel.app

## 這個工具做什麼

| 分頁 | 內容 |
|---|---|
| 總覽 | 機器人狀態、今日損益、目前持倉、四旗標、最近成交 |
| 策略 | A 均線交叉、B 盤況、網格、DCA 定投 四種，可手動調參或套預設 |
| 回測 | K 線圖回放、14 項專業指標、回撤曲線、交易明細、CSV 匯出 |
| 機器人 | 本機紙上機器人的狀態、心跳、指令紀錄 |
| 比較 | 存下來的结果、參數最佳化（樣本內／樣本外）、紙上計數 |

## 三條指令

```bash
node tools/build.mjs        # 把 core/engine.js 內嵌進 index.html
node tools/test-all.mjs     # build 檢查 → 72 項單元測試 → E2E 與無障礙
node bot/runner.mjs         # 啟動紙上機器人（每 60 秒看一次真實行情）
```

E2E 需要 Playwright，裝在 repo 外：

```bash
mkdir -p /tmp/alice-e2e && cd /tmp/alice-e2e && npm i playwright @axe-core/playwright
```

沒裝時 `test-all` 會印 `E2E SKIPPED` 並以 exit 2 結束，**不算通過**。

## 功能對照表

「我們有」指這個 repo 已實作且測試通過。成熟產品指 freqtrade／FreqUI、Hummingbot Dashboard、交易所內建機器人、TradingView 策略測試器。

### 有的

| 功能 | 說明 |
|---|---|
| 均線交叉回測 | SMA／EMA、停損停利、移動停損、冷卻、每日虧損上限、回撤停機 |
| 盤況四旗標 | 與 `btc_watch.py` 逐筆比對，821/821 一致 |
| 專業指標 | 夏普、索提諾、卡瑪、年化、期望值、平均賺賠、最長連勝連敗、持倉占比、買進持有比較 |
| 回撤曲線 | 畫在資產曲線下方，共用時間軸 |
| 參數最佳化 | 2 參數網格、上限 400 組、前 70% 找最佳、後 30% 驗證、過度擬合警示 |
| 網格策略 | 紙上，已實現／未實現／成交次數 |
| DCA 定投 | 紙上，首單＋倍數加碼＋整體停利 |
| 保護機制 | 連續停損暫停、低獲利暫停 |
| 紙上機器人 | A／B／網格／DCA、心跳、稽核紀錄、12 個 Telegram 指令 |
| 真實行情 | Binance 公開端點，免金鑰 |
| 無障礙 | axe WCAG 2.1 AA，五分頁 serious＋critical 為 0 |

### 刻意不做的

| 功能 | 不做的理由 |
|---|---|
| 實盤下單、轉帳 | 錢的事不能交給沒有風控審查的程式。真要做需要 API 權限設計、提領關閉、IP 白名單、獨立稽核，這些是另一個專案 |
| 對外接 webhook（TradingView 訊號） | 要對外開放接收端口，等於把自己放上網路，違反這個工具「本機、唯讀」的前提 |
| 多幣種同時跑 | 風控要按幣種分開算，還要做資金分配；單幣種先做對 |
| 槓桿、放空 | 爆倉風險跟回測模型完全不同，需要強平價、資金費率、維持保證金 |
| AI 選參數 | 無法驗證，也無法解釋為什麼選這組，等於黑箱下單 |
| 複製 FreqUI 程式碼 | GPL 授權，不能併進來 |

## 安全

- 不需要 API key，程式裡沒有、也不會要。
- 機器人只做紙上交易，`bot/exec/live.mjs` 的每個函式都直接拋「實盤未開放」。
- 測試全程用 mock，不會對真實 Telegram 送出任何請求。
- 狀態 API 只綁 127.0.0.1，只讀。

## 免責

本工具僅供個人輔助參考，不構成投資建議。

## 授權與致謝

- K 線圖：[lightweight-charts](https://github.com/tradingview/lightweight-charts) 5.2.1（Apache-2.0），已內嵌。
- 機器人 Telegram 指令命名參考 [freqtrade](https://www.freqtrade.io/) 的公開文件。
