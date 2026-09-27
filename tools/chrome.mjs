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

/* Node 版本先查一遍。
   这些脚本用全局 WebSocket 连 CDP：Node 22+ 默认有，Node 20 没有
   （要 --experimental-websocket）。不查的话，报出来的是
   "WebSocket is not defined"，看不出跟 Node 版本有关 ——
   CI 上就这么白排查过一轮（本机是 Node 24，本地永远不暴露）。
   每个用浏览器的脚本都 import 本文件，所以在这一个地方拦最省事。 */
const NODE_VERSION = process.versions.node;
const NODE_MAJOR = Number(NODE_VERSION.split('.')[0]);
if (NODE_MAJOR < 22) {
  throw new Error(
    `需要 Node 22 或更高（当前 v${NODE_VERSION}）。\n` +
    '  原因：审计脚本用全局 WebSocket 连 Chrome DevTools Protocol，\n' +
    '  Node 22+ 才默认提供；Node 20 要加 --experimental-websocket。'
  );
}
if (typeof WebSocket !== 'function') {
  throw new Error(
    `当前 Node v${NODE_VERSION} 没有全局 WebSocket。\n` +
    '  请升级到 Node 22+，或用 `node --experimental-websocket` 运行。'
  );
}

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
