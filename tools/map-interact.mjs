// 交互审计：验证「从头到脚」图版点开部位就出应用（两层，不再有子分类）。
// 用法: node tools/map-interact.mjs index.html /tmp/out 1440 dark
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const target = args[0] ?? 'index.html';
const outDir = args[1] ?? '/tmp/map-interact';
const W = Number(args[2] ?? 1440);
const THEME = args[3] ?? 'dark';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9339 + (Number(process.env.PORT_OFFSET) || 0);

const url = 'file://' + resolve(target);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = `/tmp/chrome-map-${PORT}`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},1000`,
  'about:blank',
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
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: 1000, deviceScaleFactor: 2, mobile: W < 700 }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(900);

  const evalJs = async (expr) => (await cdp.send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

  await evalJs(`document.documentElement.setAttribute('data-theme','${THEME}')`);
  await sleep(200);

  const click = async (sel, nth = 0) => {
    await evalJs(`(function(){var n=document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
      if(n){n.scrollIntoView({block:'center'});} return !!n;})()`);
    await sleep(150);
    return evalJs(`(function(){var n=document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
      if(!n) return false; n.click(); return true;})()`);
  };

  const snap = () => evalJs(`(function(){
    var zones = Array.from(document.querySelectorAll('.fig-zone')).map(function(g){
      var p = g.querySelector('path');
      return { zone: g.getAttribute('data-zone'), on: g.classList.contains('on'),
               stroke: p ? getComputedStyle(p).stroke : null,
               width: p ? getComputedStyle(p).strokeWidth : null,
               zoneOpacity: getComputedStyle(g).opacity };
    });
    var panel = document.querySelector('.map-panel');
    return {
      bands: Array.from(document.querySelectorAll('.band')).map(function(b){
        var lvl = b.classList.contains('band-d') ? 'band-d'
                : b.classList.contains('band-p') ? 'band-p' : 'band-c';
        return lvl + ':' + b.querySelector('.band-k').textContent +
               (b.classList.contains('on') ? '*' : '');
      }),
      spines: document.querySelectorAll('.layer:not(.layer-d)').length,
      crumbs: Array.from(document.querySelectorAll('.crumb')).map(function(c){return c.textContent;}),
      hint: document.getElementById('map-hint').textContent,
      cap: document.getElementById('fig-cap').textContent,
      active: document.getElementById('map-figure').getAttribute('data-active'),
      panel: panel ? (panel.querySelector('h3')||{}).textContent : null,
      panelDomain: panel ? (panel.querySelector('.p-domain')||{}).textContent : null,
      panelDesc: panel ? Array.from(panel.querySelectorAll('p')).map(function(p){return p.textContent;}).join(' ') : null,
      panelLinks: panel ? Array.from(panel.querySelectorAll('.p-actions a')).map(function(a){return a.textContent;}) : [],
      panelLis: panel ? Array.from(panel.querySelectorAll('li')).map(function(l){return l.textContent;}) : [],
      zones: zones
    };
  })()`);

  console.log(`\n=== 初始态 (${W}px/${THEME}) ===`);
  let s = await snap();
  console.log(`  行: ${s.bands.join(' | ')}`);
  console.log(`  人形: ${s.zones.map(z => z.zone + (z.on ? '[亮]' : '')).join(' ')}  说明=${s.cap}  面包屑=${s.crumbs.join('/')}`);
  console.log(`  提示: ${s.hint}   面板: ${s.panel || '（无）'}`);
  check(s.bands.length === 3, `初始应只有 3 个部位行，实为 ${s.bands.length}`);
  check(s.zones.length === 3, `人形应有 3 个部位组，实为 ${s.zones.length}`);
  check(s.cap === '全身', `初始说明应为「全身」，实为「${s.cap}」`);
  check(s.panel === null, '初始不应有应用面板');
  check(s.bands.every(b => b.startsWith('band-d:')), '初始三层里只该有部位行');
  check(s.spines === 0, `初始不应有层脊，实为 ${s.spines}`);

  // 人形线条必须真的画出来。绘制由滚动揭示触发，所以先滚进视野再等动画走完。
  await evalJs(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(1800);
  const drawn = await evalJs(`(function(){
    var bad = [];
    document.querySelectorAll('.fig-zone path').forEach(function(p){
      var off = parseFloat(getComputedStyle(p).strokeDashoffset);
      if (!(off < 0.5)) bad.push(p.getAttribute('d').slice(0,14) + ' off=' + off);
    });
    return bad;
  })()`);
  check(drawn.length === 0, `人形 13 条线应全部画完，未画完: ${drawn.join(' ; ') || '无'}`);

  await sleep(300);
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(`${outDir}/map-0-closed-${W}-${THEME}.png`, Buffer.from(shot.data, 'base64'));

  // ---- 点第一层：脑袋 → 直接出应用 ----
  console.log(`\n=== 点「脑袋」：应直接出应用，不再有子分类 ===`);
  check(await click('.band-d', 0), '点得到「脑袋」这一行');
  await sleep(800);
  s = await snap();
  console.log(`  行: ${s.bands.join(' | ')}`);
  console.log(`  人形: ${s.zones.map(z => z.zone + (z.on ? `[亮 ${z.stroke} ${z.width}]` : `(透明 ${z.zoneOpacity})`)).join(' ')}`);
  console.log(`  面包屑=${s.crumbs.join(' / ')}  提示=${s.hint}  说明=${s.cap}`);
  console.log(`  应用=${s.panel}  |  ${s.panelDomain}`);
  console.log(`  链接=${s.panelLinks.join(' , ')}   说明项=${s.panelLis.join(' ; ')}`);
  check(s.active === 'argue', `人形应切到 argue，实为 ${s.active}`);
  check(s.cap === '脑袋', `说明应为「脑袋」，实为「${s.cap}」`);
  check(s.panel === '问辩 Wenbian', `应直接显示应用名，实为「${s.panel}」`);
  check(!!s.panelDesc && s.panelDesc.length > 40, '应用应带一段介绍');
  check(s.panelLinks.length === 2, `应用应有两个链接，实为 ${s.panelLinks.length}`);
  check(s.spines === 1, `应长出 1 条层脊，实为 ${s.spines}`);
  check(!s.bands.some(b => b.startsWith('band-c:')), '不应再出现子分类行（band-c）');
  check(s.bands.filter(b => b.startsWith('band-p:')).length === 0, '不应再有中间的产品行');
  const argueZone = s.zones.find(z => z.zone === 'argue');
  check(argueZone.on, '脑袋应亮起');
  const otherZones = s.zones.filter(z => z.zone !== 'argue');
  check(otherZones.every(z => parseFloat(z.zoneOpacity) < 1), `未选中的部位应后退（实为 ${otherZones.map(z=>z.zone+':'+z.zoneOpacity).join(',')}）`);

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(`${outDir}/map-1-head-${W}-${THEME}.png`, Buffer.from(shot1.data, 'base64'));

  // ---- 换嘴巴 ----
  console.log(`\n=== 点「嘴巴」 ===`);
  check(await click('.band-d', 1), '点得到「嘴巴」');
  await sleep(800);
  s = await snap();
  console.log(`  人形: ${s.zones.map(z => z.zone + (z.on ? `[亮 ${z.stroke}]` : `(${z.zoneOpacity})`)).join(' ')}  说明=${s.cap}`);
  console.log(`  应用=${s.panel}  |  ${s.panelDomain}`);
  check(s.active === 'lang', `人形应切到 lang，实为 ${s.active}`);
  check(s.cap === '嘴巴', `说明应为「嘴巴」，实为「${s.cap}」`);
  check(s.panel === 'PaperEcho 纸上回声', `应显示 PaperEcho，实为「${s.panel}」`);
  check(s.spines === 1, `换部位后仍应为 1 条层脊，实为 ${s.spines}`);
  // 嘴巴长在脑袋上：选嘴巴时脑袋应留一点，不能和身体一样暗
  const head = s.zones.find(z => z.zone === 'argue');
  const body = s.zones.find(z => z.zone === 'body');
  console.log(`  关联高亮：脑袋=${head.zoneOpacity} 身体=${body.zoneOpacity}`);
  check(parseFloat(head.zoneOpacity) > parseFloat(body.zoneOpacity),
    `选嘴巴时脑袋应比身体亮（嘴巴长在脑袋上），实为 脑袋=${head.zoneOpacity} 身体=${body.zoneOpacity}`);

  // ---- 换身体 ----
  console.log(`\n=== 点「身体」 ===`);
  check(await click('.band-d', 2), '点得到「身体」');
  await sleep(800);
  s = await snap();
  console.log(`  人形: ${s.zones.map(z => z.zone + (z.on ? `[亮 ${z.stroke}]` : '')).join(' ')}  说明=${s.cap}`);
  check(s.active === 'body', `人形应切到 body，实为 ${s.active}`);
  check(s.cap === '身体', `说明应为「身体」，实为「${s.cap}」`);
  check(s.panel === 'WorkoutLoop', `应显示 WorkoutLoop，实为「${s.panel}」`);
  const bodyZone = s.zones.find(z => z.zone === 'body');
  check(bodyZone.on && bodyZone.stroke === 'rgb(111, 191, 174)', `身体应用松青 #6FBFAE，实为 ${bodyZone.stroke}`);

  await evalJs(`document.getElementById('map').scrollIntoView({block:'start'})`);
  await sleep(400);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  writeFileSync(`${outDir}/map-2-body-${W}-${THEME}.png`, Buffer.from(shot2.data, 'base64'));

  // ---- 再点一次 = 收起 ----
  console.log(`\n=== 再点同一部位应收起 ===`);
  check(await click('.band-d', 2), '再点「身体」');
  await sleep(600);
  s = await snap();
  check(s.bands.length === 3 && s.panel === null && s.active === '',
    `收起后应回到初始态，实为 bands=${s.bands.length} panel=${s.panel} active=${s.active}`);

  // ---- 面包屑退回 ----
  console.log(`\n=== 面包屑退回 ===`);
  check(await click('.band-d', 0), '先展开脑袋');
  await sleep(600);
  s = await snap();
  check(s.crumbs.length === 2, `展开后应有 2 段面包屑，实为 ${s.crumbs.length}`);
  check(await click('.crumb', 0), '点「全身」面包屑');
  await sleep(600);
  s = await snap();
  check(s.bands.length === 3 && s.active === '' && s.panel === null,
    `退回应回到初始态，实为 bands=${s.bands.length} active=${s.active}`);

  // ---- 键盘可达性 ----
  console.log(`\n=== 键盘可达性 ===`);
  const kbd = await evalJs(`(function(){
    var b = document.querySelector('.band-d');
    b.focus();
    return { focused: document.activeElement === b, tag: document.activeElement.tagName };
  })()`);
  check(kbd.focused && kbd.tag === 'BUTTON', `部位行应可聚焦，实为 ${kbd.tag} focused=${kbd.focused}`);

  // ---- 人形放大图 ----
  const clip = await evalJs(`(function(){
    var r = document.querySelector('.map-figure svg').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  if (clip.width > 0) {
    const c = await cdp.send('Page.captureScreenshot',
      { format: 'png', clip: { ...clip, scale: 3 } }, sessionId);
    writeFileSync(`${outDir}/figure-zoom-${W}-${THEME}.png`, Buffer.from(c.data, 'base64'));
    console.log(`\n  人形放大图已存 figure-zoom-${W}-${THEME}.png (${clip.width}×${clip.height} @3x)`);
  }

} catch (e) {
  console.error('交互审计异常：', e.message);
  failures.push('异常: ' + e.message);
}

chrome.kill();
console.log('\n' + '─'.repeat(64));
if (failures.length) { console.log(`✗ ${failures.length} 项未通过：`); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✓ 图版交互审计通过：点部位直接出应用、人形跟随、层脊生长、面包屑退回、键盘可达。');
process.exit(0);
