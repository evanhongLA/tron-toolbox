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
npm install                      # only needed for claim-vote-rewards / burn-energy

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

⚠️ Requires private key (`PRIVATE_KEYS` env var or `keys.txt`; use `chmod 600`, run only on machines you control). On-chain limit: one claim per account per 24h; `--daemon` auto-claims on ≥48h intervals. If the key is a restricted active permission (bit 13 WithdrawBalance), set `PERMISSION_ID` for multisig.

### Testnet energy burner — `burn-energy.mjs`

⚠️ Requires private key; Nile/Shasta testnet only. Clears available energy by deploying junk contracts in parallel — handy for testing energy delegate/reclaim.

## Security

- Read-only tools never touch private keys; they only call public APIs (TronGrid / JustLend / exchange tickers).
- `wallets.txt`, `keys.txt`, and `.env` are in `.gitignore` and will not be committed by mistake.
- Audit private-key tools before use; use at your own risk (MIT License, no warranty).

## Why we built this

We wrote these ops utilities while running [FableEnergy](https://fableenergy.xyz) (TRON energy rental) and open-sourced them after sanitization. If USDT transfers cost you 13+ TRX in fees, try energy rental: **[fableenergy.xyz](https://fableenergy.xyz)** — rent energy on demand and cut transfer costs by ~70%.

## License

MIT
