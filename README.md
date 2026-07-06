# TRON Toolbox

**English** | [中文](README.zh-CN.md)

Practical TRON command-line tools: multi-wallet asset dashboard, TRX income report, JustLend liquidation-risk monitor with Telegram alerts, vote-reward auto-claimer, and a testnet energy burner. Zero frameworks, Node 18+, and most tools have zero dependencies (built-in `fetch` only).

Maintained by the [FableEnergy](https://fableenergy.xyz) team — a TRON energy rental platform that cuts USDT transfer fees by up to ~70%.

## Tools

| Tool | Private key | Dependencies | Description |
|---|---|---|---|
| `tron-asset-summary.mjs` | ❌ read-only | none | Multi-wallet TRX/USDT/USDD summary + JustLend positions + history charts + HTML report |
| `tron-income-report.mjs` | ❌ read-only | none | Daily × wallet TRX income matrix; exports CSV + filterable HTML |
| `justlend-health-watch.mjs` | ❌ read-only | none | JustLend V1/V2 borrow-position risk monitor; Telegram alerts near liquidation |
| `claim-vote-rewards.mjs` | ⚠️ required | tronweb | Auto-claim vote (SR) rewards; multi-wallet, daemon mode, restricted-permission multisig |
| `burn-energy.mjs` | ⚠️ required | tronweb | Burn all wallet energy on testnet (for testing delegate/reclaim flows) |

## Quick start

```bash
git clone <this-repo> && cd tron-toolbox
npm ci                         # only needed for claim-vote-rewards / burn-energy; uses package-lock.json

cp wallets.txt.example wallets.txt      # add your addresses
cp .env.example .env                    # API keys / TG token as needed

node tron-asset-summary.mjs --html      # asset dashboard
node tron-income-report.mjs             # income report
node justlend-health-watch.mjs --dry    # risk monitor (print only)
```

## Usage

### Asset summary — `tron-asset-summary.mjs`

Read-only; no private key. Addresses come from `wallets.txt` (optional alias: `T… main wallet`). Borrowing addresses are optional via `lend-wallets.txt`. Prices: Binance → OKX → CoinGecko fallback. Each run appends a history snapshot; `--html` generates a self-contained page with charts.

### Income report — `tron-income-report.mjs`

Read-only. Counts TRX inflows per address in `wallets.txt` from `START_DATE` to now (optional `senders.txt` to filter by sender — useful for reconciliation), including claimed vote rewards. Outputs terminal table + CSV + filterable HTML.

### JustLend risk monitor — `justlend-health-watch.mjs`

Read-only. Sends Telegram alerts when SBM V2 risk factor ≥ 0.92 (1 = liquidation) or V1 health factor ≤ 1.05, with cooldown and recovery notifications. `--daemon` for continuous polling (default 10 min); `--test-notify` to test push.

### Vote reward claimer — `claim-vote-rewards.mjs`

⚠️ Requires private key (`PRIVATE_KEYS` env var or `keys.txt`; use `chmod 600`, run only on machines you control). On-chain limit: one claim per account per 24h; Claims only when reward ≥ `CLAIM_MIN_REWARD_TRX` (default 100 TRX); use crontab every 2 days or `--daemon` for periodic checks (`CLAIM_CHECK_INTERVAL_H`, default 48). If the key is a restricted active permission (bit 13 WithdrawBalance), set `PERMISSION_ID` for multisig.

### Testnet energy burner — `burn-energy.mjs`

⚠️ Requires private key; **testnet only by default**. Clears available energy by deploying junk contracts in parallel. Mainnet hosts are **blocked** unless you pass `--i-know-mainnet` (you will burn real staked energy and TRX fees).

## Security

### General

- Read-only tools never touch private keys; they only call public APIs (TronGrid / JustLend / exchange tickers).
- `wallets.txt`, `keys.txt`, and `.env` are in `.gitignore` and will not be committed by mistake.
- Audit private-key tools before use; use at your own risk (MIT License, no warranty).

### Private keys

- Prefer **restricted active keys** with only `WithdrawBalance` (permission bit 13) for `claim-vote-rewards.mjs`; set `PERMISSION_ID` when using multisig restricted permissions.
- Run `chmod 600 keys.txt`; only use env vars / key files on machines you control.
- Treat `TRON_FULL_HOST` as a trust decision for signing tools (standard evil-RPC risk).

### Dependencies

- `package-lock.json` is committed; install with **`npm ci`** (not bare `npm install`) so `tronweb` resolves to the pinned version.
- Review `tronweb` upgrades before bumping the lockfile.

### JustLend V2 data source

- V2 position / risk data comes from a REST mirror (`MOOLAH_V2_API`, default `https://zenvora.ablesdxd.link`); V1 uses `openapi.just.network`.
- Override via `MOOLAH_V2_API` or `JUSTLEND_V2_API` in `.env` if you run your own endpoint.
- Do **not** rely solely on `justlend-health-watch.mjs` for liquidation protection — API/oracle lag is minutes, not block-time.

### `burn-energy.mjs` mainnet guard

- Defaults to Nile testnet. Known mainnet hosts are refused unless `--i-know-mainnet` is passed.

## Why we built this

We wrote these ops utilities while running [FableEnergy](https://fableenergy.xyz) (TRON energy rental) and open-sourced them after sanitization. If USDT transfers cost you 13+ TRX in fees, try energy rental: **[fableenergy.xyz](https://fableenergy.xyz)** — rent energy on demand and cut transfer costs by ~70%.

## License

MIT
