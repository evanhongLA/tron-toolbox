#!/usr/bin/env node
/**
 * JustLend 借币仓位风险系数监控（独立工具，零依赖，Node 18+）
 * JustLend (TRON) borrow-position liquidation-risk monitor with Telegram alerts.
 *
 * 数据来源：Moolah SBM V2 REST + JustLend V1 openapi
 * ——不是链上扫块；风险系数随抵押/借款资产价格（预言机）变化，通常分钟级滞后。
 *
 * 默认：SBM V2 风险系数 ≥ 0.92 时告警（1=清算，越接近 1 越危险）；
 *       V1 遗留仓位健康因子 ≤ 1.05 时告警（传统 HF，>1 安全）。
 *
 * 用法：
 *   node justlend-health-watch.mjs                # 单次检查 + 告警
 *   node justlend-health-watch.mjs --dry          # 只打印，不发告警
 *   node justlend-health-watch.mjs --daemon       # 常驻轮询（默认每 10 分钟）
 *   node justlend-health-watch.mjs --test-notify  # 发一条测试 TG（不查仓位）
 *
 * 地址：当前目录 lend-wallets.txt（一行一个 T 地址）或环境变量 LEND_WALLETS=T…,T…
 * 告警（.env 或环境变量）：
 *   TELEGRAM_BOT_TOKEN=xxx   TELEGRAM_CHAT_ID=xxx
 * 可调参数（可选）：
 *   LEND_HEALTH_THRESHOLD=0.92  LEND_V1_HEALTH_MIN=1.05
 *   LEND_HEALTH_WATCH_INTERVAL_MS / LEND_HEALTH_ALERT_COOLDOWN_MS / LEND_HEALTH_RECOVER_GAP
 */
import './lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ui, shortAddr } from './lib/terminal-ui.mjs';
import { scanLendHealth } from './lib/justlend.mjs';
import { loadWallets, requireWallets } from './lib/wallets.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(SCRIPT_DIR, 'justlend-health-watch.pid');
const STATE_FILE = path.join(SCRIPT_DIR, 'justlend-health-watch.state.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry') || argv.includes('--preview');
const DAEMON = argv.includes('--daemon');
const TEST_NOTIFY = argv.includes('--test-notify');

const THRESHOLD = Number(process.env.LEND_HEALTH_THRESHOLD ?? 0.92);
const V1_HF_MIN = Number(process.env.LEND_V1_HEALTH_MIN ?? 1.05); // V1 遗留为传统健康因子（>1 安全）
const INTERVAL_MS = Number(process.env.LEND_HEALTH_WATCH_INTERVAL_MS ?? 10 * 60_000);
const COOLDOWN_MS = Number(process.env.LEND_HEALTH_ALERT_COOLDOWN_MS ?? 60 * 60_000);
const RECOVER_GAP = Number(process.env.LEND_HEALTH_RECOVER_GAP ?? 0.05);

const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '').trim();
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || '').trim();

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[lend-health]', ...a);

function isDangerV2(value) {
  if (value == null || !Number.isFinite(value)) return false;
  return value >= THRESHOLD;
}

function isRecoveredV2(value) {
  if (value == null || !Number.isFinite(value)) return true;
  return value <= THRESHOLD - RECOVER_GAP;
}

function isDangerV1(hf) {
  if (hf == null || !Number.isFinite(hf)) return false;
  return hf <= V1_HF_MIN;
}

function isRecoveredV1(hf) {
  if (hf == null || !Number.isFinite(hf)) return true;
  return hf >= V1_HF_MIN + 0.05;
}

function rowKey(wallet, scope, market) {
  return `${wallet}|${scope}|${market || 'all'}`;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { alerts: {} }; }
}

function saveState(st) {
  try { fs.writeFileSync(STATE_FILE, `${JSON.stringify(st, null, 2)}\n`); } catch { /* ignore */ }
}

