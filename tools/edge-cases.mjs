// 收尾校验：移动端 / reduced-motion / 禁用 JS 三条路径。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const [target = 'index.html'] = process.argv.slice(2);
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
const PORT = 9391;
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/chrome-edge-' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.onEvent = null; }
  static async connect(p) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch('http://127.0.0.1:' + p + '/json/version'); return new CDP((await r.json()).webSocketDebuggerUrl); }
      catch { await sleep(250); }
    }
    throw new Error('no chrome');
  }
  open() { return new Promise((res, rej) => { this.sock = new WebSocket(this.ws); this.sock.onopen = res; this.sock.onerror = rej;
    this.sock.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && this.onEvent) this.onEvent(m.method); }; }); }
  send(m, p = {}, s) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.sock.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); }); }
}

const failures = [];
const ck = (ok, msg) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg); if (!ok) failures.push(msg); };

try {
  const cdp = await CDP.connect(PORT); await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

  console.log('\n=== A) 移动端 390px ===');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitReady(ev);
  await sleep(300);
  const mob = await ev(`(function(){
    var fig=document.querySelector('.hero-figure'), r=document.querySelector('.rail');
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      figW: Math.round(fig.getBoundingClientRect().width),
      railCount: document.querySelectorAll('.rail-item').length,
      railVisible: r && getComputedStyle(r).position === 'sticky',
      chapters: document.querySelectorAll('.chapter').length
    };
  })()`);
  console.log('  ' + JSON.stringify(mob));
  ck(!mob.overflow, '390 宽无横向溢出');
  ck(mob.figW > 60, '移动端首屏人形仍在（宽 ' + mob.figW + 'px）');
  ck(mob.railCount === 5, '移动端五个部位锚点');
  ck(mob.railVisible, '移动端脊柱条是 sticky');
  ck(mob.chapters === 6, '移动端六章都在');
  await ev(`document.querySelector('.rail-item[data-part="嘴巴"]').click()`);
  await sleep(600);
  const mob2 = await ev(`(function(){var act=document.querySelector('.rail-item[aria-current="true"]'); return {hash:location.hash, active: act && act.dataset.part, chapterTop: Math.round(document.getElementById('lang').getBoundingClientRect().top)}})()`);
  console.log('  ' + JSON.stringify(mob2));
  ck(mob2.hash === '#lang', '移动端点嘴巴跳转第一章嘴巴');
  ck(mob2.active === '嘴巴', '移动端嘴巴高亮');

  console.log('\n=== B) prefers-reduced-motion: reduce ===');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await waitReady(ev); await sleep(250);
  const rm = await ev(`(function(){
    var offs=[], ops=[];
    document.querySelectorAll('.body-figure .zone path').forEach(function(p){
      offs.push(parseFloat(getComputedStyle(p).strokeDashoffset)||0);
      ops.push(parseFloat(getComputedStyle(p).opacity)||0);
    });
    return { maxOff: Math.max.apply(null, offs), minOp: Math.min.apply(null, ops) };
  })()`);
  console.log('  ' + JSON.stringify(rm));
  ck(rm.maxOff < 0.5, 'reduce 时人形直接到位');
  ck(rm.minOp > 0.9, 'reduce 时人形完整可见');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);

  console.log('\n=== C) 禁用 JS ===');
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  const loaded = new Promise(r => {
    const t = setTimeout(() => r('timeout'), 20000);
    cdp.onEvent = method => { if (method === 'Page.loadEventFired') { clearTimeout(t); r('load'); } };
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  const how = await loaded; cdp.onEvent = null;
  if (how === 'timeout') console.log('  警告：loadEventFired 超时，继续检查');
  await sleep(400);
  const nojs = await ev(`(function(){
    var names = ['问辩','课蒸馏','PaperEcho','SE English','WorkoutLoop','外在'];
    var text = document.body.innerText;
    return {
      chapters: document.querySelectorAll('.chapter').length,
      toc: document.querySelectorAll('.toc-row').length,
      frames: document.querySelectorAll('.frame').length,
      noscript: document.querySelectorAll('noscript').length,
      names: names.filter(function(n){ return text.indexOf(n) >= 0; }).length,
      total: text.trim().length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`);
  console.log('  ' + JSON.stringify(nojs));
  ck(nojs.chapters === 6, '无 JS 时六章都在');
  ck(nojs.toc === 6, '无 JS 时六行目录都在');
  ck(nojs.frames === 6, '无 JS 时六帧接触印样都在');
  ck(nojs.names === 6, '无 JS 时六个产品名都在');
  ck(nojs.total > 2500, '无 JS 时正文完整（' + nojs.total + ' 字）');
  ck(nojs.noscript >= 6, '无 JS 时每章留了直链说明');
  ck(!nojs.overflow, '无 JS 时 1440 无横向溢出');
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }, sessionId);
} finally {
  chrome.kill('SIGKILL');
}

if (failures.length) {
  console.log('\n✗ ' + failures.length + ' 项未通过：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n✓ 移动端、减少动效、禁用 JS 三条路径通过');
process.exit(0);
