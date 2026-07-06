# TRON Toolbox

[English](README.md) | **中文**

实用 TRON 命令行工具合集：资产看板、入账报表、JustLend 清算风险监控、投票收益自动领取、测试网能量消耗器。零框架、Node 18+，大部分工具零依赖（只用内置 `fetch`）。

由 [FableEnergy](https://fableenergy.xyz) 团队维护 —— TRON 能量租赁平台，USDT 转账手续费立省 70%。

## 工具一览

| 工具 | 需要私钥 | 依赖 | 说明 |
|---|---|---|---|
| `tron-asset-summary.mjs` | ❌ 只读 | 无 | 多钱包 TRX/USDT/USDD 资产汇总 + JustLend 仓位 + 历史走势 + HTML 报表 |
| `tron-income-report.mjs` | ❌ 只读 | 无 | 每日 × 钱包 TRX 入账矩阵，导出 CSV + 可筛选 HTML |
| `justlend-health-watch.mjs` | ❌ 只读 | 无 | JustLend V1/V2 借币仓位风险系数监控，接近清算时发 Telegram 告警 |
| `claim-vote-rewards.mjs` | ⚠️ 需要 | tronweb | 自动领取投票（SR）分红，支持多钱包、daemon 定时、受限权限多签 |
| `burn-energy.mjs` | ⚠️ 需要 | tronweb | 测试网快速烧掉钱包全部能量（测试委托/回收流程用） |

## 快速开始

```bash
git clone <this-repo> && cd tron-toolbox
npm ci                         # 只有 claim-vote-rewards / burn-energy 需要；使用 package-lock.json 锁定版本

cp wallets.txt.example wallets.txt      # 填入你的地址
cp .env.example .env                    # 按需填 API Key / TG Token

node tron-asset-summary.mjs --html      # 资产看板
node tron-income-report.mjs             # 入账报表
node justlend-health-watch.mjs --dry    # 风险监控（只打印）
```

## 各工具用法

### 资产汇总 `tron-asset-summary.mjs`

只读，无需私钥。地址来自 `wallets.txt`（可跟别名：`T… 主钱包`）；借币地址可选 `lend-wallets.txt`。行情 Binance → OKX → CoinGecko 三级兜底。每次运行追加历史快照，`--html` 生成带走势图的自包含网页。

### 入账报表 `tron-income-report.mjs`

只读。统计 `wallets.txt` 各地址在 `START_DATE` 至今的 TRX 入账（可选 `senders.txt` 只统计指定发送方，适合对账），含投票分红领取。输出终端表格 + CSV + 可筛选 HTML。

### JustLend 风险监控 `justlend-health-watch.mjs`

只读。SBM V2 风险系数 ≥ 0.92（1=清算）或 V1 健康因子 ≤ 1.05 时发 Telegram 告警，带冷却与恢复通知。`--daemon` 常驻轮询（默认 10 分钟），`--test-notify` 测试推送。

### 投票收益领取 `claim-vote-rewards.mjs`

⚠️ 需要私钥（`PRIVATE_KEYS` 环境变量或 `keys.txt`，建议 `chmod 600`，只在自己可控的机器上运行）。链上每账户 24h 限领一次；单钱包可领 ≥ `CLAIM_MIN_REWARD_TRX`（默认 100 TRX）才执行；推荐 crontab 每 2 天检查，或 `--daemon` 按 `CLAIM_CHECK_INTERVAL_H`（默认 48h）轮询。私钥若是账户的受限 active 权限（权限位含 13 WithdrawBalance），设 `PERMISSION_ID` 走多签。

### 测试网能量消耗 `burn-energy.mjs`

⚠️ 需要私钥，**默认仅允许测试网**。通过并发部署垃圾合约把可用能量清零。若 `TRON_FULL_HOST` 指向主网，脚本会**拒绝运行**，除非显式加 `--i-know-mainnet`（会真实烧掉质押能量并花 TRX 手续费）。

## 安全说明

### 通用

- 所有只读工具不接触私钥，只调公开 API（TronGrid / JustLend / 交易所行情）。
- `wallets.txt`、`keys.txt`、`.env` 均已列入 `.gitignore`，不会被误提交。
- 私钥类工具请自行审计代码后使用，风险自负（MIT License，no warranty）。

### 私钥使用

- `claim-vote-rewards.mjs` 建议用**受限 active 权限**（仅含权限位 13 WithdrawBalance）；多签受限权限时设置 `PERMISSION_ID`。
- `keys.txt` 建议 `chmod 600`；只在可控机器上存放私钥或环境变量。
- 签名类工具请谨慎选择 `TRON_FULL_HOST`（恶意 RPC 是行业通用风险）。

### 依赖安装

- 仓库已提交 `package-lock.json`；请用 **`npm ci`** 安装（不要用裸 `npm install`），确保 `tronweb` 版本与 lockfile 一致。
- 升级 `tronweb` 前请自行审查变更。

### JustLend V2 数据来源

- V2 仓位/风险系数来自 REST 镜像（`MOOLAH_V2_API`，默认 `https://zenvora.ablesdxd.link`）；V1 用 `openapi.just.network`。
- 可在 `.env` 用 `MOOLAH_V2_API` 或 `JUSTLEND_V2_API` 覆盖。
- **不要单独依赖** `justlend-health-watch.mjs` 做清算防护——API/预言机有分钟级滞后。

### `burn-energy.mjs` 主网拦截

- 默认 Nile 测试网；识别到主网主机时会拒绝，除非加 `--i-know-mainnet`。

## 为什么做这个

我们在运营 [FableEnergy](https://fableenergy.xyz)（TRON 能量租赁）过程中写了这些运维小工具，脱敏后开源。如果你经常转 USDT 被 13+ TRX 手续费困扰，欢迎试试能量租赁：**[fableenergy.xyz](https://fableenergy.xyz)** —— 按需租能量，转账成本立省约 70%。

## License

MIT
