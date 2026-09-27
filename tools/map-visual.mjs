// 人形视觉审查：把 .map-figure 与整个图版按精确 rect 截出来，供人眼判断。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const [target = 'index.html', outDir = '/tmp/map-visual', W = '1440', THEME = 'dark'] = process.argv.slice(2);
const PORT = 9361;
// 传 URL 就照用，传路径才当本地文件
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-vis-${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},1200`, 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return new CDP((await r.json()).webSocketDebuggerUrl); }
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.sock.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

try {
  const cdp = await CDP.connect(PORT);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: +W, height: 1200, deviceScaleFactor: 2, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await waitReady(ev);

  await ev(`document.documentElement.setAttribute('data-theme','${THEME}')`);
  await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(1900);   // 等初始绘制走完

  const shots = [
    ['figure-idle', '.map-figure svg'],
    ['map-idle', '#map-root'],
  ];
  for (const [name, sel] of shots) {
    const r = await ev(`(function(){var b=document.querySelector('${sel}').getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};})()`);
    if (r.width < 2) { console.log(`跳过 ${name}（宽 ${r.width}）`); continue; }
    const s = await cdp.send('Page.captureScreenshot',
      { format: 'png', clip: { ...r, scale: 3 }, captureBeyondViewport: true }, sessionId);
    writeFileSync(`${outDir}/${name}-${W}-${THEME}.png`, Buffer.from(s.data, 'base64'));
    console.log(`${name}-${W}-${THEME}.png  ${r.width}×${r.height} @3x`);
  }

  // 展开态：脑袋
  await ev(`document.querySelector('.band-d').click()`);
  await sleep(1000);
  await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(400);
  let r = await ev(`(function(){var b=document.querySelector('#map-root').getBoundingClientRect();
    return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};})()`);
  let s = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 }, captureBeyondViewport: true }, sessionId);
  writeFileSync(`${outDir}/map-head-${W}-${THEME}.png`, Buffer.from(s.data, 'base64'));
  console.log(`map-head-${W}-${THEME}.png  ${r.width}×${r.height} @2x`);

  // 展开态：嘴巴（检查"嘴巴长在脑袋上"的关联高亮）
  await ev(`document.querySelectorAll('.band-d')[1].click()`);
  await sleep(1000);
  await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(400);
  r = await ev(`(function(){var b=document.querySelector('.map-figure svg').getBoundingClientRect();
    return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};})()`);
  s = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 3 }, captureBeyondViewport: true }, sessionId);
  writeFileSync(`${outDir}/figure-mouth-${W}-${THEME}.png`, Buffer.from(s.data, 'base64'));
  console.log(`figure-mouth-${W}-${THEME}.png  ${r.width}×${r.height} @3x`);

} catch (e) { console.error('异常：', e.message); process.exit(1); }
chrome.kill();
process.exit(0);
