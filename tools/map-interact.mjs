// 目录/脊柱交互审计：六章、六目录行、五个部位锚点、滚动高亮与逐层点亮。
// 用法: node tools/map-interact.mjs index.html /tmp/map-interact 1440 light
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const [target = 'index.html', outDir = '/tmp/map-interact', W = '1440', THEME = 'light'] = process.argv.slice(2);
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
mkdirSync(outDir, { recursive: true });
const PORT = 9339 + (Number(process.env.PORT_OFFSET) || 0);
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/chrome-bi-' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', '--window-size=' + W + ',1000', 'about:blank',
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
  open() {
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
const check = (ok, msg) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + msg); if (!ok) failures.push(msg); };

try {
  const cdp = await CDP.connect(PORT); await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(W), height: 1000, deviceScaleFactor: 1, mobile: Number(W) < 700 }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const ev = async expr => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const rdy = await waitReady(ev);
  console.log('  就绪：' + rdy.state + '（' + rdy.ms + 'ms）');
  await ev("document.documentElement.setAttribute('data-theme'," + JSON.stringify(THEME) + ")");
  await sleep(300);

  console.log('\n=== A) 结构 ===');
  const st = await ev(`(function(){
    return {
      chapters: document.querySelectorAll('.chapter').length,
      rail: document.querySelectorAll('.rail-item').length,
      toc: document.querySelectorAll('.toc-row').length,
      frames: document.querySelectorAll('.frame').length,
      figures: document.querySelectorAll('.body-figure').length,
      videos: document.querySelectorAll('.media-open[data-open="video"]').length,
      demos: document.querySelectorAll('.media-open[data-open="demo"]').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()`);
  console.log('  ' + JSON.stringify(st));
  check(st.chapters === 6, '六章（实为 ' + st.chapters + '）');
  check(st.rail === 5, '五个部位锚点（实为 ' + st.rail + '）');
  check(st.toc === 6, '六行目录（实为 ' + st.toc + '）');
  check(st.frames === 6, '六帧接触印样（实为 ' + st.frames + '）');
  check(st.figures === 2, '首屏与脊柱各一具人形（实为 ' + st.figures + '）');
  check(st.videos === 6 && st.demos === 6, '六个播放入口 / 六个试用入口');
  check(!st.overflow, '1440 宽无横向溢出');

  const targets = await ev(`(function(){
    var bad = [];
    document.querySelectorAll('.toc-row a, .rail-item').forEach(function(a){
      var h = a.getAttribute('href');
      if (!h || h.charAt(0) !== '#' || !document.querySelector(h)) bad.push(h);
    });
    return bad;
  })()`);
  check(targets.length === 0, '所有目录/脊柱链接都有目标' + (targets.length ? '（坏链 ' + targets.join(',') + '）' : ''));

  console.log('\n=== B) 点「嘴巴」→ 两章共用一处 ===');
  await ev(`(function(){var a=document.querySelector('.rail-item[data-part="嘴巴"]'); a.scrollIntoView({block:'center'}); a.click();})()`);
  await sleep(500);
  const mouth = await ev(`(function(){
    var act = document.querySelector('.rail-item[aria-current="true"]');
    var inked = {};
    document.querySelectorAll('.rail-figure .body-figure .zone').forEach(function(z){ inked[z.dataset.zone] = z.classList.contains('inked'); });
    return { hash: location.hash, active: act && act.dataset.part, inked: inked,
             count: act && act.querySelector('.rail-count').textContent,
             langTop: Math.round(document.getElementById('lang').getBoundingClientRect().top) };
  })()`);
  console.log('  ' + JSON.stringify(mouth));
  check(mouth.hash === '#lang', '点嘴巴跳到第一章嘴巴（hash ' + mouth.hash + '）');
  check(mouth.active === '嘴巴', '嘴巴锚点 aria-current');
  check(mouth.count === '03–04', '嘴巴计数 03–04（实为 ' + mouth.count + '）');
  check(mouth.inked.argue && mouth.inked.eye && mouth.inked.lang && !mouth.inked.body && !mouth.inked.outer,
    '读到嘴巴：头/眼/嘴已亮，身/衣未亮');

  console.log('\n=== C) 滚到 SE English → 仍是嘴巴 ===');
  await ev("document.getElementById('se').scrollIntoView({block:'center'})");
  await sleep(600);
  const se = await ev(`(function(){
    var act = document.querySelector('.rail-item[aria-current="true"]');
    var inked = {};
    document.querySelectorAll('.rail-figure .body-figure .zone').forEach(function(z){ inked[z.dataset.zone] = z.classList.contains('inked'); });
    return { active: act && act.dataset.part, inked: inked };
  })()`);
  console.log('  ' + JSON.stringify(se));
  check(se.active === '嘴巴', 'SE 章仍是嘴巴');
  check(se.inked.argue && se.inked.eye && se.inked.lang && !se.inked.body && !se.inked.outer, 'SE 章：头/眼/嘴亮，身/衣未亮');

  console.log('\n=== D) 滚到「着装」→ 人形画完 ===');
  await ev("document.getElementById('outer').scrollIntoView({block:'center'})");
  await sleep(600);
  const last = await ev(`(function(){
    var act = document.querySelector('.rail-item[aria-current="true"]');
    var inked = {};
    document.querySelectorAll('.rail-figure .body-figure .zone').forEach(function(z){ inked[z.dataset.zone] = z.classList.contains('inked'); });
    return { active: act && act.dataset.part, inked: inked };
  })()`);
  console.log('  ' + JSON.stringify(last));
  check(last.active === '着装', '最后一章点亮着装');
  check(['argue','eye','lang','body','outer'].every(function(z){ return last.inked[z]; }), '读到最后：五层全部点亮');

  console.log('\n=== E) 主题切换 ===');
  const before = await ev("document.documentElement.getAttribute('data-theme')");
  await ev("document.getElementById('themeToggle').click()");
  await sleep(300);
  const after = await ev("document.documentElement.getAttribute('data-theme')");
  check(before !== after, '主题按钮切换 data-theme（' + before + ' → ' + after + '）');
  await ev("document.getElementById('themeToggle').click()");

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(outDir + '/interact-' + W + '.png', Buffer.from(shot.data, 'base64'));
} finally {
  chrome.kill('SIGKILL');
}

if (failures.length) {
  console.log('\n✗ ' + failures.length + ' 项未通过：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n✓ 目录/脊柱交互通过');
process.exit(0);
