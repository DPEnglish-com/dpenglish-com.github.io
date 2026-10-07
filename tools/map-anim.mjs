// 动画时序审计：确认人形是「画」出来的，而不是一帧到位；并确认取消选中不重播。
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const args = process.argv.slice(2);
const target = args[0] ?? 'index.html';
const outDir = args[1] ?? '/tmp/map-anim';
const THEME = args[2] ?? 'dark';
const PORT = 9351;
// 传 URL 就照用，传路径才当本地文件
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-anim-${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1440,1000', 'about:blank',
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

const failures = [];
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

try {
  const cdp = await CDP.connect(PORT);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  // 线上要过网络，轮询到图版渲染出来再继续，不睡固定毫秒
  await waitReady(ev);
  await ev(`document.documentElement.setAttribute('data-theme','${THEME}')`);

  // 采样器：每次读全部 17 条线的 dashoffset，累计"还没画完"的量
  const PROBE = `window.__probe = function(){
    var tot = 0;
    document.querySelectorAll('.fig-zone path').forEach(function(p){
      tot += parseFloat(getComputedStyle(p).strokeDashoffset) || 0;
    });
    return Math.round(tot * 100) / 100;
  }`;
  await ev(PROBE);

  console.log(`\n=== 初始绘制时序 (${THEME}) ===`);
  await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);

  /* 绘制的起点由 IntersectionObserver 触发，触发时机随帧调度浮动，
     所以不能假设"滚到位置后第 N 毫秒一定在画"。先轮询等它真的开始
     （未画完总量 > 0），再从这个真实起点往后采样。 */
  let started = false;
  for (let i = 0; i < 40; i++) {
    if ((await ev(`window.__probe()`)) > 0) { started = true; break; }
    await sleep(25);
  }
  check(started, '人形绘制应在滚动到位后启动');

  const samples = [];
  let prev = 0;
  for (const t of [0, 90, 200, 340, 520, 800, 1300]) {
    await sleep(t - prev); prev = t;
    const off = await ev(`window.__probe()`);
    samples.push({ t, off });
  }
  /* 终点不取"起点 + 固定毫秒"，而等页面自己说画完了（.fig-ready）。
     绘制起点由 IntersectionObserver 触发、随帧调度浮动，固定 1300ms 有时落在
     最后一帧之前，读数停在 0.01 —— 那不是"没画完"，是采样点早了一帧。
     等 .fig-ready 再读才是真终点；这条断言也就从"它在 1300ms 内结束"
     变成"它一定会结束"，后者才是它想说的话。 */
  let doneMs = null;
  for (let i = 0; i < 60; i++) {
    const ready = await ev(`document.getElementById('map-figure').classList.contains('fig-ready')`);
    if (ready) { doneMs = 1300 + i * 25; break; }
    await sleep(25);
  }
  samples.push({ t: doneMs === null ? '超时' : doneMs, off: await ev(`window.__probe()`) });
  samples.forEach(s => console.log(`  t=+${String(s.t).padStart(4)}ms  未画完总量=${s.off}`));

  const peak = samples[0].off;
  const end = samples.at(-1).off;
  check(peak > 0, `起点应从有未画完的线开始（实为 ${peak}）`);
  check(end === 0, `终点应全部画完（实为 ${end}）`);
  const mid = samples.filter(s => s.off > 0 && s.off < peak);
  check(mid.length >= 2, `中间态应有至少 2 个采样点处于绘制中（实为 ${mid.length}）—— 说明是逐条画出来，不是一帧到位`);
  // 单调递减：只往前画，不回退
  const monotonic = samples.every((s, i) => i === 0 || s.off <= samples[i - 1].off + 0.01);
  check(monotonic, '绘制量应单调递减，不回退');

  // 截图：绘制中途
  await cdp.send('Page.navigate', { url }, sessionId);
  // waitReady 在图版初次渲染后即返回（早于滚动揭示），所以之后
  // scrollIntoView 触发的绘制才刚开始，正好能拍到中途。
  await waitReady(ev);
  await ev(`document.documentElement.setAttribute('data-theme','${THEME}')`);
  await ev(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(330);
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 60, y: 0, width: 420, height: 700, scale: 2 } }, sessionId);
  writeFileSync(`${outDir}/fig-mid-${THEME}.png`, Buffer.from(shot.data, 'base64'));
  console.log(`\n  绘制中途截图 fig-mid-${THEME}.png`);
  await sleep(1400);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 60, y: 0, width: 420, height: 700, scale: 2 } }, sessionId);
  writeFileSync(`${outDir}/fig-done-${THEME}.png`, Buffer.from(shot.data, 'base64'));
  console.log(`  绘制完成截图 fig-done-${THEME}.png`);

  // 取消选中不重播。重新导航后 window.__probe 已丢失，必须重新注入。
  console.log(`\n=== 取消选中不应重播整具人形 ===`);
  await ev(PROBE);
  await sleep(1200);                                  // 等初始动画走完 + fig-ready
  await ev(`document.querySelector('.band-d').click()`);   // 选中
  await sleep(900);
  await ev(`document.querySelector('.band-d').click()`);   // 再点一次 = 取消
  await sleep(60);
  const afterDeselect = await ev(`window.__probe()`);
  console.log(`  取消选中后 60ms 未画完总量=${afterDeselect}`);
  check(afterDeselect === 0, `取消选中不应重画人形（实为 ${afterDeselect}）`);

  const ready = await ev(`document.getElementById('map-figure').classList.contains('fig-ready')`);
  check(ready, '初始动画结束后应加上 .fig-ready');

} catch (e) {
  console.error('异常：', e.message);
  failures.push('异常: ' + e.message);
}
chrome.kill();
console.log('\n' + '─'.repeat(64));
if (failures.length) { console.log(`✗ ${failures.length} 项未通过：`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✓ 动画时序审计通过：人形逐条绘制，取消选中不重播。');
process.exit(0);
