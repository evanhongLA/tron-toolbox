#!/usr/bin/env node
/**
 * TRON 投票收益自动领取（独立工具，依赖 tronweb，Node 18+）
 * Auto-claim TRON voting (SR) rewards for one or more wallets.
 *
 * 逐个扫描钱包，查 getReward（未领取投票分红，单位 SUN）：
 *   有可领取的，就用 WithdrawBalanceContract 领取到该钱包自身余额。
 *
 * 领取条件：单钱包可领投票收益 ≥ CLAIM_MIN_REWARD_TRX（默认 100 TRX）才执行；低于阈值跳过。
 * 链上规则：每个账户 24h 只能领取一次；万一 <24h 记为冷却跳过。
 * 调度：推荐 crontab 每 2 天检查（见 claim-rewards-cron.sh.example）；--daemon 每 48h 检查一轮。
 *
 * 私钥（⚠️ 请只在自己可控的机器上使用；文件权限建议 chmod 600）：
 *   环境变量 PRIVATE_KEYS=hex1,hex2,…  或当前目录 keys.txt（一行一个 hex 私钥，# 注释）
 * 可选（受限 active 权限多签场景）：
 *   PERMISSION_ID=2   # 私钥为账户受限 active 权限（权限位需含 13 WithdrawBalance）时必填
 *
 * 用法：
 *   node claim-vote-rewards.mjs            # 交互终端=预览后 y/n
 *   node claim-vote-rewards.mjs --yes      # 直接执行（cron 用）
 *   node claim-vote-rewards.mjs --dry      # 只看可领取金额，不领
 *   node claim-vote-rewards.mjs --daemon   # 常驻，每 48h 检查，≥100 TRX 才领
 */
import './lib/env.mjs';
import readline from 'node:readline';
import fs from 'node:fs';
import { TronWeb } from 'tronweb';

const argv = process.argv.slice(2);
const DO = argv.includes('--yes');
const DRY = argv.includes('--dry') || argv.includes('--dry-run') || argv.includes('--preview');
const DAEMON = argv.includes('--daemon') || process.env.CLAIM_DAEMON === '1'; // 常驻：每 CHECK_INTERVAL_H 检查一轮
const _rawMinTrx = Number(process.env.CLAIM_MIN_REWARD_TRX ?? 100);
const MIN_REWARD_TRX = Number.isFinite(_rawMinTrx) && _rawMinTrx > 0 ? _rawMinTrx : 100;
const MIN_REWARD_SUN = Math.floor(MIN_REWARD_TRX * 1e6);
const _rawCheckH = Number(process.env.CLAIM_CHECK_INTERVAL_H ?? 48);
const CHECK_INTERVAL_H = Number.isFinite(_rawCheckH) && _rawCheckH > 0 ? _rawCheckH : 48; // daemon/cron 建议间隔（小时）
const CHECK_MS = CHECK_INTERVAL_H * 3600000;
const RETRY_COOLDOWN_MS = Number(process.env.CLAIM_RETRY_COOLDOWN_H ?? 25) * 3600000;
const RETRY_FAIL_MS = Number(process.env.CLAIM_RETRY_FAIL_H ?? 6) * 3600000;
const meetsThreshold = (sun) => Number(sun) >= MIN_REWARD_SUN;
const PERMISSION_ID = process.env.PERMISSION_ID ? Number(process.env.PERMISSION_ID) : null;

