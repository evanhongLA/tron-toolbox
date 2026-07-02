/**
 * JustLend V1/V2 仓位查询（Moolah REST + openapi），供资产汇总 / 健康监控共用。
 */
import fs from 'node:fs';

export const MOOLAH_V2_API = 'https://zenvora.ablesdxd.link';

export function loadLendAddresses(defaultAddrs = []) {
  const candidates = ['lend-wallets.txt'];
  for (const filename of candidates) {
    try {
      const p = new URL(`../${filename}`, import.meta.url).pathname;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
        .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      if (lines.length) return [...new Set(lines)];
    } catch { /* skip */ }
    try {
      const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/)
        .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      if (lines.length) return [...new Set(lines)];
    } catch { /* skip */ }
  }
  return defaultAddrs;
}

async function fetchMoolahV2Api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${MOOLAH_V2_API}${path}${qs ? `?${qs}` : ''}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const body = await r.json();
  if (body.code !== 200) throw new Error(body.message || `code ${body.code}`);
  return body.data ?? null;
}

export async function fetchJustLendV1(address) {
  const url = `https://openapi.just.network/lend/account?addresses=${encodeURIComponent(address)}&pageSize=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} JustLend V1`);
  const j = await r.json();
  return j.data?.list?.[0] ?? null;
}

export async function fetchJustLendV2(address) {
  const pos = await fetchMoolahV2Api('/index/position', { address });
  if (!pos) return null;
  const markets = [];
  for (const m of pos.markets || []) {
    let detail = null;
    if (m.marketId) {
      try {
        detail = await fetchMoolahV2Api('/market/position', { market: m.marketId, address });
      } catch { /* summary only */ }
    }
    markets.push({ summary: m, detail });
  }
  return { pos, markets };
}

/** @returns {{ address, v2Lines: Array, v1Health: number|null, v1HasBorrow: boolean }} */
export function extractHealthRows(address, v2raw, v1raw) {
  const v2Lines = [];
  for (const { summary, detail } of v2raw?.markets || []) {
    const collSym = detail?.collateralSymbol || summary?.collateralSymbol || '?';
    const borSym = detail?.borrowSymbol || summary?.borrowSymbol || '?';
    const borUsd = Number(detail?.borrowUsd ?? summary.borrowUsd ?? 0);
    const health = summary.health ?? detail?.risk ?? null;
    if (borUsd <= 0 && (health == null || Number(health) <= 0)) continue;
    v2Lines.push({
      market: `${collSym}/${borSym}`,
      marketId: summary.marketId || detail?.marketId || null,
      health: health != null ? Number(health) : null,
      borrowUsd: borUsd,
      collateralUsd: Number(detail?.collateralUsd ?? summary.collateralUsd ?? 0),
    });
  }

  let v1Health = null;
  let v1HasBorrow = false;
  if (v1raw) {
    v1Health = v1raw.health != null ? Number(v1raw.health) : null;
    v1HasBorrow = (v1raw.tokens || []).some((t) => Number(t.borrowBalanceUnderlying || 0) > 0);
  }

  return { address, v2Lines, v1Health, v1HasBorrow };
}

export async function scanLendHealth(addresses, { log = () => {}, pauseMs = 300 } = {}) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 1) {
    const addr = addresses[i];
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    let v2raw = null;
    let v1raw = null;
    try {
      [v2raw, v1raw] = await Promise.all([
        fetchJustLendV2(addr).catch((e) => { log(`V2 ${addr.slice(0, 8)}…: ${e.message}`); return null; }),
        fetchJustLendV1(addr).catch((e) => { log(`V1 ${addr.slice(0, 8)}…: ${e.message}`); return null; }),
      ]);
    } catch (e) {
      log(`查询失败 ${addr}: ${e.message}`);
      out.push({ address: addr, error: e.message, v2Lines: [], v1Health: null, v1HasBorrow: false });
      continue;
    }
    out.push(extractHealthRows(addr, v2raw, v1raw));
  }
  return out;
}
