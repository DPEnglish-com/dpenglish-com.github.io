// 给线上站点拍整页截图（人眼复核用）。
// 复用 wait-ready 的轮询就绪：本地脚本睡固定毫秒那套对线上不可靠。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const [target = 'index.html', outDir = '/tmp/live-shot', W = '1440', THEME = 'dark', EXPAND = ''] = process.argv.slice(2);
const PORT = 9411;
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/chrome-ls-${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  `--window-size=${W},1000`, 'about:blank'], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(p) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${p}/json/version`); return new CDP((await r.json()).webSocketDebuggerUrl); }
      catch { await sleep(250); }
    }
    throw new Error('Chrome 未就绪');
  }
  async open() {
    return new Promise((res, rej) => {
      this.sock = new WebSocket(this.ws);
      this.sock.onopen = res; this.sock.onerror = rej;
      this.sock.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      };
    });
  }
  send(m, p = {}, s) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.sock.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); });
  }
}

try {
  const cdp = await CDP.connect(PORT);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: +W, height: 1000, deviceScaleFactor: 1, mobile: +W < 700 }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  // 404 页没有图版，用它的主链接当判据
  const rdy = await waitReady(ev, url.includes('404') ? { selector: '.home' } : {});
  console.log(`就绪：${rdy.state}（${rdy.ms}ms）`);

  await ev(`document.documentElement.setAttribute('data-theme','${THEME}')`);
  // 滚一遍触发全部 reveal，再等动画收尾
  await ev(`(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,90));}window.scrollTo(0,0);})()`);
  await sleep(1400);
  if (EXPAND) {
    for (const sel of EXPAND.split(',')) { await ev(`document.querySelectorAll('${sel}').forEach(b=>b.click())`); await sleep(700); }
    await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);
    await sleep(500);
  }

  const h = await ev(`document.body.scrollHeight`);
  if (h < 800) throw new Error(`页面高度只有 ${h}px，疑似没加载出来`);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: +W, height: Math.min(h, 9000), deviceScaleFactor: 1, mobile: +W < 700 }, sessionId);
  await sleep(700);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  const name = `full-${W}-${THEME}${EXPAND ? '-open' : ''}.png`;
  writeFileSync(`${outDir}/${name}`, Buffer.from(data, 'base64'));
  console.log(`${name}  ${W}×${Math.min(h, 9000)}`);
} catch (e) {
  console.error('截图失败：', e.message);
  chrome.kill(); process.exit(1);
}
chrome.kill();
process.exit(0);