async function notifyTG(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

async function dispatchAlert(title, body, stateKey) {
  const st = loadState();
  const last = st.alerts[stateKey] || 0;
  if (Date.now() - last < COOLDOWN_MS) {
    log(`冷却中，跳过重复告警 ${stateKey}`);
    return false;
  }
  const tgOk = await notifyTG(`${title}\n${body}`).catch((e) => { log('TG 失败:', e.message); return false; });
  if (!tgOk) {
    log('⚠️ 未发出告警（请配置 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID）');
    return false;
  }
  st.alerts[stateKey] = Date.now();
  saveState(st);
  log(`已告警 ${stateKey}`);
  return true;
}

function formatRowV2(wallet, market, risk, extra = '') {
  return `• ${shortAddr(wallet)} SBM V2 ${market} 风险系数 ${risk?.toFixed?.(3) ?? risk} (≥${THRESHOLD} 告警，1=清算)${extra ? ` · ${extra}` : ''}`;
}

function formatRowV1(wallet, hf) {
  return `• ${shortAddr(wallet)} V1 健康因子 ${hf?.toFixed?.(3) ?? hf} (≤${V1_HF_MIN} 告警，传统 >1 安全)`;
}

function loadAddresses() {
  return loadWallets('lend-wallets.txt', { envVar: 'LEND_WALLETS', baseUrl: import.meta.url, label: '借币地址' });
}

async function runCheck() {
  const addrs = requireWallets(loadAddresses(), 'lend-wallets.txt', 'LEND_WALLETS');
  log(`扫描 ${addrs.length} 个借币钱包 · V2 风险系数 ≥ ${THRESHOLD} 告警 · 间隔 ${INTERVAL_MS / 60000}min`);

  const rows = await scanLendHealth(addrs, { log: (m) => log(m) });
  const st = loadState();
  const danger = [];
  const recovered = [];

  for (const w of rows) {
    if (w.error) continue;
    for (const line of w.v2Lines) {
      if (line.borrowUsd <= 0) continue;
      const key = rowKey(w.address, 'V2', line.market);
      const h = line.health;
      const prevAlert = st.alerts[key];
      if (isDangerV2(h)) {
        danger.push(formatRowV2(w.address, line.market, h, `借 $${line.borrowUsd.toFixed(0)}`));
        if (!DRY) await dispatchAlert(
          `🚨 JustLend 风险告警 SBM V2`,
          formatRowV2(w.address, line.market, h, `借 $${line.borrowUsd.toFixed(0)} 抵 $${line.collateralUsd.toFixed(0)}`),
          key,
        );
      } else if (prevAlert && isRecoveredV2(h)) {
        recovered.push(formatRowV2(w.address, line.market, h));
        delete st.alerts[key];
      }
    }
    if (w.v1HasBorrow && w.v1Health != null) {
      const key = rowKey(w.address, 'V1', 'legacy');
      const h = w.v1Health;
      if (isDangerV1(h)) {
        danger.push(formatRowV1(w.address, h));
        if (!DRY) await dispatchAlert(
          `🚨 JustLend 风险告警 V1`,
          formatRowV1(w.address, h),
          key,
        );
      } else if (st.alerts[key] && isRecoveredV1(h)) {
        recovered.push(formatRowV1(w.address, h));
        delete st.alerts[key];
      }
    }
  }
  saveState(st);

  if (DRY || !danger.length) {
    for (const w of rows) {
      for (const line of w.v2Lines) {
        if (line.health != null) {
          ui.row(`${shortAddr(w.address)} V2 ${line.market}`, `${line.health.toFixed(3)} · 借 $${line.borrowUsd.toFixed(0)}`);
        }
      }
      if (w.v1Health != null) ui.row(`${shortAddr(w.address)} V1`, w.v1Health.toFixed(3));
    }
  }
  if (danger.length) log(`⚠️ 危险 ${danger.length} 项:\n${danger.join('\n')}`);
  else log('✓ 均在阈值外（安全）');
  if (recovered.length) log(`✅ 已恢复 ${recovered.length} 项`);
}

async function runDaemon() {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  log(`daemon 启动 PID=${process.pid} 每 ${INTERVAL_MS / 60000}min 轮询`);
  for (;;) {
    try { await runCheck(); } catch (e) { log('轮询异常:', e.message); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

async function runTestNotify() {
  const body = [
    '这是一条 JustLend 借币风险监控的测试告警（非真实清算）。',
    `时间 ${new Date().toISOString()}`,
    `当前阈值 V2≥${THRESHOLD} · V1 HF≤${V1_HF_MIN}`,
    TG_CHAT ? `TG chat → ${TG_CHAT}` : 'TG 未配置',
  ].join('\n');
  log('发送测试告警…');
  const tgOk = await notifyTG(`🧪 JustLend 风险告警测试\n${body}`).catch((e) => { log('TG 失败:', e.message); return false; });
  if (tgOk) log('✓ TG 已发送');
  else { log('✗ TG 未发送（检查 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）'); process.exit(1); }
}

(async () => {
  if (TG_TOKEN && TG_CHAT) log(`TG 告警 → chat ${TG_CHAT}`);
  else log('未配置 TG（TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID），只打印不告警');
  if (TEST_NOTIFY) { await runTestNotify(); return; }
  if (DAEMON) await runDaemon();
  else await runCheck();
})().catch((e) => { console.error(ts(), '[lend-health] fatal:', e.message); process.exit(1); });
