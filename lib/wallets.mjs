/**
 * 地址列表加载（零依赖，通用）
 *
 * 文件格式（一行一个）：
 *   T地址                     # 仅地址
 *   T地址 别名                # 地址 + 显示别名（空格/Tab 分隔）
 *   # 开头为注释，空行忽略
 *
 * 也可用环境变量兜底（逗号分隔）。
 */
import fs from 'node:fs';

const LABELS = new Map();

/** 读 <文件>（当前目录 → 指定基准目录），返回地址数组；别名写入 LABELS */
export function loadWallets(filename, { envVar = '', baseUrl = null, label = '地址' } = {}) {
  const candidates = [filename];
  if (baseUrl) {
    try { candidates.push(new URL(`../${filename}`, baseUrl).pathname); } catch { /* ignore */ }
  }
  for (const p of candidates) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const addrs = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [addr, ...rest] = t.split(/\s+/);
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) continue;
      addrs.push(addr);
      if (rest.length) LABELS.set(addr, rest.join(' '));
    }
    if (addrs.length) return [...new Set(addrs)];
  }
  if (envVar && (process.env[envVar] || '').trim()) {
    const addrs = process.env[envVar].split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (addrs.length) return [...new Set(addrs)];
  }
  return [];
}

export function getWalletLabel(addr) {
  return LABELS.get(addr) || null;
}

export function requireWallets(list, filename, envVar) {
  if (list.length) return list;
  console.error(`缺少地址：请在当前目录创建 ${filename}（一行一个 T 地址，可跟别名），或设置环境变量 ${envVar}=T地址1,T地址2`);
  process.exit(1);
}
