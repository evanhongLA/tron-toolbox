#!/usr/bin/env node
/**
 * TRON 钱包 TRX 入账统计（独立工具，零依赖，仅用 Node 内置 fetch，Node 18+）
 * TRX income report: daily × wallet income table + CSV + self-contained HTML.
 *
 * 作用：从 TronGrid 拉取若干钱包在 [START_DATE, 运行当天] 内的原生 TRX 转账入账，
 *       （可选）只保留来自指定发送方的入账，输出每日×各钱包收入表 + 汇总 + CSV + HTML。
 *
 * 配置：
 *   wallets.txt   必填：一行一个 T 地址（# 注释；或 WALLETS=T…,T… 环境变量）
 *   senders.txt   可选：只统计来自这些地址的入账；不提供则统计全部入账
 *   .env / 环境变量：
 *     TRONGRID_API_KEY=xxx        （可选，无 Key 走免费限流档）
 *     START_DATE=2026-06-01       （可选，默认 30 天前）
 *     REPORT_TZ=Asia/Shanghai     （可选，默认系统时区）
 *     REPORT_INCLUDE_REWARDS=0    （可选，默认统计投票分红领取）
 *
 * 运行：node tron-income-report.mjs
 */
import './lib/env.mjs';
import fs from 'node:fs';
import { ui, ESC, printTable } from './lib/terminal-ui.mjs';
import { loadWallets, requireWallets } from './lib/wallets.mjs';

// ============== 配置 ==============
const WALLETS = requireWallets(
  loadWallets('wallets.txt', { envVar: 'WALLETS', baseUrl: import.meta.url, label: '钱包' }),
  'wallets.txt', 'WALLETS',
);
const SENDERS = loadWallets('senders.txt', { envVar: 'SENDERS', baseUrl: import.meta.url, label: '发送方' }); // 可为空=统计全部入账
const REPORT_TZ = process.env.REPORT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const START_DATE = process.env.START_DATE
  || dayKeyInTimeZone(Date.now() - 30 * 86400_000, REPORT_TZ); // 默认最近 30 天
const FULL_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io'; // 测试网 https://nile.trongrid.io
const INCLUDE_REWARDS = (process.env.REPORT_INCLUDE_REWARDS ?? '1') !== '0';
const DETAIL_DISPLAY_LIMIT = 100; // HTML 明细表最多展示最新 N 笔（CSV 仍导出全部）
// =================================

const API_KEY = (process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY || '').trim();
const headers = API_KEY ? { 'TRON-PRO-API-KEY': API_KEY } : {};

// ---- 时区工具（零依赖，Intl 实现）----
function dayKeyInTimeZone(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function formatLogTime(ts, tz) {
  return new Date(ts).toLocaleString('sv-SE', { timeZone: tz });
}
/** 求 YYYY-MM-DD 在指定时区的当日 0 点对应的 UTC 毫秒 */
function parseDayStartMs(dateStr, tz) {
  const targetUtc = Date.parse(`${dateStr}T00:00:00Z`);
  let guess = targetUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(guess));
    const g = (t) => p.find((x) => x.type === t).value;
    const hour = g('hour') === '24' ? '00' : g('hour');
    const local = Date.parse(`${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:${g('second')}Z`);
    if (local === targetUtc) break;
    guess += targetUtc - local;
  }
  return guess;
}

const startMs = parseDayStartMs(START_DATE, REPORT_TZ);
const endMs = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (ts) => dayKeyInTimeZone(ts, REPORT_TZ);
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// base58check → hex（取前 21 字节 = 0x41+20，用于和 API 的 owner_address 比对，免装 tronweb）
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58ToHex21(s) {
  let num = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`非法 base58 字符: ${c}`);
    num = num * 58n + BigInt(i);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  hex = hex.padStart(50, '0');
  return hex.slice(0, 42).toLowerCase();
}
const SENDERS_HEX = new Set(SENDERS.map((s) => b58ToHex21(s))); // 为空=不过滤发送方

