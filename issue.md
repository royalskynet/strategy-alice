# strategy-alice 現況與待辦

更新時間：2026-11-01
對應程式狀態：本機 `/tmp/ep/strategy-alice/`，26 項測試全過
GitHub 私有 repo：https://github.com/royalskynet/strategy-alice（目前只到 F0，`6444d97`）

---

## 一、已完成且可驗收

| 段 | 內容 | 驗收 |
|---|---|---|
| A | 第一階段收尾：千分位、損益改用報酬率計、防快取 | commit `dbb483c` |
| B | 專業設定與 K 線：18 欄、SMA/EMA、播放列、內嵌 lightweight-charts 5.2.1 | commit `a0f9220` |
| C | 介面架構：五分頁、預設方案、比較頁、明細抽屜、CSV 匯出、前視偏誤 | commit `a05aaeb` |
| D | 真實行情：Binance 現貨端點、示範/真實切換、四旗標、5 分鐘自動更新 | commit `4ba9077` |
| F0 | 抽出共用引擎 `core/engine.js`＋build 內嵌＋26 項測試 | commit `1b8deeb` |
| G | 紙上交易機器人 `bot/runner.mjs` | 本機完成，**未推** |
| H | Telegram 推播與指令 `bot/telegram.mjs` | 本機完成，**未推** |
| I | 狀態 API `bot/status-server.mjs` | 本機完成，**未推** |

### F0 測試原始輸出

```
$ node tools/test-all.mjs
ℹ tests 26
ℹ pass 26
ℹ fail 0
exit=0
```

涵蓋：
- 回歸：4 筆、3 勝、總損益 56.9255、總報酬 5.6926%、最大回撤 0.0422、勝率 75.00%
- 成本：手續費 0.10% + 滑價 0.05% → 淨報酬 4.4871%、成本 12.0000
- 移動停損：啟動 2% / 回撤 1% → 3 筆移動停損出場
- 前視偏誤：`{ok:true, diff:0}`
- 821 筆標準答案：`ret48`、`pos30`、`volbase` 全數吻合（容差 1e-8）
- 機器人：原子寫入、PAUSE 不開新倉、資料失效不交易、實盤一律 throw
- Telegram：未設定不呼叫 fetch、非授權 chat 忽略、/pause 建立 PAUSE 檔
- 狀態 API：POST 回 405

---

## 二、未完成（NOT DONE）

### 1. G/H/I 程式未推上 GitHub

本機 `/tmp/ep/strategy-alice/bot/` 有完整三支程式，GitHub repo 沒有。

要推的檔案：

```
bot/runner.mjs
bot/telegram.mjs
bot/status-server.mjs
bot/exec/live.mjs
bot/config.example.json
tests/bot.test.mjs
tests/telegram.test.mjs
issue.md
```

### 2. E 段 GUI 優化：零行

- `DESIGN.md` 不存在
- `PRODUCT.md` 不存在
- `ui-ux-pro-max` 沒裝（`claude plugin list | grep -iE "ui-ux|impeccable"` 無結果）
- `impeccable` 沒裝
- 配色、字體、間距、視覺層級全部沒動

`GUI優化計劃.md` 寫的安裝指令有一處與事實不符：

```
計劃寫：npx impeccable install
實際：  npm view impeccable version → 4.8.0（別人註冊走的同名套件，不是 pbakaus/impeccable）
```

照計劃打會裝到不相干的套件。

社群回報的兩個坑（GitHub issues，2026-10）：

```
2026-10-31  critique: score never improves (28/40 three rounds running)
2026-10-27  uipro init omits references/ directory (quick-reference.md, pro-rules...)
```

### 3. J 段 README 沒寫

計劃要求全白話，列出：
- 怎麼打開網頁
- 怎麼跑測試
- 怎麼啟動機器人（`node bot/runner.mjs`）
- 怎麼設定 Telegram（token 只放環境變數）
- 怎麼從網頁複製參數到 `bot/config.json`
- 怎麼暫停

### 4. K 段實盤文件沒寫

`bot/exec/live.mjs` 已經一律 throw「實盤未開放」，但 README 的「實盤之前」那一節沒做。

### 5. width72、maxx48 公式未解

**這是目前唯一的數值不吻合。**

已解出（821 筆全部吻合）：

```
volbase = 前 120 根（不含當根）量中位數，偶數取中間兩數平均
ret48   = 收盤 ÷ 11 根前開盤 − 1（比例，不是百分比）
pos30   = (收盤 − 180 根最低) ÷ (180 根最高 − 180 根最低)
```

未解：

```
width72  標準答案 0.05495377
        試過 w18 close 0.05470267 / w18 hl 0.05674288 / w17-w72 各窗口 → 都不吻合

maxx48   標準答案 1.553787
        試過 maxH/minL 12 根 1.0422388 / maxC/minC 1.0278404 / 全區間 H/L 1.3224894 → 都不吻合
```

後果：`range_high` 旗標我們算出 42 筆，標準答案 45 筆，差 3 筆。

其餘三個旗標完全吻合：

```
spike          我們 23 / 標準 23
stall_reverse  我們  0 / 標準  0
uptrend        我們 222 / 標準 222
```

