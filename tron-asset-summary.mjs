#!/usr/bin/env node
/**
 * TRON 多钱包资产汇总（TRX / USDT / USDD → 折合 USDT，含 JustLend 仓位）
 * Multi-wallet TRON asset dashboard: on-chain balances + JustLend V1/V2 positions,
 * price feeds (Binance → OKX → CoinGecko), history & trend chart, HTML report.
 *
 * 配置（零依赖，只读，无需私钥，Node 18+）：
 *   wallets.txt        必填：一行一个 T 地址，可跟别名（如 `T… 主钱包`）；或 WALLETS=T…,T…
 *   lend-wallets.txt   可选：借币/JustLend 地址（链上余额 + V1/V2 存借仓位）；或 LEND_WALLETS=…
 *   TRONGRID_API_KEY   可选（.env 或环境变量）
 *   REPORT_TZ          可选，展示时区，默认系统时区
 *
 * 运行：
 *   node tron-asset-summary.mjs
 *   node tron-asset-summary.mjs --html   # 额外生成 tron-asset-summary.html
 *
 * 每次运行写入 tron-asset-summary-history.json（本地历史，供走势用）。
 */
import './lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ui, ESC, printTable, sa, shortAddr } from './lib/terminal-ui.mjs';
import { loadWallets, getWalletLabel, requireWallets } from './lib/wallets.mjs';

const FULL_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
const USDT_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDD_ADDR = 'TEkxiTehnzSmSe2XqrBpo4XvfGmRVRne3U';
const MOOLAH_V2_API = 'https://zenvora.ablesdxd.link';
const HTML_OUT = path.resolve('tron-asset-summary.html');
const HISTORY_FILE = path.resolve('tron-asset-summary-history.json');
const HISTORY_MAX = Number(process.env.ASSET_HISTORY_MAX || 400);
const HISTORY_MIN_GAP_MS = Number(process.env.ASSET_HISTORY_MIN_GAP_MS || 30 * 60_000);
const CHART_DAYS = Number(process.env.ASSET_CHART_DAYS || 90);
const REPORT_TZ = process.env.REPORT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const WANT_HTML = process.argv.includes('--html');
const SKIP_HISTORY = process.argv.includes('--no-history');

const STABLE_SYMBOLS = new Set(['USDT', 'USDD', 'USDJ', 'USDC', 'TUSD', 'USD1', 'USDDOLD']);

const API_KEY = (process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY || '').trim();
const headers = API_KEY ? { 'TRON-PRO-API-KEY': API_KEY } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtNum(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function parseBig(raw, decimals) {
  if (raw == null || raw === '') return 0;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return Number(s) / 10 ** decimals;
  const whole = s.length <= decimals ? '0' : s.slice(0, s.length - decimals);
  const frac = s.length <= decimals ? s.padStart(decimals, '0') : s.slice(-decimals);
  return Number(`${whole}.${frac}`);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTs(d = new Date()) {
  return d.toLocaleString('zh-CN', {
    timeZone: REPORT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
}

function fmtShortDate(ms) {
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: REPORT_TZ,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw?.samples)) return raw;
  } catch { /* 首次运行无文件 */ }
  return { version: 1, samples: [] };
}

function snapshotFromData(data) {
  const { totals, prices } = data;
  return {
    t: Date.now(),
    grand: +totals.grand.toFixed(2),
    stake: +totals.stake.toFixed(2),
    lendOnChain: +totals.lendOnChain.toFixed(2),
    lendProtocolNet: +totals.lendProtocolNet.toFixed(2),
    trxTotal: +totals.trxTotal.toFixed(4),
    trxUsd: totals.trxUsd != null ? +totals.trxUsd.toFixed(2) : null,
    trxPrice: prices.trx != null ? +prices.trx.toFixed(6) : null,
  };
}

/** 追加历史点；30min 内同总额跳过；最多保留 HISTORY_MAX 条 */
function appendHistory(data) {
  if (SKIP_HISTORY) return loadHistory();
  const hist = loadHistory();
  const snap = snapshotFromData(data);
  const last = hist.samples.at(-1);
  if (last) {
    const gap = snap.t - last.t;
    if (gap < HISTORY_MIN_GAP_MS && Math.abs(snap.grand - last.grand) < 0.01) return hist;
  }
  hist.samples.push(snap);
  if (hist.samples.length > HISTORY_MAX) {
    hist.samples = hist.samples.slice(-HISTORY_MAX);
  }
  try {
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(hist, null, 2)}\n`, 'utf8');
  } catch (e) {
    ui.warn(`历史写入失败: ${e.message}`);
  }
  return hist;
}

function historyDelta(hist) {
  const samples = hist?.samples || [];
  if (samples.length < 2) return null;
  const prev = samples.at(-2);
  const cur = samples.at(-1);
  const near = (days) => {
    const target = Date.now() - days * 86_400_000;
    let best = samples[0];
    let diff = Math.abs(best.t - target);
    for (const s of samples) {
      const d = Math.abs(s.t - target);
      if (d < diff) { best = s; diff = d; }
    }
    return best;
  };
  const vsPrev = cur.grand - prev.grand;
  const ref7 = near(7);
  const ref30 = near(30);
  const vs7 = ref7.t < cur.t - 3600_000 ? cur.grand - ref7.grand : null;
  const vs30 = ref30.t < cur.t - 3600_000 ? cur.grand - ref30.grand : null;
  return { vsPrev, vs7, vs30, prevGrand: prev.grand, currentGrand: cur.grand };
}

function chartSamples(hist) {
  const cut = Date.now() - CHART_DAYS * 86_400_000;
  const list = (hist?.samples || []).filter((s) => s.t >= cut);
  return list.length >= 2 ? list : (hist?.samples || []).slice(-Math.max(2, list.length));
}

function buildTrendChartHtml(samples) {
  if (samples.length < 2) {
    return `<section class="trend-section"><h2>资产变动走势</h2><p class="empty">历史不足 2 条（需多次运行后生成）。数据存于 <code>tron-asset-summary-history.json</code></p></section>`;
  }

  const W = 920;
  const H = 240;
  const mx = 52;
  const my = 18;
  const mb = 36;
  const plotW = W - mx - 20;
  const plotH = H - my - mb;

  const series = [
    { key: 'grand', label: '全部合计', color: '#2563eb', width: 2.5 },
    { key: 'stake', label: '主列表链上', color: '#059669', width: 1.8 },
    { key: 'lendProtocolNet', label: 'JustLend 净值', color: '#7c3aed', width: 1.8, dash: '6 4' },
  ];

  const allVals = samples.flatMap((s) => series.map(({ key }) => s[key]).filter((v) => v != null));
  let yMin = Math.min(...allVals);
  let yMax = Math.max(...allVals);
  const pad = (yMax - yMin) * 0.1 || yMax * 0.02 || 100;
  yMin = Math.max(0, yMin - pad);
  yMax += pad;

  const xAt = (i) => mx + (i / (samples.length - 1)) * plotW;
  const yAt = (v) => my + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const yTicks = 4;
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = yAt(v);
    return `<line x1="${mx}" y1="${y.toFixed(1)}" x2="${mx + plotW}" y2="${y.toFixed(1)}" class="grid"/><text x="${mx - 6}" y="${(y + 4).toFixed(1)}" class="axis" text-anchor="end">$${fmtNum(v, 0)}</text>`;
  }).join('');

  const paths = series.map(({ key, color, width, dash }) => {
    const pts = samples.map((s, i) => ({ x: xAt(i), y: yAt(s[key]), s }));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${color}"><title>${esc(fmtShortDate(p.s.t))} · ${esc(series.find((x) => x.key === key).label)} $${fmtNum(p.s[key], 2)}</title></circle>`).join('');
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}/>${dots}`;
  }).join('');

  const xLabels = [0, Math.floor((samples.length - 1) / 2), samples.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="middle">${esc(fmtShortDate(samples[i].t))}</text>`)
    .join('');

  const first = samples[0];
  const last = samples.at(-1);
  const chg = last.grand - first.grand;
  const chgPct = first.grand > 0 ? (chg / first.grand) * 100 : 0;
  const chgClass = chg >= 0 ? 'up' : 'down';
  const legend = series.map(({ label, color, dash }) =>
    `<span class="legend-item"><i style="background:${color}${dash ? ';opacity:.85' : ''}"></i>${esc(label)}</span>`,
  ).join('');

  return `
  <section class="trend-section">
    <div class="trend-head">
      <h2>资产变动走势 <span class="dim">近 ${esc(String(Math.min(CHART_DAYS, Math.ceil((last.t - first.t) / 86_400_000)) || CHART_DAYS))} 天 · ${esc(String(samples.length))} 个采样点</span></h2>
      <div class="trend-delta ${chgClass}">区间 ${chg >= 0 ? '+' : ''}$${fmtNum(chg, 2)} (${chg >= 0 ? '+' : ''}${fmtNum(chgPct, 2)}%)</div>
    </div>
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="trend-chart" preserveAspectRatio="xMidYMid meet">${yGrid}${paths}${xLabels}</svg>
    </div>
    <div class="chart-legend">${legend}</div>
    <p class="chart-note dim">每次运行追加一条快照（30 分钟内同总额不重复记）。</p>
  </section>`;
}