async function fetchPage(addr, fingerprint, { dir = 'to' } = {}) {
  const url = new URL(`${FULL_HOST}/v1/accounts/${addr}/transactions`);
  if (dir === 'to') url.searchParams.set('only_to', 'true');        // 入账
  else if (dir === 'from') url.searchParams.set('only_from', 'true'); // 本钱包发起（含投票领取）
  url.searchParams.set('only_confirmed', 'true');
  url.searchParams.set('min_timestamp', String(startMs));
  url.searchParams.set('max_timestamp', String(endMs));
  url.searchParams.set('order_by', 'block_timestamp,asc');
  url.searchParams.set('limit', '200');
  if (fingerprint) url.searchParams.set('fingerprint', fingerprint);

  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`TronGrid ${r.status}: ${await r.text()}`);
    return r.json();
  }
  throw new Error('多次重试仍失败（限流？）');
}

// 入账：TransferContract（若配置了 senders 则只保留匹配的发送方）
async function collectForWallet(addr) {
  const rows = [];
  let fingerprint = null;
  for (let guard = 0; guard < 1000; guard++) {
    const json = await fetchPage(addr, fingerprint, { dir: 'to' });
    for (const tx of json.data || []) {
      const c = tx.raw_data?.contract?.[0];
      if (c?.type !== 'TransferContract') continue;
      if (tx.ret?.[0]?.contractRet !== 'SUCCESS') continue;
      const v = c.parameter?.value || {};
      const from = (v.owner_address || '').toLowerCase();
      if (SENDERS_HEX.size && !SENDERS_HEX.has(from)) continue;
      const amountTrx = Number(v.amount || 0) / 1e6;
      if (amountTrx <= 0) continue;
      rows.push({ wallet: addr, ts: tx.block_timestamp, day: dayKey(tx.block_timestamp), amountTrx, txid: tx.txID, kind: 'rental', from });
    }
    fingerprint = json.meta?.fingerprint;
    if (!fingerprint || (json.data || []).length === 0) break;
    await sleep(250);
  }
  return rows;
}

// 投票收益：本钱包发起的 WithdrawBalanceContract，金额取顶层 withdraw_amount
async function collectWithdrawsForWallet(addr) {
  const rows = [];
  let fingerprint = null;
  for (let guard = 0; guard < 1000; guard++) {
    const json = await fetchPage(addr, fingerprint, { dir: 'from' });
    for (const tx of json.data || []) {
      const c = tx.raw_data?.contract?.[0];
      if (c?.type !== 'WithdrawBalanceContract') continue;
      if (tx.ret?.[0]?.contractRet !== 'SUCCESS') continue;
      const amountTrx = Number(tx.withdraw_amount || 0) / 1e6;
      if (amountTrx <= 0) continue;
      rows.push({ wallet: addr, ts: tx.block_timestamp, day: dayKey(tx.block_timestamp), amountTrx, txid: tx.txID, kind: 'reward', from: '—' });
    }
    fingerprint = json.meta?.fingerprint;
    if (!fingerprint || (json.data || []).length === 0) break;
    await sleep(250);
  }
  return rows;
}

function daysInRange() {
  const out = [];
  for (let t = startMs; t <= endMs; t += 86400_000) out.push(dayKey(t));
  const last = dayKey(endMs);
  if (out[out.length - 1] !== last) out.push(last);
  return [...new Set(out)];
}

