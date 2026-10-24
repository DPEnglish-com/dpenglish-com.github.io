// 间距复核：cramped-padding 曾经靠豁免放过三处误判；2026-10-24 重做后
// 三处都改成了真实内缩，不再需要豁免。这个脚本把内缩重新测一遍，防止回退。
//
//   node tools/measure-exemptions.mjs

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const PORT = 9431;
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=/tmp/chrome-gap-' + PORT, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(p) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch('http://127.0.0.1:' + p + '/json/version'); return new CDP((await r.json()).webSocketDebuggerUrl); }
      catch { await sleep(250); }
    }
    throw new Error('Chrome 未就绪');
  }
  open() { return new Promise((res, rej) => { this.sock = new WebSocket(this.ws); this.sock.onopen = res; this.sock.onerror = rej;
    this.sock.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }; }); }
  send(m, p = {}, s) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.sock.send(JSON.stringify({ id, method: m, params: p, sessionId: s })); }); }
}

const fails = [];
const ck = (ok, msg) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg); if (!ok) fails.push(msg); };

try {
  const cdp = await CDP.connect(PORT); await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: 'file://' + resolve('index.html') }, sessionId);
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await waitReady(ev);
  await sleep(400);

  const m = await ev(`(function(){
    var px = function(v){ return Math.round(parseFloat(v) * 10) / 10; };
    var toc = document.querySelector('.toc');
    var flow = document.querySelector('.chapter-flow');
    var grid = document.querySelector('.contact-grid');
    var frame = document.querySelector('.frame');
    var tocFirst = toc.querySelector('.toc-row');
    var chFirst = flow.querySelector('.chapter');
    return {
      tocPad: px(getComputedStyle(toc).paddingTop),
      flowPad: px(getComputedStyle(flow).paddingTop),
      gridPadBottom: px(getComputedStyle(grid).paddingBottom),
      framePad: px(getComputedStyle(frame).paddingTop),
      tocOffset: Math.round(tocFirst.getBoundingClientRect().top - toc.getBoundingClientRect().top),
      chOffset: Math.round(chFirst.getBoundingClientRect().top - flow.getBoundingClientRect().top)
    };
  })()`);

  console.log('\n=== 间距复核（1440×900，computed style）===\n');
  console.log('  .toc padding-top = ' + m.tocPad + 'px，首行距顶边 ' + m.tocOffset + 'px');
  console.log('  .chapter-flow padding-top = ' + m.flowPad + 'px，首章距顶边 ' + m.chOffset + 'px');
  console.log('  .contact-grid padding-bottom = ' + m.gridPadBottom + 'px；.frame padding-top = ' + m.framePad + 'px');
  console.log('');
  ck(m.tocPad >= 8, '.toc 内缩 ≥8px（实为 ' + m.tocPad + 'px）');
  ck(m.flowPad >= 8, '.chapter-flow 内缩 ≥8px（实为 ' + m.flowPad + 'px）');
  ck(m.gridPadBottom >= 8, '.contact-grid 底边内缩 ≥8px（实为 ' + m.gridPadBottom + 'px）');
  ck(m.framePad >= 8, '.frame 内缩 ≥8px（实为 ' + m.framePad + 'px）');
} catch (e) {
  console.error('复核失败：', e.message);
  fails.push('异常: ' + e.message);
} finally {
  chrome.kill();
}

console.log('\n' + '─'.repeat(64));
if (fails.length) {
  console.log('✗ 间距依据已不成立：');
  fails.forEach(f => console.log('  - ' + f));
  console.log('\n  改样式，或把新增的误判写进 .impeccable/config.json 并补证据。');
  process.exit(1);
}
console.log('✓ 间距依据成立（cramped-padding 不再需要豁免）');
process.exit(0);
