/**
 * TRON Toolbox · 终端 UI（Node 脚本共用，零依赖）
 * Shared terminal UI helpers for the toolbox scripts. Zero dependencies.
 */
import readline from 'node:readline';

export const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
export const ESC = COLOR ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
} : { reset: '', bold: '', dim: '', cyan: '', green: '', yellow: '', red: '', blue: '', magenta: '' };

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** 短地址：TKYdx…KNPH（默认前 5 + 后 4） */
export function shortAddr(addr, { head = 5, tail = 4 } = {}) {
  const a = String(addr || '').trim();
  if (!a) return '—';
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}
export const sa = (a, head = 5) => shortAddr(a, { head, tail: 4 });
export const k = (n) => Number(n).toLocaleString();
export const kk = (n) => (n == null || !Number.isFinite(n) ? '—' : `${Math.round(n / 1000)}k`);

export const ui = {
  title(text) {
    const inner = ` ${text} `;
    const bar = '═'.repeat(Math.max(40, inner.length));
    console.log(`\n${ESC.cyan}${ESC.bold}╔${bar}╗${ESC.reset}`);
    console.log(`${ESC.cyan}${ESC.bold}║${inner.padEnd(bar.length)}║${ESC.reset}`);
    console.log(`${ESC.cyan}${ESC.bold}╚${bar}╝${ESC.reset}`);
  },
  subtitle(text) {
    console.log(`${ESC.dim}  ${text}${ESC.reset}\n`);
  },
  section(text) {
    console.log(`\n${ESC.bold}${ESC.magenta}▸ ${text}${ESC.reset}`);
  },
  hint(text) {
    console.log(`${ESC.dim}  ${text}${ESC.reset}`);
  },
  ok(text) { console.log(`${ESC.green}✔ ${text}${ESC.reset}`); },
  warn(text) { console.log(`${ESC.yellow}⚠ ${text}${ESC.reset}`); },
  err(text) { console.log(`${ESC.red}✗ ${text}${ESC.reset}`); },
  info(text) { console.log(`${ESC.blue}… ${text}${ESC.reset}`); },
  menuItem(n, label, desc = '') {
    const tail = desc ? `${ESC.dim} — ${desc}${ESC.reset}` : '';
    console.log(`  ${ESC.bold}${n}${ESC.reset}) ${label}${tail}`);
  },
  box(lines) {
    const w = Math.max(...lines.map((l) => stripAnsi(l).length), 16);
    console.log(`${ESC.dim}┌${'─'.repeat(w + 2)}┐${ESC.reset}`);
    for (const line of lines) {
      const plain = stripAnsi(line);
      console.log(`${ESC.dim}│${ESC.reset} ${line}${' '.repeat(Math.max(0, w - plain.length))} ${ESC.dim}│${ESC.reset}`);
    }
    console.log(`${ESC.dim}└${'─'.repeat(w + 2)}┘${ESC.reset}`);
  },
  divider() { console.log(`${ESC.dim}${'─'.repeat(58)}${ESC.reset}`); },
  row(label, value) {
    console.log(`  ${ESC.dim}${label.padEnd(10)}${ESC.reset} ${value}`);
  },
  badge(text, kind = 'info') {
    const colors = { ok: ESC.green, warn: ESC.yellow, err: ESC.red, info: ESC.cyan };
    const c = colors[kind] || ESC.cyan;
    console.log(`  ${c}● ${text}${ESC.reset}`);
  },
  progress(current, total, msg) {
    process.stdout.write(`\r${ESC.dim}[${current}/${total}]${ESC.reset} ${msg}   `);
  },
  progressDone() { process.stdout.write('\r' + ' '.repeat(60) + '\r'); },
};

export function ask(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}

export async function confirm(q, { defaultYes = false, forceYes = false } = {}) {
  if (forceYes) return true;
  if (!process.stdin.isTTY) { ui.warn('非交互环境，已取消（加 --yes 可自动执行）'); return false; }
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const a = await ask(`${ESC.yellow}${q}${ESC.reset} ${ESC.dim}${hint}:${ESC.reset} `);
  if (!a) return defaultYes;
  return /^y(es)?$/i.test(a);
}

/** 数字菜单：items = [{ label, desc?, action }]；含 0 返回 */
export async function pickMenu(title, items, { subtitle = '' } = {}) {
  ui.title(title);
  if (subtitle) ui.subtitle(subtitle);
  items.forEach((item, i) => ui.menuItem(String(i + 1), item.label, item.desc || ''));
  ui.menuItem('0', '返回');
  while (true) {
    const a = await ask(`\n${ESC.bold}请选择${ESC.reset} ${ESC.dim}[0-${items.length}]:${ESC.reset} `);
    if (a === '0' || a === '') return null;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    ui.warn('无效选择');
  }
}

export function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(String(r[i] || '')).length)));
  const head = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(`\n${ESC.bold}${head}${ESC.reset}`);
  console.log(`${ESC.dim}${'─'.repeat(head.length)}${ESC.reset}`);
  for (const row of rows) {
    console.log(row.map((c, i) => String(c).padEnd(widths[i])).join('  '));
  }
}