const FULL_HOST = process.env.TRON_FULL_HOST || 'https://api.trongrid.io';
const API_KEY = (process.env.TRONGRID_API_KEY || '').trim();
const tronWeb = new TronWeb({
  fullHost: FULL_HOST,
  ...(API_KEY ? { headers: { 'TRON-PRO-API-KEY': API_KEY } } : {}),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sa = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const trx = (sun) => (Number(sun) / 1e6).toFixed(6).replace(/\.?0+$/, '');
const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[claim-rewards]', ...a);

// ---- 私钥加载：PRIVATE_KEYS 环境变量或 keys.txt ----
function loadKeys() {
  let raw = (process.env.PRIVATE_KEYS || '').trim();
  if (!raw) {
    try { raw = fs.readFileSync('keys.txt', 'utf8'); } catch { /* ignore */ }
  }
  const keys = raw.split(/[,;\r\n]+/)
    .map((s) => s.trim().replace(/^0x/, ''))
    .filter((s) => s && !s.startsWith('#'));
  const bad = keys.find((k) => !/^[0-9a-fA-F]{64}$/.test(k));
  if (bad) { console.error(`私钥格式错误（应为 64 位 hex）：${bad.slice(0, 8)}…`); process.exit(1); }
  return [...new Set(keys)];
}

const WALLETS = loadKeys().map((pk) => ({
  pk,
  address: TronWeb.address.fromPrivateKey(pk),
}));

function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}
// cron（无 TTY）=直接执行；交互终端且未加 --yes=预览后 y/n 确认
async function confirm(q) {
  if (DO || !process.stdin.isTTY) return true;
  const a = await ask(`${q}  输入 y 确认 / 其它取消: `);
  return /^y(es)?$/i.test(a);
}

const isCooldown = (msg) => /less than 24|24 ?hours|drawing too|each account|Annot withdraw|cannot withdraw|too frequent|allowance/i.test(String(msg || ''));

async function claimOne({ address: owner, pk }) {
  let reward = 0;
  try { reward = Number(await tronWeb.trx.getReward(owner)) || 0; }
  catch (e) { return { owner, status: 'fail', reason: `查收益失败: ${e.message}` }; }
  if (reward <= 0) return { owner, status: 'none', reward: 0 };
  if (!meetsThreshold(reward)) return { owner, status: 'below', reward };
  if (DRY) return { owner, status: 'dry', reward };

  try {
    const opts = PERMISSION_ID != null ? { permissionId: PERMISSION_ID } : {};
    const tx = await tronWeb.transactionBuilder.withdrawBlockRewards(owner, opts);
    const signed = PERMISSION_ID != null
      ? await tronWeb.trx.multiSign(tx, pk, PERMISSION_ID)
      : await tronWeb.trx.sign(tx, pk);
    const res = await tronWeb.trx.broadcast(signed);
    const ok = res?.result === true || res?.code === 'SUCCESS' || res?.txid;
    if (!ok) {
      const m = res?.message ? Buffer.from(res.message, 'hex').toString('utf8') : JSON.stringify(res?.code || res);
      if (isCooldown(m)) return { owner, status: 'cooldown', reward, reason: m };
      return { owner, status: 'fail', reward, reason: m };
    }
    return { owner, status: 'ok', reward, txid: res.txid || res.transaction?.txID };
  } catch (e) {
    if (isCooldown(e.message)) return { owner, status: 'cooldown', reward, reason: e.message };
    return { owner, status: 'fail', reward, reason: e.message };
  }
}

async function doClaimRun({ requireConfirm }) {
  if (!WALLETS.length) { log('未配置私钥（PRIVATE_KEYS 环境变量或 keys.txt）'); return { fail: 1, ok: 0, cooldown: 0, claimable: 0 }; }
  log(`扫描 ${WALLETS.length} 个钱包${DRY ? '（--dry 仅预览）' : ''}${PERMISSION_ID != null ? ` · permissionId=${PERMISSION_ID}` : ''}`);

  const previews = [];
  for (const w of WALLETS) {
    let reward = 0;
    try { reward = Number(await tronWeb.trx.getReward(w.address)) || 0; } catch { reward = -1; }
    previews.push({ ...w, reward });
    const below = reward >= 0 && reward > 0 && !meetsThreshold(reward);
    log(`  ${sa(w.address)} 可领取 ${reward < 0 ? '查询失败' : `${trx(reward)} TRX${below ? `（未达 ${MIN_REWARD_TRX} TRX 阈值，跳过）` : ''}`}`);
    await sleep(200);
  }
  const claimable = previews.filter((p) => meetsThreshold(p.reward));
  const total = claimable.reduce((s, p) => s + p.reward, 0);
  const belowN = previews.filter((p) => p.reward > 0 && !meetsThreshold(p.reward)).length;
  log(`合计可领（≥${MIN_REWARD_TRX} TRX）：${trx(total)} TRX（${claimable.length}/${WALLETS.length} 个钱包；${belowN} 个未达阈值）`);

  if (DRY) { log('（--dry 模式，未领取）'); return { fail: 0, ok: 0, cooldown: 0, claimable: claimable.length }; }
  if (!claimable.length) { log('无可领取收益。'); return { fail: 0, ok: 0, cooldown: 0, claimable: 0 }; }
  if (requireConfirm && !(await confirm(`\n确认领取以上 ${claimable.length} 个钱包的投票收益?`))) { log('已取消。'); return { fail: 0, ok: 0, cooldown: 0, claimable: claimable.length }; }

  let ok = 0; let fail = 0; let cooldown = 0; let claimed = 0;
  for (const w of claimable) {
    const r = await claimOne(w);
    if (r.status === 'ok') { ok += 1; claimed += r.reward; log(`✅ ${sa(w.address)} 领取 ${trx(r.reward)} TRX  txid=${r.txid || ''}`); }
    else if (r.status === 'below') { log(`⏭ ${sa(w.address)} 跳过（${trx(r.reward)} TRX < ${MIN_REWARD_TRX} TRX）`); }
    else if (r.status === 'cooldown') { cooldown += 1; log(`⏳ ${sa(w.address)} 跳过（24h 冷却中）`); }
    else if (r.status === 'none') { /* 期间变 0 */ }
    else { fail += 1; log(`❌ ${sa(w.address)} 失败：${r.reason}`); }
    await sleep(1500);
  }
  log(`完成：成功 ${ok}（共 ${trx(claimed)} TRX）｜冷却跳过 ${cooldown}｜失败 ${fail}`);
  return { fail, ok, cooldown, claimable: claimable.length };
}

// ---- daemon：常驻，每 CHECK_INTERVAL_H 检查一轮（≥MIN_REWARD_TRX 才领）----
const LAST_FILE = new URL('./claim-vote-rewards.last', import.meta.url).pathname;
const PID_FILE = new URL('./claim-vote-rewards.pid', import.meta.url).pathname;
const readLast = () => { try { return Number(fs.readFileSync(LAST_FILE, 'utf8').trim()) || 0; } catch { return 0; } };
const writeLast = (t) => { try { fs.writeFileSync(LAST_FILE, String(t)); } catch { /* ignore */ } };

function logNextCheck(lastCheck) {
  if (!lastCheck) { log('首轮立即检查'); return; }
  const wait = lastCheck + CHECK_MS - Date.now();
  const nextAt = new Date(lastCheck + CHECK_MS).toISOString();
  if (wait <= 0) log(`距上次检查 ${((Date.now() - lastCheck) / 3600000).toFixed(1)}h，即将执行`);
  else log(`下次检查：${nextAt}（${(wait / 3600000).toFixed(1)}h 后）`);
}

async function runDaemon() {
  log(`daemon 启动：每 ${CHECK_INTERVAL_H}h 检查，单钱包 ≥${MIN_REWARD_TRX} TRX 才领  PID=${process.pid}`);
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* ignore */ }
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  logNextCheck(readLast());
  const bye = (sig) => { log(`收到 ${sig}，退出`); cleanup(); process.exit(0); };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));

  for (;;) {
    const lastCheck = readLast();
    if (lastCheck) {
      const wait = lastCheck + CHECK_MS - Date.now();
      if (wait > 0) { logNextCheck(lastCheck); await sleep(wait); }
    }
    log(`=== 开始检查（阈值 ≥${MIN_REWARD_TRX} TRX）===`);
    writeLast(Date.now());
    let result;
    try { result = await doClaimRun({ requireConfirm: false }); }
    catch (e) {
      log('本轮异常：', e.message); await sleep(RETRY_FAIL_MS); continue;
    }
    if (result.cooldown > 0 && result.fail === 0 && result.ok === 0) {
      log(`链上 24h 冷却（${result.cooldown} 个钱包），${RETRY_COOLDOWN_MS / 3600000}h 后重试`);
      await sleep(RETRY_COOLDOWN_MS);
      continue;
    }
    if (result.fail > 0) {
      log(`领取失败 ${result.fail} 个，${RETRY_FAIL_MS / 3600000}h 后重试`);
      await sleep(RETRY_FAIL_MS);
      continue;
    }
    log(`本轮完成：领取 ${result.ok} 个；${CHECK_INTERVAL_H}h 后再检查`);
    await sleep(CHECK_MS);
  }
}

(async () => {
  if (DAEMON) { await runDaemon(); return; }
  const r = await doClaimRun({ requireConfirm: true });
  if (r?.fail) process.exit(1);
})().catch((e) => { console.error(ts(), '[claim-rewards] 脚本出错：', e.message); process.exit(1); });