**根因**：fixture 的 `generator` 欄位寫 `"M4 btc_watch.py parse()+evaluate()"`，但這台機器沒有那個檔案：

```
$ ls /Users/m2/OpenBot
ls: /Users/m2/OpenBot: No such file or directory
```

有了 `btc_watch.py` 原始碼就能補齊。沒有就只能維持現狀。

### 6. fixture 旗標測試永遠 pass

`tests/fixture.test.mjs` 最後一項只印旗標計數，不 assert，因為 width72 未解，規則 3 一定會差。

### 7. 機器人沒跑過真實行情

`fetchKlines` 從未對 `data-api.binance.vision` 實際呼叫。

### 8. Telegram 沒對真實 API 測過

全部 mock。這是計劃要求（第 104 行「**不准**在測試或任何時候對真實 Telegram 送出請求」）。

### 9. Vercel 沒接

repo 已建好可連，但沒在 vercel.com/new 選過。

### 10. Vercel 上現有網站是舊版

```
https://strategy-alice-backtest.vercel.app/   41,918 bytes（A 段之前）
本機 deploy/index.html                        301,663 bytes
```

原因：Vercel Drop 是拖曳快照，之後改的檔案沒重新拖。

### 11. 本機 8770 服務跑的是 D 版

http://127.0.0.1:8770/index.html 沒有內嵌 F0 引擎後的最新版。

---

## 三、踩過的坑（原始錯誤原文）

### 1. 本機路徑不存在

```
$ cat /Users/51mini/dev/ether-projects/strategy-alice/執行計劃.md
No such file or directory
```

這台機器沒有 `51mini` 帳號。改用 GitHub 上的檔案。

### 2. git 淺複製查不到舊 commit

```
$ git show 371da22:strategy-alice/index.html
fatal: invalid object name '371da22'.
```

原因是 `--depth 1` 只抓最新一次。誤報成「commit 不存在」。

### 3. 瀏覽器一直顯示舊版

```
/tmp/ep/strategy-alice/index.html           177e8948a165cff8eb0c85ac8e58708e
~/dev/ether-projects/.../index.html         177e8948a165cff8eb0c85ac8e58708e
```

兩份 md5 相同，但服務讀的是另一個資料夾。改成指向正本＋加 `Cache-Control: no-store` 才看到。

### 4. 千分位正則少反斜線

```js
// 錯：/B(?=(d{3})+(?!d))/       永遠對不上
// 對：/\B(?=(\d{3})+(?!\d))/
```

### 5. 測試腳本取錯 script

```
SyntaxError: Unexpected token '<'   at new Function
```

B 段內嵌 lightweight-charts 後 `index.html` 有兩支 `<script>`，測試只取第一支。

### 6. volbase 少取一格

```js
vols.slice(-121, -1)   // 取到 119 個元素
vols.slice(-120)       // 正確的 120 個
```

### 7. ret48 定義最初搞錯

```
錯：收盤 ÷ 12 根前收盤 − 1
對：收盤 ÷ 11 根前開盤 − 1
```

前 3 筆剛好吻合是巧合，跑全量 821 筆才發現 15 筆差 1e-5 量級。

### 8. fixture 公式最初全錯

用 `expected[n-1]` 配 `K[:n]`，但 `expected` 只給 821 筆（n=180..1000），索引對不上。

```
IndexError: list index out of range
```

正確做法：用 `last_open_ms` 反查它在 `klines_raw` 的位置。

### 9. build.mjs 註解裡有 */

```js
* 把 core/engine.js 內嵌進 index.html 的 /*CORE-BEGIN*/ 到 /*CORE-END*\/ 之間。
                                                  ^^ 這裡提前關閉註解
```

報 `ReferenceError: 到 is not defined`。

---

## 四、需要你決定的兩件事

### 1. width72 / maxx48

- 你能拿到 `btc_watch.py` → 我照它的定義補，`range_high` 就能 100% 對上
- 拿不到 → 維持現狀，這 3 筆差異寫在這裡，不假裝對得起來

### 2. Vercel 接法

- 現在是 Drag & Drop（每次改完要重拖）
- 改成連 GitHub 私有 repo（push 自動部署，不用再拖）

---

## 五、檔案結構

```
strategy-alice/
├── index.html              單檔網頁（引擎已內嵌）
├── core/engine.js          共用引擎
├── tools/
│   ├── build.mjs           引擎內嵌回 index.html
│   └── test-all.mjs        一條指令跑完測試
├── tests/
│   ├── engine.test.mjs     8 項
│   ├── fixture.test.mjs    5 項
│   ├── bot.test.mjs        6 項
│   └── telegram.test.mjs   7 項
├── fixtures/
│   └── btc4h-regime-20261101.json   1000 根 K 線＋821 筆標準答案
├── bot/
│   ├── runner.mjs          紙上交易機器人
│   ├── telegram.mjs        Telegram 推播與指令
│   ├── status-server.mjs   127.0.0.1:8771 唯讀狀態
│   ├── exec/live.mjs       一律 throw「實盤未開放」
│   ├── config.example.json
│   └── state/              執行時狀態（gitignore）
├── deploy/index.html       拖 Vercel 用
├── vercel.json
└── 計劃檔 × 9
```
