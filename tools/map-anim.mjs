// 人形逐层绘制审计：首屏整具人形「画」出来（不是一帧到位），滚动时逐层提亮；
// reduced-motion 时直接到位。
// 用法: node tools/map-anim.mjs index.html /tmp/map-anim light
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const [target = 'index.html', outDir = '/tmp/map-anim', THEME = 'light'] = process.argv.slice(2);
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
mkdirSync(outDir, { recursive: true });
const PORT = 9351;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/chrome-anim-' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch('http://127.0.0.1:' + port + '/json/version'); return new CDP((await r.json()).webSocketDebuggerUrl); }
      catch { await sleep(250); }
    }
    throw new Error('Chrome 未就绪');
  }
  open() { return new Promise((res, rej) => {
    this.sock = new WebSocket(this.ws);
    this.sock.onopen = res; this.sock.onerror = rej;
    this.sock.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  }); }
  send(method, params = {}, sessionId) { const id = ++this.id; return new Promise((res, rej) => {
    this.pending.set(id, { res, rej }); this.sock.send(JSON.stringify({ id, method, params, sessionId })); }); }
}

const failures = [];
const check = (ok, msg) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg); if (!ok) failures.push(msg); };

const probe = "Math.round(Array.prototype.reduce.call(document.querySelectorAll('.body-figure .zone path'),function(t,p){return t+(parseFloat(getComputedStyle(p).strokeDashoffset)||0);},0)*100)/100";

try {
  const cdp = await CDP.connect(PORT); await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  // 在文档创建前挂一个采样器：绘制可能在 waitReady 之前就结束，不能只在加载后采样。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__animPeak=0;(function(){function p(){try{var a=document.querySelectorAll(".body-figure .zone path");if(a.length){var t=0;for(var i=0;i<a.length;i++)t+=parseFloat(getComputedStyle(a[i]).strokeDashoffset)||0;if(t>window.__animPeak)window.__animPeak=t;}}catch(e){}if(!window.__animStop)requestAnimationFrame(p);}p();})();' }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async expr => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await waitReady(ev);
  await ev("document.documentElement.setAttribute('data-theme'," + JSON.stringify(THEME) + ")");

  console.log('\n=== A) 首屏绘制：整具人形是画出来的 ===');
  const peak = await ev('window.__animPeak');
  await sleep(1300);
  const final = await ev(probe);
  console.log('  绘制峰值：' + peak + '，1.3 秒后：' + final);
  check(peak > 5, '绘制过程中有未完成的线（峰值 ' + peak + '）');
  check(final < 0.5, '1.3 秒后全部画完（最后 ' + final + '）');
  const paths = await ev("document.querySelectorAll('.body-figure .zone path').length");
  check(paths === 38, '首屏 + 脊柱两具人形共 38 条线（实为 ' + paths + '）');
  const running = await ev("document.getAnimations().filter(function(a){return a.playState==='running';}).length");
  check(running === 0, '1.3 秒后没有仍在跑的动画（实为 ' + running + '）');

  console.log('\n=== B) 滚动逐层提亮 ===');
  await ev("document.getElementById('se').scrollIntoView({block:'center'})");
  await sleep(600);
  const se = await ev(`(function(){var z={};document.querySelectorAll('.rail-figure .zone').forEach(function(g){z[g.dataset.zone]=g.classList.contains('inked')});return z})()`);
  console.log('  SE 章：' + JSON.stringify(se));
  check(se.argue && se.eye && se.lang && !se.body && !se.outer, 'SE 章只亮到嘴巴这一层');
  await ev("document.getElementById('outer').scrollIntoView({block:'center'})");
  await sleep(600);
  const all = await ev(`(function(){var z={};document.querySelectorAll('.rail-figure .zone').forEach(function(g){z[g.dataset.zone]=g.classList.contains('inked')});return z})()`);
  check(all.argue && all.eye && all.lang && all.body && all.outer, '读到最后五层全亮');

  console.log('\n=== C) reduced-motion：直接到位 ===');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitReady(ev);
  await sleep(250);
  const rm = await ev(`(function(){
    var off = Array.prototype.map.call(document.querySelectorAll('.body-figure .zone path'), function(p){ return parseFloat(getComputedStyle(p).strokeDashoffset)||0; });
    var op = Array.prototype.map.call(document.querySelectorAll('.body-figure .zone path'), function(p){ return parseFloat(getComputedStyle(p).opacity)||0; });
    return { maxOff: Math.max.apply(null, off), minOp: Math.min.apply(null, op) };
  })()`);
  console.log('  ' + JSON.stringify(rm));
  check(rm.maxOff < 0.5, 'reduce 时线条全部到位');
  check(rm.minOp > 0.9, 'reduce 时线条全部可见');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);
} finally {
  chrome.kill('SIGKILL');
}

if (failures.length) {
  console.log('\n✗ ' + failures.length + ' 项未通过：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n✓ 人形逐层绘制通过');
process.exit(0);