(async () => {
  ui.title('TRX 入账报表');
  if (!API_KEY) ui.warn('未读到 TRONGRID_API_KEY，将用免费限流档');
  const senderNote = SENDERS.length ? `发送方 ${SENDERS.length} 个` : '全部入账';
  ui.subtitle(`${START_DATE} ~ 现在（${REPORT_TZ}）· ${senderNote}${INCLUDE_REWARDS ? ' · 含投票收益' : ''}`);
  ui.info('正在从 TronGrid 拉取数据…');
  const all = [];
  for (const w of WALLETS) {
    const rows = await collectForWallet(w);
    all.push(...rows);
    let line = `入账 ${rows.length} 笔 · ${rows.reduce((s, r) => s + r.amountTrx, 0).toFixed(6)} TRX`;
    if (INCLUDE_REWARDS) {
      const wr = await collectWithdrawsForWallet(w);
      all.push(...wr);
      line += `  ｜  投票 ${wr.length} 笔 · ${wr.reduce((s, r) => s + r.amountTrx, 0).toFixed(6)} TRX`;
    }
    ui.row(shortAddr(w), line);
    await sleep(300);
  }

  const days = daysInRange();
  const matrix = {};
  for (const d of days) matrix[d] = Object.fromEntries(WALLETS.map((w) => [w, 0]));
  for (const r of all) { if (matrix[r.day]) matrix[r.day][r.wallet] += r.amountTrx; }

  const perWalletTotal = Object.fromEntries(WALLETS.map((w) => [w, all.filter((r) => r.wallet === w).reduce((s, r) => s + r.amountTrx, 0)]));
  const rentalTotal = all.filter((r) => r.kind !== 'reward').reduce((s, r) => s + r.amountTrx, 0);
  const rewardTotal = all.filter((r) => r.kind === 'reward').reduce((s, r) => s + r.amountTrx, 0);
  const grandTotal = all.reduce((s, r) => s + r.amountTrx, 0);
  const dayCount = days.length;
  const avgPerDay = dayCount > 0 ? grandTotal / dayCount : 0;
  const daysWithIncome = days.filter((d) => WALLETS.some((w) => matrix[d][w] > 0)).length;

  ui.section('每日汇总');
  const CONSOLE_MATRIX_MAX_WALLETS = 6;
  if (WALLETS.length <= CONSOLE_MATRIX_MAX_WALLETS) {
    const head = ['日期', ...WALLETS.map(shortAddr), '合计'];
    const rows = days.map((d) => {
      const dayTotal = WALLETS.reduce((s, w) => s + matrix[d][w], 0);
      return [d, ...WALLETS.map((w) => matrix[d][w].toFixed(4)), dayTotal.toFixed(4)];
    });
    rows.push(['总计', ...WALLETS.map((w) => perWalletTotal[w].toFixed(4)), grandTotal.toFixed(4)]);
    printTable(head, rows);
  } else {
    printTable(['日期', '当日总收入'], days.map((d) => [d, WALLETS.reduce((s, w) => s + matrix[d][w], 0).toFixed(4)]));
    ui.hint(`${WALLETS.length} 个钱包，完整矩阵见 CSV`);
  }

  ui.section('汇总');
  ui.box([
    `总收入 ${ESC.bold}${grandTotal.toFixed(6)} TRX${ESC.reset}`,
    `  ├ 转账入账 ${rentalTotal.toFixed(6)} TRX`,
    `  └ 投票收益 ${rewardTotal.toFixed(6)} TRX${INCLUDE_REWARDS ? '' : '（已关闭统计）'}`,
    `统计 ${dayCount} 天（${days[0]} ~ ${days[days.length - 1]}），有收入 ${daysWithIncome} 天`,
    `日均 ${avgPerDay.toFixed(6)} TRX  ·  匹配 ${all.length} 笔`,
  ]);
  for (const w of WALLETS) ui.row(shortAddr(w), `${perWalletTotal[w].toFixed(6)} TRX`);

  const stamp = dayKey(endMs);
  let csv = '日期,' + WALLETS.join(',') + ',当日合计\n';
  for (const d of days) {
    const dayTotal = WALLETS.reduce((s, w) => s + matrix[d][w], 0);
    csv += `${d},` + WALLETS.map((w) => matrix[d][w].toFixed(6)).join(',') + `,${dayTotal.toFixed(6)}\n`;
  }
  csv += '总计,' + WALLETS.map((w) => perWalletTotal[w].toFixed(6)).join(',') + `,${grandTotal.toFixed(6)}\n`;
  csv += `\n总收入,${grandTotal.toFixed(6)}\n转账入账,${rentalTotal.toFixed(6)}\n投票收益,${rewardTotal.toFixed(6)}\n统计天数,${dayCount}\n有收入天数,${daysWithIncome}\n平均每日总收入,${avgPerDay.toFixed(6)}\n匹配笔数,${all.length}\n`;
  const sumFile = `tron-income-${stamp}.csv`;
  fs.writeFileSync(sumFile, '﻿' + csv);

  let det = '日期,钱包,类型,来源,金额(TRX),时间,txid\n';
  for (const r of all.sort((a, b) => b.ts - a.ts)) {
    det += `${r.day},${r.wallet},${r.kind === 'reward' ? '投票' : '转账'},${r.from},${r.amountTrx.toFixed(6)},${formatLogTime(r.ts, REPORT_TZ)},${r.txid}\n`;
  }
  const detFile = `tron-income-${stamp}-detail.csv`;
  fs.writeFileSync(detFile, '﻿' + det);

  // ---- 自包含 HTML（双击用浏览器打开，零依赖，支持日期/钱包/类型/金额筛选）----
  const f6 = (n) => n.toFixed(6);
  const fmtTime = (ts) => formatLogTime(ts, REPORT_TZ);
  const jsonWallets = JSON.stringify(WALLETS);
  const jsonShortWallets = JSON.stringify(WALLETS.map(shortAddr));
  const jsonDays = JSON.stringify(days);
  const jsonMatrix = JSON.stringify(days.map((d) => WALLETS.map((w) => matrix[d][w])));
  const jsonPerWallet = JSON.stringify(WALLETS.map((w) => perWalletTotal[w]));
  const detailSortedDesc = all.slice().sort((a, b) => b.ts - a.ts);
  const detailForHtml = detailSortedDesc.slice(0, DETAIL_DISPLAY_LIMIT);
  const jsonDetail = JSON.stringify(detailForHtml.map((r) => ({
    ts: fmtTime(r.ts), tsRaw: r.ts,
    wallet: r.wallet, walletShort: shortAddr(r.wallet),
    kind: r.kind === 'reward' ? '投票' : '转账',
    kindRaw: r.kind,
    amount: r.amountTrx, from: r.from,
    txid: r.txid,
  })));

  const html = `<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>TRX 入账报表 ${stamp}</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;max-width:1200px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 8px} .sub{color:#888;margin:0 0 16px;font-size:13px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 4px}
.card{border:1px solid #8884;border-radius:10px;padding:10px 14px;min-width:120px}
.card .k{color:#888;font-size:12px} .card .v{font-size:18px;font-weight:700;margin-top:2px}
.hl{background:#3b82f618}
table{border-collapse:collapse;width:100%;margin-top:6px;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid #8883;padding:7px 10px;text-align:left;white-space:nowrap}
thead th{position:sticky;top:0;background:#88881a;backdrop-filter:blur(4px)}
td.num,th.num{text-align:right} .total td{font-weight:700;border-top:2px solid #8886}
tbody tr:hover{background:#8881}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace} a{color:#3b82f6;text-decoration:none}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0;padding:12px;border:1px solid #8883;border-radius:8px}
.filters label{display:flex;align-items:center;gap:4px;font-size:13px}
.filters input[type=date]{font-size:13px;padding:3px 6px;border:1px solid #8884;border-radius:4px;background:transparent;color:inherit}
.filters select{font-size:13px;padding:3px 6px;border:1px solid #8884;border-radius:4px;background:transparent;color:inherit}
.filter-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filter-group label{cursor:pointer}
.summary-line{margin:8px 0;font-size:13px;color:#888}
.hidden{display:none!important}
</style></head><body>
<h1>TRX 入账报表</h1>
<p class=sub>区间 ${days[0]} ~ ${days[days.length - 1]}（${REPORT_TZ}）· ${senderNote}${INCLUDE_REWARDS ? ' · 含投票收益' : ''} · 生成于 ${fmtTime(endMs)}</p>
<div class=cards>
  <div class="card hl"><div class=k>总收入</div><div class=v id=summaryTotal>${f6(grandTotal)} TRX</div></div>
  <div class=card><div class=k>转账入账</div><div class=v id=summaryRental>${f6(rentalTotal)} TRX</div></div>
  <div class=card><div class=k>投票收益</div><div class=v id=summaryReward>${f6(rewardTotal)} TRX</div></div>
  <div class="card hl"><div class=k>平均每日总收入（/<span id=summaryDays>${dayCount}</span>天）</div><div class=v id=summaryAvg>${f6(avgPerDay)} TRX</div></div>
  <div class=card><div class=k>统计天数 / 有收入</div><div class=v>${dayCount} / ${daysWithIncome} 天</div></div>
  <div class=card><div class=k>匹配笔数</div><div class=v id=summaryCount>${all.length}</div></div>
</div>
<div class=cards id=perWalletCards>${WALLETS.map((w, i) => `<div class=card><div class=k title="${w}">${shortAddr(w)}</div><div class="v wallet-total" data-idx="${i}">${f6(perWalletTotal[w])} TRX</div></div>`).join('')}</div>

<div class=filters id=filters>
  <div class=filter-group>
    <label>起始：<input type=date id=filterStart></label>
    <label>结束：<input type=date id=filterEnd></label>
  </div>
  <div class=filter-group>
    <label>类型：
      <select id=filterKind><option value="">全部</option><option value=rental>转账</option><option value=reward>投票</option></select>
    </label>
  </div>
  <div class=filter-group id=walletFilters>
    <label><input type=checkbox class=wallet-cb checked data-idx="-1"> 全选</label>
    ${WALLETS.map((w, i) => `<label><input type=checkbox class=wallet-cb checked data-idx="${i}"> ${shortAddr(w)}</label>`).join('')}
  </div>
  <div class=filter-group>
    <label>最低金额：<input type=number id=filterMin step=0.01 min=0 style="width:80px"></label>
    <label>最高金额：<input type=number id=filterMax step=0.01 min=0 style="width:80px"></label>
  </div>
</div>

<p class=summary-line id=filterSummary></p>

<h2>每日 × 各钱包（TRX）</h2>
<table><thead><tr><th>日期</th>${WALLETS.map((w) => `<th class=num title="${w}">${shortAddr(w)}</th>`).join('')}<th class=num>当日合计</th></tr></thead>
<tbody id=matrixBody></tbody></table>

<h2>明细（最新 ${Math.min(DETAIL_DISPLAY_LIMIT, all.length)} 笔，共 ${all.length} 笔）</h2>
<table><thead><tr><th>时间</th><th>钱包</th><th>类型</th><th class=num>金额(TRX)</th><th>txid</th></tr></thead>
<tbody id=detBody></tbody></table>

<script>
(function(){
  var WALLETS = ${jsonWallets};
  var SHORT = ${jsonShortWallets};
  var DAYS = ${jsonDays};
  var MATRIX = ${jsonMatrix};
  var PER_WALLET = ${jsonPerWallet};
  var DETAIL = ${jsonDetail};
  var DETAIL_ALL_COUNT = ${all.length};
  var DETAIL_DISPLAY_LIMIT = ${DETAIL_DISPLAY_LIMIT};
  var BEGIN_DAY = '${days[0]}';
  var END_DAY = '${days[days.length - 1]}';

  var filterStart = document.getElementById('filterStart');
  var filterEnd = document.getElementById('filterEnd');
  var filterKind = document.getElementById('filterKind');
  var filterMin = document.getElementById('filterMin');
  var filterMax = document.getElementById('filterMax');
  var walletCbs = document.querySelectorAll('.wallet-cb');
  var detBody = document.getElementById('detBody');
  var matrixBody = document.getElementById('matrixBody');
  var filterSummary = document.getElementById('filterSummary');

  filterStart.value = BEGIN_DAY;
  filterEnd.value = END_DAY;

  function selectedWallets() {
    var sel = [];
    walletCbs.forEach(function(cb) {
      if (cb.checked && parseInt(cb.dataset.idx) >= 0) sel.push(parseInt(cb.dataset.idx));
    });
    return sel;
  }

  function allWalletsSelected() {
    return walletCbs.length - 1 === selectedWallets().length;
  }

  function render() {
    var sd = filterStart.value || BEGIN_DAY;
    var ed = filterEnd.value || END_DAY;
    var kind = filterKind.value;
    var minAmt = parseFloat(filterMin.value) || 0;
    var maxAmt = parseFloat(filterMax.value) || Infinity;
    var wallets = selectedWallets();

    var filtered = DETAIL.filter(function(r) {
      if (kind && r.kindRaw !== kind) return false;
      if (r.amount < minAmt || r.amount > maxAmt) return false;
      if (wallets.length && wallets.indexOf(WALLETS.indexOf(r.wallet)) === -1) return false;
      var d = r.ts.slice(0,10);
      return d >= sd && d <= ed;
    }).sort(function(a, b) { return b.tsRaw - a.tsRaw; });
    if (filtered.length) {
      detBody.innerHTML = filtered.map(function(r) {
        return '<tr><td>'+r.ts+'</td><td title="'+r.wallet+'">'+r.walletShort+'</td><td>'+(r.kindRaw === 'reward' ? '投票' : '转账')+'</td><td class=num>'+r.amount.toFixed(6)+'</td><td class=mono><a href="https://tronscan.org/#/transaction/'+r.txid+'" target=_blank rel=noopener>'+r.txid.slice(0,14)+'…</a></td></tr>';
      }).join('');
    } else {
      detBody.innerHTML = '<tr><td colspan=5>（无匹配数据）</td></tr>';
    }

    var visibleDays = DAYS.filter(function(d) { return d >= sd && d <= ed; });
    if (visibleDays.length && wallets.length) {
      matrixBody.innerHTML = visibleDays.map(function(d) {
        var idx = DAYS.indexOf(d);
        var row = MATRIX[idx];
        var dayTotal = wallets.reduce(function(s, wi) { return s + row[wi]; }, 0);
        if (dayTotal === 0) return '';
        return '<tr><td>'+d+'</td>'+wallets.map(function(wi) { return '<td class=num>'+(row[wi] ? row[wi].toFixed(4) : '0.0000')+'</td>'; }).join('')+'<td class=num>'+dayTotal.toFixed(4)+'</td></tr>';
      }).filter(function(r) { return r; }).join('');
      var grandRow = wallets.reduce(function(s, wi) { return s + PER_WALLET[wi]; }, 0);
      matrixBody.innerHTML += '<tr class=total><td>总计</td>'+wallets.map(function(wi) { return '<td class=num>'+PER_WALLET[wi].toFixed(4)+'</td>'; }).join('')+'<td class=num>'+grandRow.toFixed(4)+'</td></tr>';
    } else {
      matrixBody.innerHTML = '<tr><td colspan='+(WALLETS.length+1)+'>（无匹配数据）</td></tr>';
    }

    var activeWallets = allWalletsSelected() ? '全部钱包' : wallets.length + '个/' + WALLETS.length + '钱包';
    var detailNote = DETAIL_ALL_COUNT > DETAIL_DISPLAY_LIMIT
      ? ' · 明细仅展示最新 ' + DETAIL_DISPLAY_LIMIT + ' 笔（共 ' + DETAIL_ALL_COUNT + ' 笔，完整见 CSV）'
      : '';
    filterSummary.textContent = '筛选：' + activeWallets + (kind ? ' · 类型：' + (kind === 'rental' ? '转账' : '投票') : '') + (minAmt > 0 ? ' · ≥' + minAmt + ' TRX' : '') + (maxAmt < Infinity ? ' · ≤' + maxAmt + ' TRX' : '') + ' · ' + sd + ' ~ ' + ed + '（匹配 ' + filtered.length + ' 笔' + detailNote + '）';
  }

  walletCbs.forEach(function(cb) {
    cb.addEventListener('change', function() {
      if (parseInt(this.dataset.idx) === -1) {
        walletCbs.forEach(function(c) { c.checked = this.checked; }, this);
      }
      render();
    });
  });

  filterStart.addEventListener('change', render);
  filterEnd.addEventListener('change', render);
  filterKind.addEventListener('change', render);
  filterMin.addEventListener('input', render);
  filterMax.addEventListener('input', render);

  render();
})();
</script>
</body></html>`;
  const htmlFile = `tron-income-${stamp}.html`;
  fs.writeFileSync(htmlFile, html);

  ui.section('输出文件');
  ui.ok(`${htmlFile}  ← 浏览器打开（推荐）`);
  ui.row('CSV 汇总', sumFile);
  ui.row('CSV 明细', detFile);
})().catch((e) => { ui.err(`脚本出错：${e.message}`); process.exit(1); });
