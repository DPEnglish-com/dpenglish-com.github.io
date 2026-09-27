// 复核 .impeccable/config.json 里 cramped-padding 豁免所依据的实测数字。
//
// 豁免不能只写在文档里 —— 那条规则一旦被改得不再成立（比如有人把
// .section 的 padding 去掉、或者把 ul.planned 的 li padding 抹平），
// 豁免就变成了掩盖问题。这个脚本把证据重新测一遍，不成立就报错。
//
//   node tools/measure-exemptions.mjs

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const PORT = 9431;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/chrome-exempt-${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

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

const fails = [];
const ck = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };

try {
  const cdp = await CDP.connect(PORT);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: 'file://' + resolve('index.html') }, sessionId);
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await waitReady(ev);
  await ev(`document.querySelectorAll('.reveal').forEach(e=>e.classList.add('shown'))`);
  await sleep(600);

  const m = await ev(`(function(){
    var px = function(v){ return Math.round(parseFloat(v) * 10) / 10; };
    var sec = document.querySelector('main > section.section');
    var secPad = px(getComputedStyle(sec).paddingTop);
    var head = sec.querySelector('.sec-head');
    var headOffset = Math.round(head.getBoundingClientRect().top - sec.getBoundingClientRect().top);
    var map = document.querySelector('.map');
    var mapPad = px(getComputedStyle(map).paddingLeft);
    var ul = document.querySelector('ul.planned');
    var li = ul.querySelector('li');
    var liPad = px(getComputedStyle(li).paddingTop);
    var liOffset = Math.round(li.getBoundingClientRect().top - ul.getBoundingClientRect().top + parseFloat(getComputedStyle(li).paddingTop));
    // .map 里贴边的绝对定位覆盖层（连线 SVG），它没有文字
    var overlay = document.getElementById('map-link');
    var oc = overlay ? getComputedStyle(overlay) : null;
    var overlayInset = oc ? { pos: oc.position, top: oc.top, left: oc.left } : null;
    var overlayHasText = overlay ? overlay.textContent.trim().length : 0;
    return { secPad: secPad, headOffset: headOffset, mapPad: mapPad,
             liPad: liPad, liOffset: liOffset, overlayInset: overlayInset, overlayHasText: overlayHasText };
  })()`);

  console.log('\n=== cramped-padding 豁免依据复核（1440×900，computed style）===\n');
  console.log(`  .section        padding-top = ${m.secPad}px，首个文本子元素距顶边 ${m.headOffset}px`);
  console.log(`  .map            padding-left = ${m.mapPad}px`);
  console.log(`  ul.planned 的 li padding-top = ${m.liPad}px，文字距 ul 顶边 ${m.liOffset}px`);
  console.log(`  #map-link（连线覆盖层）position=${m.overlayInset?.pos} top=${m.overlayInset?.top} left=${m.overlayInset?.left}，文字长度=${m.overlayHasText}`);
  console.log('');

  ck(m.secPad >= 8, `.section 真实内缩 ≥8px（实为 ${m.secPad}px）—— 检测器没解析 clamp()`);
  ck(m.headOffset >= 8, `.section 首个文本子元素距顶边 ≥8px（实为 ${m.headOffset}px）`);
  ck(m.mapPad >= 8, `.map 真实内缩 ≥8px（实为 ${m.mapPad}px）`);
  ck(m.liOffset >= 8, `ul.planned 文字距顶边 ≥8px（实为 ${m.liOffset}px）—— "贴边"的是 li 盒子，不是文字`);
  ck(m.overlayInset && m.overlayInset.pos === 'absolute' && m.overlayHasText === 0,
     '.map 那条"贴边"的是绝对定位的连线覆盖层，且不含文字');
} catch (e) {
  console.error('复核失败：', e.message);
  fails.push('异常: ' + e.message);
}

chrome.kill();
console.log('\n' + '─'.repeat(64));
if (fails.length) {
  console.log('✗ 豁免依据已不成立，需要重新判断：');
  fails.forEach(f => console.log('  - ' + f));
  console.log('\n  豁免不再成立时不要改这个脚本，要改样式或撤掉豁免。');
  process.exit(1);
}
console.log('✓ cramped-padding 豁免依据仍然成立（五条全部是检测器误判）');
process.exit(0);
