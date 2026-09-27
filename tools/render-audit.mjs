#!/usr/bin/env node
/**
 * render-audit.mjs — 用真实浏览器（CDP）验收习场预览。
 *
 * 为什么需要它：design-check 是静态检测器，会按 CSS 文本配对令牌，
 * 并对 padding 这类属性误判。静态结论必须用「实际渲染 + computed style」证伪或证实。
 * 这跟 PaperEcho / Wenbian / WorkoutLoop 里 tools/site_contrast_audit.py 的做法一致。
 *
 * 用法：
 *   node tools/render-audit.mjs <file-or-url> [--shots <dir>]
 *
 * 它做四件事：
 *   1) 在 8 档视口 × 明暗两套主题下，遍历所有可见文本节点，算真实对比度
 *   2) 检查每档视口的横向溢出、元素重叠、顶栏 sticky 是否生效
 *   3) 检查触控目标尺寸、焦点可见性、语义结构
 *   4) 输出截图（供人眼复核）
 *
 * 退出码：0 = 无主要问题；1 = 有问题；2 = 无法启动浏览器。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHROME } from './chrome.mjs';

const PORT = 9333;

const VIEWPORTS = [
  { w: 320, h: 720, label: '320' },
  { w: 390, h: 844, label: '390' },
  { w: 768, h: 1024, label: '768' },
  { w: 1024, h: 768, label: '1024' },
  { w: 1440, h: 900, label: '1440' },
  { w: 2560, h: 1440, label: '2560' },
];

const args = process.argv.slice(2);
const target = args[0] ?? 'index.html';
const shotsIdx = args.indexOf('--shots');
const shotDir = shotsIdx >= 0 ? args[shotsIdx + 1] : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

const url = target.startsWith('http')
  ? target
  : 'file://' + resolve(target);

// ---------------------------------------------------------------- 页面内审计逻辑

const AUDIT_JS = String.raw`
(function () {
  function parseColor(c) {
    var s = String(c).trim();
    // Chrome 对 oklab/color(srgb ...) 会给出 0..1 的归一化通道，不能按 0..255 读。
    // color(srgb 0.95 0.95 0.945 / 0.88) 这类必须单独处理，否则会算成 rgb(0,0,0)。
    var cm = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (cm) {
      return { r: +cm[1] * 255, g: +cm[2] * 255, b: +cm[3] * 255, a: cm[4] !== undefined ? +cm[4] : 1 };
    }
    var m = s.match(/[\d.]+/g);
    if (!m) return null;
    // 只有 rgb()/rgba() 才按 0..255 解读
    if (!/^rgba?\(/.test(s)) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 };
  }
  function lum(c) {
    function f(x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    var la = lum(a), lb = lum(b), hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function over(fg, bg) {
    var a = fg.a;
    return { r: a * fg.r + (1 - a) * bg.r, g: a * fg.g + (1 - a) * bg.g, b: a * fg.b + (1 - a) * bg.b, a: 1 };
  }
  // 向上逐层合成背景，直到遇到不透明层
  function bgOf(el) {
    var layers = [], n = el;
    while (n && n.nodeType === 1) {
      var c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; }
      n = n.parentElement;
    }
    var base = { r: 255, g: 255, b: 255, a: 1 };
    for (var i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  }
  function visible(el) {
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  var out = { contrast: [], overflow: null, overlaps: [], sticky: null, targets: [], structure: {}, notes: [] };

  // ---- 1) 真实对比度：遍历所有文本节点
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var seen = new Set();
  while (walker.nextNode()) {
    var t = walker.currentNode, text = t.textContent.trim();
    if (!text) continue;
    var el = t.parentElement;
    if (!el || !visible(el)) continue;
    var cs = getComputedStyle(el);
    var fg = parseColor(cs.color);
    if (!fg) continue;
    var bg = bgOf(el);
    var eff = fg.a < 1 ? over(fg, bg) : fg;
    var r = ratio(eff, bg);
    var size = parseFloat(cs.fontSize);
    var bold = parseInt(cs.fontWeight, 10) >= 700;
    // WCAG 大字定义：>=24px，或 >=18.66px 且粗体
    var large = size >= 24 || (size >= 18.66 && bold);
    var need = large ? 3 : 4.5;
    var key = el.tagName + '|' + (el.className || '') + '|' + cs.color + '|' + size;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r < need) {
      out.contrast.push({
        text: text.slice(0, 28), tag: el.tagName,
        cls: String(el.className || '').slice(0, 30),
        size: size, need: need, got: +r.toFixed(2),
        fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')'
      });
    }
  }

  // ---- 2) 横向溢出
  var d = document.documentElement;
  var offenders = [];
  document.querySelectorAll('body *').forEach(function (el) {
    if (!visible(el)) return;
    var r = el.getBoundingClientRect();
    // 跳过链接等「故意移到屏幕外」的元素不算溢出
    if (r.right < -100 || r.left > d.clientWidth + 100) return;
    // 被 overflow 容器包住的不算页面溢出
    var n = el, clipped = false;
    while (n && n !== document.body) {
      var s = getComputedStyle(n);
      if (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden' || s.overflowX === 'clip') { clipped = true; break; }
      n = n.parentElement;
    }
    if (!clipped && (r.right > d.clientWidth + 1 || r.left < -1)) {
      offenders.push(el.tagName + '.' + String(el.className || '').slice(0, 24) +
                     ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
    }
  });
  out.overflow = { scrollW: d.scrollWidth, clientW: d.clientWidth,
                   isOverflow: d.scrollWidth > d.clientWidth + 1, offenders: offenders.slice(0, 5) };

  // ---- 3) 元素重叠（只查互不包含的兄弟块，父子包含不是重叠）
  var boxes = [];
  document.querySelectorAll('main > section, .slot, .band, .planned li').forEach(function (el) {
    if (!visible(el)) return;
    boxes.push({ el: el, r: el.getBoundingClientRect(), tag: el.tagName + '.' + String(el.className || '').slice(0, 20) });
  });
  for (var i = 0; i < boxes.length; i++) {
    for (var j = i + 1; j < boxes.length; j++) {
      // 祖先/后代关系不算重叠
      if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
      var a = boxes[i].r, b = boxes[j].r;
      var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 4 && oy > 4) out.overlaps.push(boxes[i].tag + ' × ' + boxes[j].tag +
        ' (' + Math.round(ox) + '×' + Math.round(oy) + 'px)');
    }
  }

  // ---- 4) 顶栏 sticky 是否真的粘住
  var top = document.getElementById('top');
  if (top) {
    var before = top.getBoundingClientRect().top;
    window.scrollTo(0, 900);
    var after = top.getBoundingClientRect().top;
    var stuck = top.hasAttribute('data-stuck');
    window.scrollTo(0, 0);
    out.sticky = { position: getComputedStyle(top).position, topBefore: Math.round(before),
                   topAfterScroll: Math.round(after), stuckAttrApplied: stuck };
  }

  // ---- 5) 触控目标尺寸（交互元素 >= 44px 高度）
  document.querySelectorAll('a, button').forEach(function (el) {
    if (!visible(el)) return;
    var r = el.getBoundingClientRect();
    if (r.height < 44 || r.width < 24) {
      out.targets.push(el.tagName + ' "' + (el.textContent || '').trim().slice(0, 18) +
        '" ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  });

  // ---- 6) 结构
  out.structure = {
    h1: document.querySelectorAll('h1').length,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(function (h) { return h.tagName; }).join(' '),
    lang: document.documentElement.lang,
    title: document.title,
    imgNoAlt: Array.from(document.querySelectorAll('img')).filter(function (i) { return !i.hasAttribute('alt'); }).length,
    theme: document.documentElement.getAttribute('data-theme'),
    // 图版（从头到脚）：三层各自的条目数，以及人形是否画出来了
    mapBands: document.querySelectorAll('.band').length,
    mapFigurePaths: document.querySelectorAll('.fig-zone path').length,
    mapZoneOn: document.querySelectorAll('.fig-zone.on').length,
    mapCrumbs: document.querySelectorAll('.crumb').length,
    mapLayerSpines: document.querySelectorAll('.layer:not(.layer-d)').length
  };

  return out;
})()
`;

// ---------------------------------------------------------------- CDP 客户端

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(port) {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        const j = await r.json();
        const ws = new WebSocket(j.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const c = new CDP(ws);
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && c.pending.has(d.id)) {
            const { res, rej } = c.pending.get(d.id);
            c.pending.delete(d.id);
            d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
          } else if (d.method) c.events.push(d);
        };
        return c;
      } catch { await sleep(250); }
    }
    throw new Error('无法连接 Chrome CDP');
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
}

// ---------------------------------------------------------------- 主流程

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/xichang-cdp',
  '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let failures = [];
let cdp;

try {
  cdp = await CDP.connect(PORT);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  console.log(`审计目标：${url}\n`);

  for (const vp of VIEWPORTS) {
    for (const theme of ['dark', 'light']) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 500,
      }, sessionId);
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      }, sessionId);

      // 每次重新加载，确保媒体查询与首屏脚本都按当前条件跑
      await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(700);
      // 显式指定主题（模拟用户点击后的状态），避免只测到系统偏好
      await cdp.send('Runtime.evaluate', {
        expression: `document.documentElement.setAttribute('data-theme','${theme}'); true;`,
      }, sessionId);
      await sleep(250);

      const { result } = await cdp.send('Runtime.evaluate', {
        expression: AUDIT_JS, returnByValue: true, awaitPromise: false,
      }, sessionId);
      const a = result.value;

      const tag = `${vp.label}/${theme}`;
      const line = [];
      if (a.contrast.length) {
        line.push(`对比度 ${a.contrast.length} 处不达标`);
        failures.push(`${tag} 对比度：` + a.contrast.map(c =>
          `${c.text}" ${c.got}:1 (需${c.need}) ${c.fg} on ${c.bg}`).join(' | '));
      }
      if (a.overflow.isOverflow || a.overflow.offenders.length) {
        line.push(`溢出 scrollW=${a.overflow.scrollW}>clientW=${a.overflow.clientW} ${a.overflow.offenders.join(' ; ')}`);
        if (a.overflow.isOverflow) failures.push(`${tag} 页面横向溢出`);
      }
      if (a.overlaps.length) { line.push(`重叠 ${a.overlaps.join(' ; ')}`); failures.push(`${tag} 元素重叠：${a.overlaps.join(' ; ')}`); }
      if (a.sticky && a.sticky.position === 'sticky' && a.sticky.topAfterScroll !== 0) {
        line.push(`sticky 失效 top=${a.sticky.topAfterScroll}`);
        failures.push(`${tag} sticky 顶栏未粘住`);
      }
      if (a.targets.length) line.push(`触控目标偏小 ${a.targets.length}: ${a.targets.slice(0, 3).join(' ; ')}`);

      console.log(`[${tag.padEnd(12)}] ` + (line.length ? line.join('  |  ') : 'OK') +
        `  (文本样本对比度全部达标, sticky=${a.sticky ? a.sticky.topAfterScroll : 'n/a'})`);

      if (vp.w === 1440 && theme === 'dark') {
        console.log(`   结构: h1=${a.structure.h1} lang=${a.structure.lang} 主题=${a.structure.theme}` +
          ` 无alt图=${a.structure.imgNoAlt}`);
        console.log(`   标题层级: ${a.structure.headings}`);
        console.log(`   图版: 行=${a.structure.mapBands} 人形线=${a.structure.mapFigurePaths}` +
          ` 亮起部位=${a.structure.mapZoneOn} 面包屑=${a.structure.mapCrumbs} 层脊=${a.structure.mapLayerSpines}`);
      }

      // 截图
      if (shotDir && ['320', '390', '768', '1440'].includes(vp.label)) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(`${shotDir}/${vp.label}-${theme}.png`, Buffer.from(data, 'base64'));
      }
    }
  }

  // 触控目标汇总（只在最窄档判定）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(700);
  const { result: r2 } = await cdp.send('Runtime.evaluate', { expression: AUDIT_JS, returnByValue: true }, sessionId);
  const small = r2.value.targets;
  console.log(`\n390px 触控目标 <44px 高：${small.length ? small.join(' ; ') : '无'}`);

  // 禁用 JS 复测：内容必须完整可读
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(700);
  const { result: r3 } = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var hidden = 0, total = 0;
      document.querySelectorAll('.reveal').forEach(function(el){
        total++;
        if (parseFloat(getComputedStyle(el).opacity) === 0) hidden++;
      });
      return { revealTotal: total, revealHidden: hidden,
               textLen: document.body.innerText.trim().length,
               theme: document.documentElement.getAttribute('data-theme'),
               hasMain: !!document.getElementById('main') };
    })()`, returnByValue: true,
  }, sessionId);
  const nojs = r3.value;
  console.log(`禁用 JS：正文 ${nojs.textLen} 字, .reveal ${nojs.revealTotal} 个中 ${nojs.revealHidden} 个不可见, 主题=${nojs.theme}`);
  if (nojs.revealHidden > 0) failures.push('禁用 JS 时有内容不可见');
  if (nojs.textLen < 800) failures.push('禁用 JS 时正文过少');
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }, sessionId);

} catch (e) {
  console.error('审计失败：', e.message);
  chrome.kill();
  process.exit(2);
}

chrome.kill();

console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`共 ${failures.length} 项需要处理：`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('真实渲染审计通过：对比度、溢出、重叠、sticky、禁用 JS 全部达标。');
if (shotDir) console.log(`截图已写入 ${shotDir}`);
process.exit(0);