async function fetchJson(url, opts = {}) {
  for (let i = 0; i < 4; i += 1) {
    const r = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
    if (r.status === 429) { await sleep(800 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`429 限流: ${url}`);
}

async function fetchPlainJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function binanceTicker(symbol) {
  const j = await fetchPlainJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  const p = Number(j.price);
  if (!Number.isFinite(p)) throw new Error(`Binance ${symbol} 无效价格`);
  return p;
}

async function okxTicker(instId) {
  const j = await fetchPlainJson(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
  if (j.code !== '0' || !j.data?.[0]?.last) throw new Error(j.msg || `OKX ${instId}`);
  const p = Number(j.data[0].last);
  if (!Number.isFinite(p)) throw new Error(`OKX ${instId} 无效价格`);
  return p;
}

async function coingeckoFallback() {
  const j = await fetchPlainJson('https://api.coingecko.com/api/v3/simple/price?ids=tron,bitcoin&vs_currencies=usd');
  return { trx: j.tron?.usd ?? null, btc: j.bitcoin?.usd ?? null };
}

function priceSourceLabel(p) {
  const sources = [...new Set([p.trxSource, p.btcSource].filter(Boolean))];
  if (!sources.length) return '';
  return sources.length === 1 ? sources[0] : sources.join(' / ');
}

/** TRX/BTC 美元价：Binance 盘口 → OKX → CoinGecko 兜底 */
async function fetchMarketPrices() {
  const prices = {
    trx: null,
    btc: null,
    trxSource: null,
    btcSource: null,
    fetchedAt: new Date(),
  };

  const [bTrx, bBtc] = await Promise.allSettled([
    binanceTicker('TRXUSDT'),
    binanceTicker('BTCUSDT'),
  ]);
  if (bTrx.status === 'fulfilled') { prices.trx = bTrx.value; prices.trxSource = 'Binance'; }
  if (bBtc.status === 'fulfilled') { prices.btc = bBtc.value; prices.btcSource = 'Binance'; }

  const okxJobs = [];
  if (prices.trx == null) {
    okxJobs.push(okxTicker('TRX-USDT').then((p) => { prices.trx = p; prices.trxSource = 'OKX'; }));
  }
  if (prices.btc == null) {
    okxJobs.push(okxTicker('BTC-USDT').then((p) => { prices.btc = p; prices.btcSource = 'OKX'; }));
  }
  if (okxJobs.length) await Promise.allSettled(okxJobs);

  if (prices.trx == null || prices.btc == null) {
    try {
      const cg = await coingeckoFallback();
      if (prices.trx == null && cg.trx != null) { prices.trx = cg.trx; prices.trxSource = 'CoinGecko'; }
      if (prices.btc == null && cg.btc != null) { prices.btc = cg.btc; prices.btcSource = 'CoinGecko'; }
    } catch (e) {
      ui.warn(`CoinGecko 兜底失败: ${e.message}`);
    }
  }

  if (prices.trx == null && prices.btc == null) {
    ui.warn('行情获取失败（Binance / OKX / CoinGecko 均不可用）');
  } else if (prices.trx == null || prices.btc == null) {
    ui.warn(`部分行情缺失：TRX=${prices.trx != null ? '✓' : '✗'} BTC=${prices.btc != null ? '✓' : '✗'}`);
  }

  return prices;
}

function priceForSymbol(symbol, prices) {
  const sym = String(symbol || '').toUpperCase();
  if (STABLE_SYMBOLS.has(sym)) return 1;
  if (sym === 'TRX' || sym === 'WTRX') return prices.trx;
  if (sym === 'BTC' || sym === 'WBTC' || sym === 'BTCB') return prices.btc;
  return null;
}

async function fetchOnChainBalances(address) {
  const j = await fetchJson(`${FULL_HOST}/v1/accounts/${address}`);
  const acc = j.data?.[0];
  const trxLiquid = acc ? Number(acc.balance || 0) / 1e6 : 0;
  let trxStaked = 0;
  for (const f of acc?.frozenV2 || []) {
    if (f.type === 'ENERGY' || f.type === 'TRON_POWER') trxStaked += Number(f.amount || 0) / 1e6;
  }
  trxStaked += Number(
    acc?.account_resource?.delegated_frozenV2_balance_for_energy
    ?? acc?.delegated_frozenV2_balance_for_energy
    ?? 0,
  ) / 1e6;
  const trx = trxLiquid + trxStaked;
  let usdt = 0;
  let usdd = 0;
  for (const row of acc?.trc20 || []) {
    for (const [contract, raw] of Object.entries(row)) {
      if (contract === USDT_ADDR) usdt = parseBig(raw, 6);
      else if (contract === USDD_ADDR) usdd = parseBig(raw, 18);
    }
  }
  return { trx, trxLiquid, trxStaked, usdt, usdd };
}

async function fetchJustLendV1(address) {
  try {
    const j = await fetchJson(`https://openapi.just.network/lend/account?addresses=${encodeURIComponent(address)}&pageSize=1`);
    return j.data?.list?.[0] ?? null;
  } catch (e) {
    ui.warn(`JustLend V1 查询 ${sa(address)} 失败: ${e.message}`);
    return null;
  }
}

async function fetchMoolahV2Api(apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${MOOLAH_V2_API}${apiPath}${qs ? `?${qs}` : ''}`;
  const j = await fetch(url);
  if (!j.ok) throw new Error(`HTTP ${j.status} ${apiPath}`);
  const body = await j.json();
  if (body.code !== 200) throw new Error(body.message || `code ${body.code}`);
  return body.data ?? null;
}

async function fetchJustLendV2(address) {
  try {
    const pos = await fetchMoolahV2Api('/index/position', { address });
    if (!pos) return null;
    const markets = [];
    for (const m of pos.markets || []) {
      let detail = null;
      if (m.marketId) {
        try {
          detail = await fetchMoolahV2Api('/market/position', { market: m.marketId, address });
        } catch { /* use summary only */ }
      }
      markets.push({ summary: m, detail });
    }
    return { pos, markets };
  } catch (e) {
    ui.warn(`JustLend SBM V2 查询 ${sa(address)} 失败: ${e.message}`);
    return null;
  }
}

function summarizeJustLendV2(v2) {
  if (!v2?.pos) return { netUsd: 0, collateralUsd: 0, borrowUsd: 0, supplyUsd: 0, lines: [], hasPosition: false, borrowRate: null };
  const collateralUsd = Number(v2.pos.totalCollateralUsd || 0);
  const borrowUsd = Number(v2.pos.totalBorrowUsd || 0);
  const supplyUsd = Number(v2.pos.totalSupplyUsd || 0);
  const lines = [];

  for (const { summary, detail } of v2.markets) {
    const collSym = detail?.collateralSymbol || '?';
    const borSym = detail?.borrowSymbol || '?';
    lines.push({
      market: `${collSym}/${borSym}`,
      collSym,
      borSym,
      collAmt: detail?.collateralAmount != null ? Number(detail.collateralAmount) : null,
      borAmt: detail?.borrowAmount != null ? Number(detail.borrowAmount) : null,
      collUsd: Number(detail?.collateralUsd ?? summary.collateralUsd ?? 0),
      borUsd: Number(detail?.borrowUsd ?? summary.borrowUsd ?? 0),
      health: summary.health ?? detail?.risk ?? null,
      lltv: detail?.lltv != null ? Number(detail.lltv) : null,
      borrowApy: detail?.borrowApy != null ? Number(detail.borrowApy) : null,
    });
  }

  for (const v of v2.pos.vaults || []) {
    const usd = Number(v.depositUsd || 0);
    if (usd <= 0 && !v.depositAmount) continue;
    lines.push({
      market: `Vault ${v.vaultName || v.assetSymbol || '?'}`,
      collSym: v.assetSymbol || '?',
      borSym: '—',
      collAmt: v.depositAmount != null ? Number(v.depositAmount) : null,
      borAmt: null,
      collUsd: usd,
      borUsd: 0,
      health: null,
      lltv: null,
      borrowApy: null,
    });
  }

  const hasPosition = collateralUsd > 0 || borrowUsd > 0 || supplyUsd > 0 || lines.length > 0;
  return {
    netUsd: collateralUsd + supplyUsd - borrowUsd,
    collateralUsd,
    borrowUsd,
    supplyUsd,
    borrowRate: v2.pos.netBorrowRate != null ? Number(v2.pos.netBorrowRate) : null,
    lines,
    hasPosition,
  };
}

function onChainUsdtEquiv({ trx, usdt, usdd }, prices) {
  const trxUsd = prices.trx ? trx * prices.trx : 0;
  const stable = usdt + usdd;
  const total = stable + (prices.trx ? trxUsd : 0);
  return { trxUsd, stable, total, trxPriced: prices.trx != null };
}

function summarizeJustLend(pos, prices) {
  if (!pos) return { supplyUsd: 0, borrowUsd: 0, netUsd: 0, lines: [], priced: true, hasPosition: false, health: null };
  const lines = [];
  let supplyUsd = 0;
  let borrowUsd = 0;
  let priced = true;

  for (const t of pos.tokens || []) {
    const sym = t.underlyingSymbol || '?';
    const sup = Number(t.supplyBalanceUnderlying || 0);
    const bor = Number(t.borrowBalanceUnderlying || 0);
    if (sup <= 0 && bor <= 0) continue;
    const px = priceForSymbol(sym, prices);
    if (px == null) priced = false;
    const supUsd = px != null ? sup * px : 0;
    const borUsd = px != null ? bor * px : 0;
    supplyUsd += supUsd;
    borrowUsd += borUsd;
    lines.push({ sym, sup, bor, supUsd, borUsd, tag: t.entered ? '抵押' : '', px });
  }

  const hasPosition = lines.length > 0 || supplyUsd > 0 || borrowUsd > 0;
  return {
    supplyUsd,
    borrowUsd,
    netUsd: supplyUsd - borrowUsd,
    health: pos.health != null ? Number(pos.health) : null,
    lines,
    priced,
    hasPosition,
  };
}

function walletMeta(addr, kind) {
  const label = getWalletLabel(addr);
  return {
    address: addr,
    label: label || (kind === 'lend' ? '借币' : ''),
    short: shortAddr(addr),
    display: label ? `${label} ${shortAddr(addr)}` : (kind === 'lend' ? `${shortAddr(addr)} · 借币` : shortAddr(addr)),
  };
}

function walletLabel(addr, kind) {
  const alias = getWalletLabel(addr);
  if (alias) return `${alias} ${sa(addr)}`;
  return kind === 'lend' ? `${sa(addr)} · 借币` : sa(addr);
}

function healthClass(h) {
  if (h == null || !Number.isFinite(h)) return 'neutral';
  // SBM V2 风险系数：越大越危险，1=清算，离 1 越远越安全
  if (h >= 0.92) return 'risk';
  if (h >= 0.80) return 'warn';
  return 'safe';
}

async function collectAssetSummary() {
  const stakeAddrs = requireWallets(
    loadWallets('wallets.txt', { envVar: 'WALLETS', baseUrl: import.meta.url, label: '钱包' }),
    'wallets.txt', 'WALLETS',
  );
  const lendAddrs = loadWallets('lend-wallets.txt', { envVar: 'LEND_WALLETS', baseUrl: import.meta.url, label: '借币钱包' });
  const stakeSet = new Set(stakeAddrs);
  const onChainCache = new Map();

  async function cachedOnChain(address) {
    if (!onChainCache.has(address)) {
      onChainCache.set(address, await fetchOnChainBalances(address));
    }
    return onChainCache.get(address);
  }

  ui.info('拉取 TRX/BTC 盘口价（Binance → OKX）…');
  const prices = await fetchMarketPrices();

  const stakeWallets = [];
  let stakeTotal = 0;
  let trxTotal = 0;
  let trxLiquidTotal = 0;
  let trxStakedTotal = 0;

  for (let i = 0; i < stakeAddrs.length; i += 1) {
    const addr = stakeAddrs[i];
    process.stdout.write(`\r${ESC.dim}  [${i + 1}/${stakeAddrs.length}] ${sa(addr)}${ESC.reset}   `);
    const bal = await cachedOnChain(addr);
    const eq = onChainUsdtEquiv(bal, prices);
    stakeTotal += eq.total;
    trxTotal += bal.trx;
    trxLiquidTotal += bal.trxLiquid;
    trxStakedTotal += bal.trxStaked;
    stakeWallets.push({
      ...walletMeta(addr, 'stake'),
      ...bal,
      usdtEquiv: eq.total,
      trxPriced: eq.trxPriced,
    });
    if (i < stakeAddrs.length - 1) await sleep(200);
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  const lendWallets = [];
  let lendOnChainTotal = 0;
  let lendV1NetTotal = 0;
  let lendV2NetTotal = 0;

  for (let i = 0; i < lendAddrs.length; i += 1) {
    const addr = lendAddrs[i];
    const bal = await cachedOnChain(addr);
    const eq = onChainUsdtEquiv(bal, prices);
    if (!stakeSet.has(addr)) {
      lendOnChainTotal += eq.total;
      trxTotal += bal.trx;
      trxLiquidTotal += bal.trxLiquid;
      trxStakedTotal += bal.trxStaked;
    }

    const [v2raw, jl] = await Promise.all([fetchJustLendV2(addr), fetchJustLendV1(addr)]);
    const v2 = summarizeJustLendV2(v2raw);
    const v1 = summarizeJustLend(jl, prices);
    if (v2.hasPosition) lendV2NetTotal += v2.netUsd;
    if (v1.hasPosition) lendV1NetTotal += v1.netUsd;
    const protocolNet = (v2.hasPosition ? v2.netUsd : 0) + (v1.hasPosition ? v1.netUsd : 0);

    lendWallets.push({
      ...walletMeta(addr, 'lend'),
      onChain: { ...bal, usdtEquiv: eq.total },
      v2: v2.hasPosition ? v2 : null,
      v1: v1.hasPosition ? v1 : null,
      protocolNet,
      walletTotal: eq.total + protocolNet,
    });
    if (i < lendAddrs.length - 1) await sleep(300);
  }

  const lendProtocolNet = lendV1NetTotal + lendV2NetTotal;
  const grand = stakeTotal + lendOnChainTotal + lendProtocolNet;

  for (const w of stakeWallets) {
    w.sharePct = stakeTotal > 0 ? (w.usdtEquiv / stakeTotal) * 100 : 0;
  }

  return {
    generatedAt: fmtTs(),
    prices,
    totals: {
      stake: stakeTotal,
      lendOnChain: lendOnChainTotal,
      lendV1Net: lendV1NetTotal,
      lendV2Net: lendV2NetTotal,
      lendProtocolNet,
      grand,
      trxTotal,
      trxLiquidTotal,
      trxStakedTotal,
      trxUsd: prices.trx != null ? trxTotal * prices.trx : null,
    },
    stakeWallets,
    lendWallets,
  };
}

function printReport(data, hist) {
  const { prices, totals, stakeWallets, lendWallets } = data;
  const delta = historyDelta(hist);

  ui.title('TRON 多钱包 · 资产汇总');
  ui.subtitle('链上 TRX/USDT/USDD + JustLend V1/V2 存借 · 折合 USDT（稳定币按 1:1）');
  const src = priceSourceLabel(prices);
  if (prices.trx) ui.row('TRX', `$${fmtNum(prices.trx, 5)}${prices.trxSource ? ` · ${prices.trxSource}` : ''}`);
  else ui.warn('无 TRX 价：TRX 余额不计入 USDT 合计');
  if (prices.btc) ui.row('BTC', `$${fmtNum(prices.btc, 2)}${prices.btcSource ? ` · ${prices.btcSource}` : ''}`);
  if (src) ui.hint(`行情源：${src} · 拉取于 ${fmtTs(prices.fetchedAt)}`);
  if (delta) {
    const fmtChg = (n) => `${n >= 0 ? '+' : ''}${fmtNum(n, 2)} USDT`;
    ui.row('较上次', fmtChg(delta.vsPrev));
    if (delta.vs7 != null) ui.row('较 7 天前', fmtChg(delta.vs7));
    if (delta.vs30 != null) ui.row('较 30 天前', fmtChg(delta.vs30));
    ui.hint(`历史 ${hist.samples.length} 条 → ${HISTORY_FILE}`);
  } else if ((hist?.samples?.length || 0) === 1) {
    ui.hint('已写入首条历史，下次运行可看到变动');
  }

  ui.section('钱包 · 链上余额');
  printTable(
    ['钱包', 'TRX(可用+质押)', 'USDT', 'USDD', '≈USDT'],
    stakeWallets.map((w) => [
      w.label ? `${w.label} ${w.short}` : w.short,
      `${fmtNum(w.trxLiquid, 1)}+${fmtNum(w.trxStaked, 0)}`,
      fmtNum(w.usdt, 2),
      fmtNum(w.usdd, 2),
      w.trxPriced ? fmtNum(w.usdtEquiv, 2) : `${fmtNum(w.usdt + w.usdd, 2)}*`,
    ]),
  );
  ui.row('小计', `${fmtNum(totals.stake, 2)} USDT${prices.trx ? '' : '（*仅稳定币）'}`);

  if (lendWallets.length) {
    ui.section('借币钱包 · 链上 + JustLend');
    for (const w of lendWallets) {
      ui.divider();
      console.log(`  ${ESC.bold}${walletLabel(w.address, 'lend')}${ESC.reset}`);
      ui.row('链上 TRX', `${fmtNum(w.onChain.trxLiquid, 4)} 可用 + ${fmtNum(w.onChain.trxStaked, 4)} 质押 = ${fmtNum(w.onChain.trx, 4)}`);
      ui.row('链上 USDT', fmtNum(w.onChain.usdt, 2));
      ui.row('链上 USDD', fmtNum(w.onChain.usdd, 2));
      ui.row('链上 ≈USDT', fmtNum(w.onChain.usdtEquiv, 2));

      if (w.v2) {
        console.log(`\n  ${ESC.dim}JustLend SBM V2 (Moolah):${ESC.reset}`);
        printTable(
          ['市场', '抵押', '借款', '风险系数', '≈USDT净值'],
          w.v2.lines.map((l) => {
            const net = l.collUsd - l.borUsd;
            const collStr = l.collAmt != null
              ? `${fmtNum(l.collAmt, l.collSym === 'BTC' ? 6 : 4)} ${l.collSym}`
              : (l.collUsd > 0 ? `$${fmtNum(l.collUsd, 2)}` : '—');
            const borStr = l.borAmt != null
              ? `${fmtNum(l.borAmt, 2)} ${l.borSym}`
              : (l.borUsd > 0 ? `$${fmtNum(l.borUsd, 2)}` : '—');
            return [l.market, collStr, borStr, l.health != null ? fmtNum(Number(l.health), 2) : '—', fmtNum(net, 2)];
          }),
        );
        if (w.v2.borrowRate != null) ui.row('V2 借款利率', `${fmtNum(w.v2.borrowRate * 100, 3)}%`);
        ui.row('SBM V2 净值', `${fmtNum(w.v2.netUsd, 2)} USDT（抵押 ${fmtNum(w.v2.collateralUsd, 2)} − 借 ${fmtNum(w.v2.borrowUsd, 2)}）`);
      }

      if (w.v1) {
        console.log(`\n  ${ESC.dim}JustLend V1 (遗留):${ESC.reset}`);
        if (w.v1.health != null) ui.row('V1 健康因子', fmtNum(w.v1.health, 2));
        printTable(
          ['资产', '供应', '借款', '≈USDT净值'],
          w.v1.lines.map((l) => {
            const net = l.px != null ? l.supUsd - l.borUsd : null;
            const supStr = l.sup > 0 ? `${fmtNum(l.sup, 4)} ${l.sym}${l.tag ? ` (${l.tag})` : ''}` : '—';
            const borStr = l.bor > 0 ? `${fmtNum(l.bor, 4)} ${l.sym}` : '—';
            return [l.sym, supStr, borStr, net != null ? fmtNum(net, 2) : '—'];
          }),
        );
        ui.row('V1 净值', `${fmtNum(w.v1.netUsd, 2)} USDT${w.v1.priced ? '' : '（部分资产无价）'}`);
      }

      if (!w.v2 && !w.v1) ui.warn('无 JustLend V1/V2 仓位');
      else ui.row('协议合计 ≈USDT', `${fmtNum(w.walletTotal, 2)} USDT`);
    }

    ui.divider();
    ui.row('借币链上小计', `${fmtNum(totals.lendOnChain, 2)} USDT`);
    if (totals.lendV2Net > 0) ui.row('SBM V2 净值小计', `${fmtNum(totals.lendV2Net, 2)} USDT`);
    if (totals.lendV1Net > 0) ui.row('V1 净值小计', `${fmtNum(totals.lendV1Net, 2)} USDT`);
    ui.row('JustLend 净值小计', `${fmtNum(totals.lendProtocolNet, 2)} USDT`);
  }

  ui.section('总计');
  ui.box([
    `${ESC.bold}TRX 总数${ESC.reset}      ${fmtNum(totals.trxTotal, 0)} TRX（可用 ${fmtNum(totals.trxLiquidTotal, 0)} + 质押 ${fmtNum(totals.trxStakedTotal, 0)}）`,
    `${ESC.bold}主列表链上${ESC.reset}   ${fmtNum(totals.stake, 2)} USDT`,
    `${ESC.bold}借币链上${ESC.reset}     ${fmtNum(totals.lendOnChain, 2)} USDT`,
    `${ESC.bold}JustLend 净值${ESC.reset} ${fmtNum(totals.lendProtocolNet, 2)} USDT`,
    `${ESC.bold}全部合计${ESC.reset}     ${ESC.green}${fmtNum(totals.grand, 2)} USDT${ESC.reset}`,
  ]);
  ui.hint('TRX 含能量质押（frozenV2）；V1=openapi.just.network · V2=zenvora.ablesdxd.link');
  ui.hint('增删地址：wallets.txt · lend-wallets.txt');
  if (WANT_HTML) ui.hint(`网页报表：${HTML_OUT}`);
}

function buildHtml(data, hist) {
  const { prices, totals, stakeWallets, lendWallets, generatedAt } = data;
  const t = totals;
  const delta = historyDelta(hist);
  const trendHtml = buildTrendChartHtml(chartSamples(hist));
  const deltaCards = delta ? `
    <div class="delta-cards">
      <div class="delta-card"><span>较上次</span><b class="${delta.vsPrev >= 0 ? 'up' : 'down'}">${delta.vsPrev >= 0 ? '+' : ''}$${fmtNum(delta.vsPrev, 2)}</b></div>
      ${delta.vs7 != null ? `<div class="delta-card"><span>较 7 天前</span><b class="${delta.vs7 >= 0 ? 'up' : 'down'}">${delta.vs7 >= 0 ? '+' : ''}$${fmtNum(delta.vs7, 2)}</b></div>` : ''}
      ${delta.vs30 != null ? `<div class="delta-card"><span>较 30 天前</span><b class="${delta.vs30 >= 0 ? 'up' : 'down'}">${delta.vs30 >= 0 ? '+' : ''}$${fmtNum(delta.vs30, 2)}</b></div>` : ''}
    </div>` : '';
  const pct = (n) => (t.grand > 0 ? (n / t.grand) * 100 : 0);
  const pStake = pct(t.stake);
  const pLendChain = pct(t.lendOnChain);
  const pLendProto = pct(t.lendProtocolNet);

  const stakeRows = stakeWallets.map((w) => `
    <tr>
      <td><span class="wallet-name">${esc(w.label || w.short)}</span><code title="${esc(w.address)}">${esc(w.short)}</code></td>
      <td class="num">${fmtNum(w.trxLiquid, 1)}<span class="dim">+</span>${fmtNum(w.trxStaked, 0)}</td>
      <td class="num">${fmtNum(w.usdt, 2)}</td>
      <td class="num">${fmtNum(w.usdd, 2)}</td>
      <td class="num strong">${fmtNum(w.usdtEquiv, 2)}</td>
      <td class="bar-cell"><div class="bar"><i style="width:${w.sharePct.toFixed(1)}%"></i></div><span class="pct">${fmtNum(w.sharePct, 1)}%</span></td>
    </tr>`).join('');

  const lendSections = lendWallets.map((w) => {
    const v2cards = (w.v2?.lines || []).map((l) => {
      const net = l.collUsd - l.borUsd;
      const h = l.health != null ? Number(l.health) : null;
      const hPct = h != null ? Math.min(100, Math.max(4, h * 100)) : 0;
      const collTxt = l.collAmt != null
        ? `${fmtNum(l.collAmt, l.collSym === 'BTC' ? 6 : 4)} ${esc(l.collSym)}`
        : `$${fmtNum(l.collUsd, 2)}`;
      const borTxt = l.borAmt != null
        ? `${fmtNum(l.borAmt, 2)} ${esc(l.borSym)}`
        : `$${fmtNum(l.borUsd, 2)}`;
      return `
      <article class="position-card v2">
        <div class="pos-head">
          <span class="badge v2">SBM V2</span>
          <strong>${esc(l.market)}</strong>
        </div>
        <div class="pos-grid">
          <div><span class="k">抵押</span><span class="v">${collTxt}</span><span class="sub">≈ $${fmtNum(l.collUsd, 2)}</span></div>
          <div><span class="k">借款</span><span class="v">${borTxt}</span><span class="sub">≈ $${fmtNum(l.borUsd, 2)}</span></div>
          <div><span class="k">净值</span><span class="v green">$${fmtNum(net, 2)}</span></div>
        </div>
        ${h != null ? `
        <div class="health">
          <div class="health-label"><span>风险系数 ${fmtNum(h, 2)}</span>${l.lltv != null ? `<span class="dim">LLTV ${fmtNum(l.lltv * 100, 0)}%</span>` : ''}</div>
          <div class="health-track"><i class="${healthClass(h)}" style="width:${hPct.toFixed(1)}%"></i></div>
        </div>` : ''}
        ${l.borrowApy != null ? `<div class="apy">借款 APY ${fmtNum(l.borrowApy * 100, 3)}%</div>` : ''}
      </article>`;
    }).join('');

    const v1rows = (w.v1?.lines || []).map((l) => {
      const net = l.px != null ? l.supUsd - l.borUsd : null;
      return `<tr>
        <td>${esc(l.sym)}</td>
        <td>${l.sup > 0 ? `${fmtNum(l.sup, 4)} ${esc(l.sym)}${l.tag ? ` <span class="tag">${esc(l.tag)}</span>` : ''}` : '—'}</td>
        <td>${l.bor > 0 ? `${fmtNum(l.bor, 4)} ${esc(l.sym)}` : '—'}</td>
        <td class="num">${net != null ? fmtNum(net, 2) : '—'}</td>
      </tr>`;
    }).join('');

    return `
    <section class="lend-wallet">
      <header>
        <h2>${esc(w.label || '借币钱包')} <code title="${esc(w.address)}">${esc(w.short)}</code></h2>
        <div class="wallet-total">钱包合计 <strong>$${fmtNum(w.walletTotal, 2)}</strong></div>
      </header>
      <div class="mini-cards">
        <div class="mini"><span>链上 TRX</span><b>${fmtNum(w.onChain.trx, 4)}</b></div>
        <div class="mini"><span>链上 USDT</span><b>${fmtNum(w.onChain.usdt, 2)}</b></div>
        <div class="mini"><span>链上 ≈USDT</span><b>${fmtNum(w.onChain.usdtEquiv, 2)}</b></div>
        <div class="mini"><span>协议净值</span><b>${fmtNum(w.protocolNet, 2)}</b></div>
      </div>
      ${v2cards || ''}
      ${w.v1 ? `
      <div class="v1-block">
        <h3><span class="badge v1">V1 遗留</span>${w.v1.health != null ? `健康因子 ${fmtNum(w.v1.health, 2)}` : ''}</h3>
        <div class="table-wrap"><table class="compact"><thead><tr><th>资产</th><th>供应</th><th>借款</th><th class="num">≈USDT</th></tr></thead><tbody>${v1rows}</tbody></table></div>
        <p class="v1-net">V1 净值 <strong>$${fmtNum(w.v1.netUsd, 2)}</strong></p>
      </div>` : ''}
      ${!w.v2 && !w.v1 ? '<p class="empty">无 JustLend 仓位</p>' : ''}
    </section>`;
  }).join('');

  const src = priceSourceLabel(prices);
  const priceChips = [
    prices.trx != null
      ? `<span class="chip">TRX <b>$${fmtNum(prices.trx, 5)}</b>${prices.trxSource ? ` <span class="dim">${esc(prices.trxSource)}</span>` : ''}</span>`
      : '',
    prices.btc != null
      ? `<span class="chip">BTC <b>$${fmtNum(prices.btc, 2)}</b>${prices.btcSource ? ` <span class="dim">${esc(prices.btcSource)}</span>` : ''}</span>`
      : '',
    src ? `<span class="chip dim">盘口 · ${esc(fmtTs(prices.fetchedAt))}</span>` : '',
  ].filter(Boolean).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>资产汇总 · ${esc(generatedAt)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6fb;--panel:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--green:#059669;--amber:#d97706;--red:#dc2626;--v2:#7c3aed;--v1:#64748b}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111827;--fg:#e5e7eb;--muted:#94a3b8;--line:#1f2937}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
h2{margin:0;font-size:17px}
h3{margin:0 0 10px;font-size:14px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
.prices{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:12px}
.chip b{margin-left:4px}
.hero{background:linear-gradient(135deg,#1d4ed8 0%,#7c3aed 100%);color:#fff;border-radius:16px;padding:22px 24px;margin-bottom:18px;box-shadow:0 10px 30px #1d4ed833}
.hero .label{opacity:.85;font-size:13px}
.hero .grand{font-size:38px;font-weight:800;letter-spacing:-.03em;margin:4px 0 14px;font-variant-numeric:tabular-nums}
.stack{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#ffffff33;margin-bottom:10px}
.stack i{display:block;height:100%}
.stack .stake{background:#93c5fd}.stack .lend{background:#fcd34d}.stack .proto{background:#c4b5fd}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;opacity:.95}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend .stake::before{background:#93c5fd}.legend .lend::before{background:#fcd34d}.legend .proto::before{background:#c4b5fd}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--muted);font-size:12px}
.card .v{font-size:22px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
.card .sub-v{font-size:11px;color:var(--muted);margin-top:6px;line-height:1.4}
.card.hl{border-color:#2563eb55;background:#2563eb0d}
.card.trx{border-color:#f59e0b55;background:#f59e0b0d}
section{margin-top:28px}
.table-wrap{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px}
table{width:100%;border-collapse:collapse;min-width:720px}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;color:var(--muted);font-weight:650}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.strong{font-weight:700}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#8881}
.wallet-name{display:block;font-weight:650}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
.dim{color:var(--muted)}
.bar-cell{min-width:120px}
.bar{height:8px;background:#8882;border-radius:999px;overflow:hidden;margin-bottom:4px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#3b82f6,#6366f1)}
.pct{font-size:11px;color:var(--muted)}
.lend-wallet{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:14px}
.lend-wallet header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.wallet-total{font-size:13px;color:var(--muted)}
.wallet-total strong{color:var(--fg);font-size:18px;margin-left:6px}
.mini-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px}
.mini{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.mini span{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.mini b{font-size:16px}
.position-card{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:10px;background:var(--bg)}
.position-card.v2{border-color:#7c3aed44}
.pos-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.badge{font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px}
.badge.v2{background:#7c3aed22;color:var(--v2)}
.badge.v1{background:#64748b22;color:var(--v1)}
.pos-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.pos-grid .k{display:block;font-size:11px;color:var(--muted)}
.pos-grid .v{display:block;font-size:16px;font-weight:700;margin-top:2px}
.pos-grid .sub{font-size:11px;color:var(--muted)}
.green{color:var(--green)}
.health{margin-top:12px}
.health-label{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px}
.health-track{height:8px;background:#8882;border-radius:999px;overflow:hidden}
.health-track i{display:block;height:100%;border-radius:999px}
.health-track i.safe{background:var(--green)}
.health-track i.warn{background:var(--amber)}
.health-track i.risk{background:var(--red)}
.apy{margin-top:8px;font-size:12px;color:var(--muted)}
.v1-block{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line)}
.v1-net{margin:8px 0 0;font-size:13px;color:var(--muted)}
.tag{font-size:11px;background:#8882;border-radius:4px;padding:1px 5px}
.compact{min-width:480px}
.empty{color:var(--muted);font-size:13px}
.up{color:var(--green)}.down{color:var(--red)}
.trend-section{margin-top:28px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.trend-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.trend-head h2{margin:0;font-size:17px}
.trend-delta{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.chart-wrap{width:100%;overflow:hidden;border-radius:10px;background:var(--bg);border:1px solid var(--line);padding:8px 4px}
.trend-chart{width:100%;height:auto;display:block}
.trend-chart .grid{stroke:var(--line);stroke-width:1}
.trend-chart .axis{font-size:11px;fill:var(--muted)}
.chart-legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px;font-size:12px;color:var(--muted)}
.legend-item{display:inline-flex;align-items:center;gap:6px}
.legend-item i{width:18px;height:3px;border-radius:2px;display:inline-block}
.chart-note{margin:10px 0 0;font-size:11px}
.delta-cards{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}
.delta-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.delta-card span{display:block;font-size:11px;color:var(--muted)}
.delta-card b{font-size:18px;margin-top:4px;display:block}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<main>
  <h1>TRON 多钱包 · 资产汇总</h1>
  <p class="sub">生成于 ${esc(generatedAt)} · 链上 TRX/USDT/USDD + JustLend V1/V2 · 稳定币按 1:1 折合 USDT</p>
  <div class="prices">${priceChips}</div>
  ${deltaCards}

  <div class="hero">
    <div class="label">全部资产合计</div>
    <div class="grand">$${fmtNum(t.grand, 2)}</div>
    <div class="stack">
      <i class="stake" style="width:${pStake.toFixed(2)}%"></i>
      <i class="lend" style="width:${pLendChain.toFixed(2)}%"></i>
      <i class="proto" style="width:${pLendProto.toFixed(2)}%"></i>
    </div>
    <div class="legend">
      <span class="stake">主列表链上 $${fmtNum(t.stake, 0)} (${fmtNum(pStake, 1)}%)</span>
      <span class="lend">借币链上 $${fmtNum(t.lendOnChain, 0)} (${fmtNum(pLendChain, 1)}%)</span>
      <span class="proto">JustLend 净值 $${fmtNum(t.lendProtocolNet, 0)} (${fmtNum(pLendProto, 1)}%)</span>
    </div>
  </div>

  <div class="cards">
    <div class="card trx">
      <div class="k">TRX 总数 <span class="dim">（${stakeWallets.length + lendWallets.length} 个钱包）</span></div>
      <div class="v">${fmtNum(t.trxTotal, 0)} TRX</div>
      <div class="sub-v">可用 ${fmtNum(t.trxLiquidTotal, 0)} + 质押 ${fmtNum(t.trxStakedTotal, 0)}${t.trxUsd != null ? ` · ≈ $${fmtNum(t.trxUsd, 0)}` : ''}</div>
    </div>
    <div class="card hl"><div class="k">主列表链上</div><div class="v">$${fmtNum(t.stake, 2)}</div></div>
    <div class="card"><div class="k">借币链上</div><div class="v">$${fmtNum(t.lendOnChain, 2)}</div></div>
    <div class="card"><div class="k">SBM V2 净值</div><div class="v">$${fmtNum(t.lendV2Net, 2)}</div></div>
    <div class="card"><div class="k">V1 遗留净值</div><div class="v">$${fmtNum(t.lendV1Net, 2)}</div></div>
  </div>

  ${trendHtml}

  <section>
    <h2>钱包 · 链上余额</h2>
    <div class="table-wrap" style="margin-top:10px">
      <table>
        <thead><tr><th>钱包</th><th class="num">TRX 可用+质押</th><th class="num">USDT</th><th class="num">USDD</th><th class="num">≈USDT</th><th>占比</th></tr></thead>
        <tbody>${stakeRows}</tbody>
      </table>
    </div>
  </section>

  ${lendWallets.length ? `<section><h2>借币钱包 · JustLend</h2>${lendSections}</section>` : ''}

  <footer>TRX 含能量质押（frozenV2）· TRX/BTC 行情 Binance → OKX → CoinGecko · V1=openapi.just.network · V2=zenvora.ablesdxd.link</footer>
</main>
</body>
</html>`;
}

async function main() {
  const data = await collectAssetSummary();
  const hist = appendHistory(data);
  printReport(data, hist);
  if (WANT_HTML) {
    fs.writeFileSync(HTML_OUT, buildHtml(data, hist), 'utf8');
    ui.ok(`网页报表已写入 ${HTML_OUT}`);
  }
}

main().catch((e) => {
  ui.err(e.message || String(e));
  process.exit(1);
});
