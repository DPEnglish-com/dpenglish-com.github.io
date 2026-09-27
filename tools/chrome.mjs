// Chrome 可执行文件的位置。
//
// 本机是 macOS 的 Google Chrome；CI（Ubuntu runner）上是另一个路径。
// 硬编码本机路径会让整套审计脚本在 CI 里直接跑不起来，所以：
//   1. 先看 $CHROME_PATH（CI 或换浏览器时用这个）
//   2. 再看各平台常见位置
//   3. 都找不到就抛错，并说清楚怎么指定，而不是让 spawn 报一句 ENOENT
//
// 用 existsSync 真的检查文件在不在 —— 只看平台会给出一条
// "看起来对但不存在"的路径，错误会推迟到 spawn 时才炸。

import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux（CI 上的 google-chrome-stable / chromium 都在 PATH 里）
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findChrome() {
  // 显式指定就是权威：设了 CHROME_PATH 却指不到文件，直接报错。
  // 静默回退到别的浏览器会让人以为"CI 用的是我指定的那个"，其实不是。
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`CHROME_PATH 指向的文件不存在：${explicit}`);
  }

  for (const p of CANDIDATES) {
    try { if (existsSync(p)) return p; } catch { /* 权限或路径非法，跳过 */ }
  }
  // PATH 里找一遍（Linux CI 常见）
  const path = (process.env.PATH || '').split(':');
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of path) {
      const p = `${dir}/${name}`;
      try { if (existsSync(p)) return p; } catch { /* 同上 */ }
    }
  }
  throw new Error(
    '找不到 Chrome。请设 CHROME_PATH 指向可执行文件，例如：\n' +
    '  export CHROME_PATH=/usr/bin/google-chrome\n' +
    '已找过：\n  ' + CANDIDATES.join('\n  ')
  );
}

export const CHROME = findChrome();
