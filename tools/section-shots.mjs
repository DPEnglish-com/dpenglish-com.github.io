#!/usr/bin/env node
/** 分段截图：按视口高度逐屏截，保证每屏都以可读比例呈现，供人眼复核。 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;
const target = process.argv[2] ?? 'index.html';
const outDir = process.argv[3] ?? '/tmp/shots-sec';
const W = Number(process.argv[4] ?? 1440);
const theme = process.argv[5] ?? 'dark';
mkdirSync(outDir, { recursive: true });
const url = target.startsWith('http') ? target : 'file://' + resolve(target);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/xichang-cdp-sec',
  '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const ws = new WebSocket(j.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0; const pending = new Map();
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) {
          const { res, rej } = pending.get(d.id); pending.delete(d.id);
          d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
        }
      };
      const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
        const i2 = ++id; pending.set(i2, { res, rej });
        if (process.env.CDP_DEBUG) console.error('  ->', method);
        ws.send(JSON.stringify({ id: i2, method, params, sessionId }));
        setTimeout(() => { if (pending.has(i2)) { pending.delete(i2); rej(new Error('timeout ' + method)); } }, 30000);
      });
      return send;
    } catch { await sleep(250); }
  }
  throw new Error('no CDP');
}

const send = await connect();
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

const H = 900;
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 }, sessionId);
await send('Page.navigate', { url }, sessionId);
await sleep(900);
// 展开全部揭示，逐屏截图时内容都是最终态
await send('Runtime.evaluate', {
  expression: `document.documentElement.setAttribute('data-theme','${theme}');
    document.querySelectorAll('.reveal').forEach(function(e){e.classList.add('shown')});
    document.documentElement.style.scrollBehavior='auto'; true;`,
}, sessionId);
await sleep(500);

const { result } = await send('Runtime.evaluate', {
  expression: 'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)',
  returnByValue: true,
}, sessionId);
const total = result.value;
const pages = Math.ceil(total / H);
console.log(`total=${total} pages=${pages}`);

for (let p = 0; p < pages; p++) {
  await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${p * H})` }, sessionId);
  await sleep(450);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const n = String(p).padStart(2, '0');
  writeFileSync(`${outDir}/${n}.png`, Buffer.from(shot.data, 'base64'));
  console.log(`  ${n}.png @ y=${p * H}`);
}
chrome.kill();
process.exit(0);
