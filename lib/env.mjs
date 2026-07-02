/**
 * 极简 .env 加载器（零依赖）：读取当前目录 .env，不覆盖已有环境变量。
 * Minimal zero-dependency .env loader. Never overrides existing env vars.
 */
import fs from 'node:fs';

export function loadDotEnv(file = '.env') {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadDotEnv();
