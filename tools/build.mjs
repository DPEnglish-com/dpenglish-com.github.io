// 从 data/products.json 生成 index.html 的目录、六章、接触印样、页脚与 404。
//
//   node tools/build.mjs           写入
//   node tools/build.mjs --check   只检查是否同步（CI 用）
//
// 生成区由 index.html 里的标记界定：
//   <!-- @generated:名字 -->  …  <!-- @generated:end -->
//   /* @generated:名字 */      …  /* @generated:end */
// 标记之外一律不碰。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'data', 'products.json');
const HTML_PATH = join(ROOT, 'index.html');
const HTML_404_PATH = join(ROOT, '404.html');
const CHECK = process.argv.includes('--check');

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
const products = data.products;

/* 部位 → 人形 SVG 的 zone。五个部位必须都有人。 */
const PART_ZONE = { 脑袋: 'argue', 眼睛: 'eye', 嘴巴: 'lang', 身体: 'body', 着装: 'outer' };
const PART_ORDER = ['脑袋', '眼睛', '嘴巴', '身体', '着装'];

/* ---------------------------------------------------------------- 校验 */

const problems = [];
const ID_RE = /^[a-z][a-z0-9-]*$/;

products.forEach((p, i) => {
  const where = 'products[' + i + ']' + (p.id ? ' (' + p.id + ')' : '');
  for (const f of ['id', 'part', 'k', 'accent', 'name', 'short', 'platform', 'version', 'size', 'desc', 'note', 'promise']) {
    if (!p[f] || typeof p[f] !== 'string') problems.push(where + ' 缺字段或不是字符串: ' + f);
  }
  if (p.id && !ID_RE.test(p.id)) problems.push(where + ' id 只能是小写字母/数字/连字符: ' + p.id);
  if (p.promise && p.promise.length > 40) problems.push(where + ' promise 太长（≤40 字）: ' + p.promise);
  // 2026-10-24 起，六个产品的对外名字统一为中英双语；只写一种语言会在母站上缺一半。
  if (p.name && (!/[\u3400-\u9FFF]/.test(p.name) || !/[A-Za-z]/.test(p.name))) problems.push(where + ' name 必须中英双语: ' + p.name);
  if (!PART_ZONE[p.part]) problems.push(where + ' 未知部位: ' + p.part + '（可用：' + Object.keys(PART_ZONE).join(' / ') + '）');
  if (!Array.isArray(p.links) || p.links.length === 0) problems.push(where + ' links 不能为空');
  (p.links || []).forEach((l, j) => {
    if (!l.label || !l.href) problems.push(where + '.links[' + j + '] 缺 label 或 href');
    if (l.href && !/^https:\/\//.test(l.href)) problems.push(where + '.links[' + j + '] 必须是 https: ' + l.href);
  });
  if (p.media != null && typeof p.media !== 'object') problems.push(where + ' media 不是对象');
  else if (p.media) {
    for (const f of ['video', 'poster']) {
      if (!p.media[f] || typeof p.media[f] !== 'string') problems.push(where + '.media 缺字段: ' + f);
    }
    if (p.media.demo || p.media.demoNote) {
      for (const f of ['demo', 'demoNote']) {
        if (!p.media[f] || typeof p.media[f] !== 'string') problems.push(where + '.media 缺字段: ' + f);
      }
    }
    for (const f of ['videoTitle', 'videoMeta', 'videoNote']) {
      if (p.media[f] != null && typeof p.media[f] !== 'string') problems.push(where + '.media.' + f + ' 必须是字符串');
    }
    for (const f of ['video', 'poster', 'demo']) {
      const v = p.media[f];
      if (!v) continue;
      if (/^([a-z]+:|\/)/i.test(v)) problems.push(where + '.media.' + f + ' 必须是仓库内的相对路径: ' + v);
      else if (!existsSync(join(ROOT, v))) problems.push(where + '.media.' + f + ' 指向的文件不存在: ' + v);
    }
  }
});

if (data.site && data.site.count !== products.length) {
  problems.push('site.count = ' + data.site.count + '，但 products 有 ' + products.length + ' 个');
}
for (const key of ['id', 'accent']) {
  const seen = new Map();
  products.forEach(p => {
    if (seen.has(p[key])) problems.push(key + ' 重复: ' + p[key] + '（' + seen.get(p[key]) + ' 与 ' + p.id + '）');
    seen.set(p[key], p.id);
  });
}
const partsUsed = new Set(products.map(p => p.part));
for (const part of PART_ORDER) {
  if (!partsUsed.has(part)) problems.push('缺少部位「' + part + '」的产品，人形会少一块');
}

const fullSource = readFileSync(HTML_PATH, 'utf8');
const styleMatch = fullSource.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
  console.error('✗ index.html 里找不到 <style> 块，无法核对 accent 令牌');
  process.exit(2);
}
const cssSource = styleMatch[1];
const hasToken = name => new RegExp('--' + name + ':\\s*[^;]+;').test(cssSource);
const hasChapterAccent = accent => new RegExp('\\.chapter\\[data-accent="' + accent + '"\\]').test(cssSource);
for (const p of products) {
  if (!hasToken(p.accent)) problems.push('products(' + p.id + ') 用了 accent="' + p.accent + '"，CSS 里没有 --' + p.accent + ' 令牌');
  if (!hasChapterAccent(p.accent)) problems.push('products(' + p.id + ') 用了 accent="' + p.accent + '"，CSS 里没有 .chapter[data-accent="' + p.accent + '"] 规则');
}

if (problems.length) {
  console.error('data/products.json 有问题，未生成：');
  problems.forEach(p => console.error('  ✗ ' + p));
  process.exit(2);
}

/* ---------------------------------------------------------------- 派生 */

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const zoneOf = p => PART_ZONE[p.part];
const noOf = p => String(products.indexOf(p) + 1).padStart(2, '0');
const metaOf = p => (p.media && p.media.videoMeta) || '20 秒 · 1080p · 无旁白';

const frameDur = p => {
  const m = metaOf(p).match(/(\d+)\s*秒/);
  return m ? m[1] + ' 秒' : '';
};
const tagDur = p => {
  const m = metaOf(p).match(/(\d+)\s*秒/);
  return m ? m[1] + '″' : '片';
};

/* ---------------------------------------------------------------- 人形 */

const FIG = {
  argue: ['M100,30 C82.8,30 69,43.8 69,61 C69,78.2 82.8,92 100,92 C117.2,92 131,78.2 131,61 C131,43.8 117.2,30 100,30 Z'],
  eye: ['M80,57 L92,57', 'M108,57 L120,57'],
  lang: ['M89,72 L111,72'],
  body: [
    'M100,92 L100,112',
    'M52,128 C72,114 128,114 148,128',
    'M52,128 C43,172 45,220 54,262',
    'M148,128 C157,172 155,220 146,262',
    'M54,262 C64,290 78,302 100,302 C122,302 136,290 146,262',
    'M52,132 C32,162 24,204 28,252',
    'M148,132 C168,162 176,204 172,252',
    'M82,302 C78,364 74,424 72,492',
    'M118,302 C122,364 126,424 128,492',
    'M72,492 L58,504',
    'M128,492 L142,504',
  ],
  outer: [
    'M86,110 C74,102 58,108 44,124',
    'M44,124 C26,146 18,196 20,250 C24,288 32,318 38,338',
    'M114,110 C126,102 142,108 156,124',
    'M156,124 C174,146 182,196 180,250 C176,288 168,318 162,338',
  ],
};
const ZONE_ORDER = ['argue', 'eye', 'lang', 'body', 'outer'];

function genFigure(label) {
  const groups = ZONE_ORDER.map(z => {
    const paths = FIG[z].map(d => '          <path pathLength="1" d="' + d + '"/>').join('\n');
    return '        <g class="zone" data-zone="' + z + '">\n' + paths + '\n        </g>';
  }).join('\n');
  return '      <svg class="body-figure" viewBox="0 0 200 540" role="img" aria-label="' + label + '">\n' + groups + '\n      </svg>';
}

/* ---------------------------------------------------------------- 生成 */

function genContact() {
  return products.map(p => {
    const media = p.media || {};
    const still = media.still || media.poster;
    return '        <a class="frame" href="#' + esc(p.id) + '" data-accent="' + esc(p.accent) + '">\n' +
      '          <img class="frame-img" src="' + esc(still) + '" alt="' + esc(p.name) + '的片子画面" width="480" height="270" loading="lazy" decoding="async">\n' +
      '          <span class="frame-meta"><span class="frame-no">' + noOf(p) + '</span><span class="frame-name">' + esc(p.name) + '</span><span class="frame-dur">' + (frameDur(p) ? '片 ' + frameDur(p) : '') + '</span></span>\n' +
      '        </a>';
  }).join('\n');
}

function genIndex() {
  return products.map(p => {
    const media = p.media || {};
    const tags = [];
    if (media.video) tags.push('片 ' + tagDur(p));
    if (media.demo) tags.push('试用');
    return '        <li class="toc-row" data-accent="' + esc(p.accent) + '">\n' +
      '          <a href="#' + esc(p.id) + '">\n' +
      '            <span class="toc-no">' + noOf(p) + '</span>\n' +
      '            <span class="toc-part">' + esc(p.part) + '</span>\n' +
      '            <span class="toc-name">' + esc(p.name) + '</span>\n' +
      '            <span class="toc-promise">' + esc(p.promise) + '</span>\n' +
      '            <span class="toc-media">' + esc(tags.join(' · ')) + '</span>\n' +
      '          </a>\n' +
      '        </li>';
  }).join('\n');
}

function genRail() {
  const byPart = new Map();
  products.forEach(p => {
    if (!byPart.has(p.part)) byPart.set(p.part, []);
    byPart.get(p.part).push(p);
  });
  return PART_ORDER.filter(part => byPart.has(part)).map(part => {
    const list = byPart.get(part);
    const first = list[0];
    const nums = list.map(noOf);
    const count = nums.length > 1 ? nums[0] + '–' + nums[nums.length - 1] : nums[0];
    return '          <a class="rail-item" href="#' + esc(first.id) + '" data-zone="' + esc(zoneOf(first)) + '" data-part="' + esc(part) + '" style="--accent:var(--' + esc(first.accent) + ')">\n' +
      '            <span class="rail-dot" aria-hidden="true"></span><span class="rail-label">' + esc(part) + '</span><span class="rail-count">' + count + '</span>\n' +
      '          </a>';
  }).join('\n');
}

function mediaButtons(p) {
  const media = p.media || {};
  const out = [];
  if (media.demo) {
    out.push('          <button class="btn btn-line media-open" type="button" data-open="demo"\n' +
      '                  data-src="' + esc(media.demo) + '" data-title="' + esc(p.name) + ' · 在线试用"\n' +
      '                  data-note="' + esc(media.demoNote || '') + '">在线试用</button>');
  }
  return out.join('\n');
}

function genChapters() {
  return products.map((p, i) => {
    const media = p.media || {};
    const primary = p.links[0];
    const apk = p.links[1];
    const extraLinks = p.links.slice(2).map(l =>
      '                <a href="' + esc(l.href) + '">' + esc(l.label) + '</a>').join('\n');
    const facts = [['平台', p.platform], ['版本', p.version], ['体积', p.size]]
      .map(([k, v]) => '              <div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('\n');
    let plate = '';
    if (media.video) {
      const still = media.still || media.poster;
      const meta = metaOf(p);
      plate = '          <button class="plate media-open" type="button" data-open="video"\n' +
        '                  data-src="' + esc(media.video) + '" data-poster="' + esc(media.poster) + '"\n' +
        '                  data-title="' + esc(media.videoTitle || p.name + ' · 产品宣传片') + '"\n' +
        '                  data-meta="' + esc(meta) + '"\n' +
        '                  data-foot="' + esc(media.videoNote || '学习流程示意 · 依据产品界面重绘。') + '"\n' +
        '                  aria-label="播放' + esc(p.name) + '的片子">\n' +
        '            <span class="plate-frame"><img class="plate-img" src="' + esc(still) + '" alt="' + esc(p.name) + '的片子画面" width="1280" height="720" loading="lazy" decoding="async">\n' +
        '              <span class="plate-play" aria-hidden="true"><svg viewBox="0 0 13 15" fill="currentColor"><path d="M1 0.8v13.4L12.2 8 1 0.8z"/></svg></span></span>\n' +
        '            <span class="plate-meta"><span>ORIGINAL FILM</span><span>' + esc(meta) + '</span></span>\n' +
        '          </button>\n' +
        '          <p class="plate-hint">点画面看片</p>';
    }
    const noscriptLinks = [];
    if (media.video) noscriptLinks.push('<a href="' + esc(media.video) + '">直接看片</a>');
    if (media.demo) noscriptLinks.push('<a href="' + esc(media.demo) + '">打开试用</a>');
    const noscriptHtml = noscriptLinks.length
      ? '          <noscript><p class="boundary">视频与试用需要 JavaScript：' + noscriptLinks.join(' · ') + '</p></noscript>\n'
      : '';
    return '        <article class="chapter" id="' + esc(p.id) + '" data-i="' + (i + 1) + '" data-zone="' + esc(zoneOf(p)) + '" data-accent="' + esc(p.accent) + '" aria-labelledby="t-' + esc(p.id) + '">\n' +
      '          <header class="chapter-head">\n' +
      '            <p class="chapter-meta"><span class="chapter-no">' + noOf(p) + '</span><span class="chapter-part">' + esc(p.part) + '</span><span class="chapter-k">' + esc(p.k) + '</span></p>\n' +
      '            <h2 class="chapter-name" id="t-' + esc(p.id) + '">' + esc(p.name) + '</h2>\n' +
      '            <p class="chapter-promise">' + esc(p.promise) + '</p>\n' +
      '          </header>\n' +
      '          <div class="chapter-body">\n' +
      '            <div class="chapter-text">\n' +
      '              <p class="desc">' + esc(p.desc) + '</p>\n' +
      '              <dl class="facts">\n' + facts + '\n              </dl>\n' +
      '              <div class="chapter-actions">\n' +
      (mediaButtons(p) ? mediaButtons(p) + '\n' : '') +
      '                <a class="btn btn-line" href="' + esc(primary.href) + '">' + esc(primary.label) + ' <span aria-hidden="true">→</span></a>\n' +
      (apk ? '                <a class="link-quiet" href="' + esc(apk.href) + '">' + esc(apk.label) + '</a>\n' : '') +
      (extraLinks ? extraLinks + '\n' : '') +
      '              </div>\n' +

      '              <details class="boundary"><summary>边界与前提</summary><p>' + esc(p.note) + '</p></details>\n' +
      '            </div>\n' +
      '            <div class="chapter-media">\n' + plate + '\n            </div>\n' +
      '          </div>\n' + noscriptHtml +
      '        </article>';
  }).join('\n\n');
}

function genFooter() {
  return products.map(p =>
    '          <a href="' + esc(p.links[0].href) + '">' + esc(p.name) + '</a>'
  ).join('\n');
}

function genData() {
  const slim = products.map((p, i) => ({
    id: p.id, no: i + 1, part: p.part, k: p.k, accent: p.accent,
    zone: zoneOf(p), name: p.name, short: p.short, promise: p.promise,
    platform: p.platform, version: p.version, size: p.size,
    media: p.media || null, links: p.links,
  }));
  const body = JSON.stringify(slim, null, 2).split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  return '  var DATA = ' + body + ';';
}

/* ---------------------------------------------------------------- 404 */

function gen404() {
  const src = readFileSync(HTML_PATH, 'utf8');
  const tok = n => {
    const m = src.match(new RegExp('--' + n + ':\\s*(#[0-9A-Fa-f]{6})'));
    if (!m) throw new Error('index.html 里找不到令牌 --' + n + '（404 页要用）');
    return m[1];
  };
  const icon = src.match(/<link rel="icon" href="([^"]+)">/);
  if (!icon) throw new Error('index.html 里找不到站点图标（404 页要用）');
  const links = products.map(p =>
    '    <li><a href="' + esc(p.links[0].href) + '"><b>' + esc(p.part) + ' · ' + esc(p.name) + '</b><span>' + esc(p.k) + '</span></a></li>'
  ).join('\n');
  return '<!doctype html>\n' +
'<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>没有这个页面 · 从头到脚</title>\n<meta name="robots" content="noindex">\n' +
'<meta name="color-scheme" content="dark light">\n<meta name="theme-color" content="' + tok('bg') + '">\n' +
'<link rel="icon" href="' + icon[1] + '">\n' +
'<script>(function(){var t;try{t=localStorage.getItem("ctdj-theme");}catch(e){}if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.setAttribute("data-theme",t);})();</script>\n' +
'<style>\n' +
':root{--bg:#0E0C09;--ink:#ECE5D8;--ink-2:#B3AA9B;--ink-3:#8C8375;--hair:rgba(236,229,216,.14);--serif:"Source Han Serif SC","Noto Serif SC","Songti SC","STSong","SimSun",serif;--sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}\n' +
':root[data-theme="light"]{--bg:#F2EDE3;--ink:#17140F;--ink-2:#575047;--ink-3:#6D6559;--hair:rgba(23,20,15,.14);}\n' +
'@media (prefers-color-scheme: light){:root:not([data-theme]){--bg:#F2EDE3;--ink:#17140F;--ink-2:#575047;--ink-3:#6D6559;--hair:rgba(23,20,15,.14);}}\n' +
'*,*::before,*::after{box-sizing:border-box}\n' +
'body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16.5px;line-height:1.78;display:flex;align-items:center;min-height:100vh}\n' +
'.wrap{width:100%;max-width:1200px;margin:0 auto;padding:0 clamp(20px,5vw,64px)}\n' +
'a{color:inherit;text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:.2em}\n' +
'h1{font-family:var(--serif);font-size:clamp(32px,5vw,56px);font-weight:500;line-height:1.2;margin:16px 0 14px}\n' +
'.mark{font-family:var(--serif);font-size:20px;letter-spacing:.02em}\n' +
'.code{font-family:var(--mono);font-size:12.5px;letter-spacing:.06em;color:var(--ink-3)}\n' +
'.lead{color:var(--ink-2);font-size:14.5px;max-width:34em;margin:0 0 40px}\n' +
'ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--hair)}\n' +
'li{border-bottom:1px solid var(--hair)}\n' +
'li a{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding:15px 2px;min-height:56px}\n' +
'li b{font-family:var(--serif);font-weight:500;font-size:17px}\n' +
'li span{font-family:var(--mono);font-size:12.5px;color:var(--ink-3)}\n' +
'.home{display:inline-flex;align-items:center;min-height:44px;margin-top:32px;font-size:14.5px;color:var(--ink-2)}\n' +
'</style>\n</head>\n<body>\n<div class="wrap">\n' +
'<p class="code">404 · 没有这个页面</p>\n<h1>这里没有东西。</h1>\n' +
'<p class="lead">地址可能打错了，或者那个页面已经搬走。下面是全部' + products.length + '个产品。</p>\n' +
'<ul style="margin-top:32px">\n' + links + '\n</ul>\n' +
'<a class="home" href="/">← 回首页</a>\n</div>\n</body>\n</html>\n';
}

/* ---------------------------------------------------------------- 替换 */

const REGIONS = [
  { name: 'contact', open: '<!-- @generated:contact -->', close: '<!-- @generated:end -->', body: genContact() },
  { name: 'figure-hero', open: '<!-- @generated:figure-hero -->', close: '<!-- @generated:end -->', body: genFigure('从头到脚的人形线稿：脑袋、眼睛、嘴巴、身体、着装') },
  { name: 'figure-rail', open: '<!-- @generated:figure-rail -->', close: '<!-- @generated:end -->', body: genFigure('从头到脚的人形线稿') },
  { name: 'index', open: '<!-- @generated:index -->', close: '<!-- @generated:end -->', body: genIndex() },
  { name: 'rail', open: '<!-- @generated:rail -->', close: '<!-- @generated:end -->', body: genRail() },
  { name: 'chapters', open: '<!-- @generated:chapters -->', close: '<!-- @generated:end -->', body: genChapters() },
  { name: 'footer', open: '<!-- @generated:footer -->', close: '<!-- @generated:end -->', body: genFooter() },
  { name: 'data', open: '/* @generated:data */', close: '/* @generated:end */', body: genData() },
];

let html = readFileSync(HTML_PATH, 'utf8');
const missing = [];
for (const r of REGIONS) {
  const o = html.indexOf(r.open);
  const c = html.indexOf(r.close, o + r.open.length);
  if (o === -1 || c === -1) { missing.push(r.name); continue; }
  html = html.slice(0, o + r.open.length) + '\n' + r.body + '\n' + html.slice(c);
}
if (missing.length) {
  console.error('index.html 里找不到这些生成区的标记：' + missing.join(', '));
  process.exit(2);
}

const OUTER = {
  contact: { tag: 'div', cls: 'contact-grid' },
  index: { tag: 'ol', cls: 'toc' },
  rail: { tag: 'nav', cls: 'rail-nav' },
  chapters: { tag: 'div', cls: 'chapter-flow' },
  footer: { tag: 'div', cls: 'foot-links' },
};
const structProblems = [];
for (const r of REGIONS) {
  const outer = OUTER[r.name];
  if (outer) {
    const re = new RegExp('<' + outer.tag + '\\b[^>]*\\bclass\\s*=\\s*"([^"]*)"', 'gi');
    let m;
    while ((m = re.exec(r.body)) !== null) {
      if (m[1].split(/\s+/).includes(outer.cls)) {
        structProblems.push('生成区 ' + r.name + ' 里又写了一遍外层容器 <' + outer.tag + ' class="' + outer.cls + '">');
        break;
      }
    }
  }
  if (r.body.includes('@generated:')) structProblems.push('生成区 ' + r.name + ' 的内容里又出现了 @generated 标记');
}
if (structProblems.length) {
  console.error('生成内容的结构有问题，未写入：');
  structProblems.forEach(p => console.error('  ✗ ' + p));
  process.exit(2);
}

/* ---------------------------------------------------------------- 收尾 */

const current = readFileSync(HTML_PATH, 'utf8');
const notFound = gen404();
let bad404 = null;
try { bad404 = readFileSync(HTML_404_PATH, 'utf8'); } catch {}

if (CHECK) {
  const problemsOut = [];
  if (current !== html) {
    const a = current.split('\n'), b = html.split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
    problemsOut.push('✗ index.html 与 data/products.json 不同步\n  第一处差异在第 ' + (line + 1) + ' 行：\n' +
      '    现在: ' + String(a[line] ?? '(文件结束)').trim().slice(0, 90) + '\n' +
      '    应为: ' + String(b[line] ?? '(文件结束)').trim().slice(0, 90));
  }
  if (bad404 !== notFound) problemsOut.push('✗ 404.html 与数据/令牌不同步');
  if (problemsOut.length) {
    problemsOut.forEach(p => console.error(p));
    console.error('  跑 node tools/build.mjs 重新生成。');
    process.exit(1);
  }
  console.log('✓ 生成物与 data/products.json 同步（' + products.length + ' 个产品，index.html + 404.html）');
  process.exit(0);
}

const written = [];
if (current !== html) { writeFileSync(HTML_PATH, html); written.push('index.html'); }
if (bad404 !== notFound) { writeFileSync(HTML_404_PATH, notFound); written.push('404.html'); }
if (written.length) console.log('✓ 已生成 ' + products.length + ' 个产品：' + written.join(' + '));
else console.log('已是最新，无需改动（' + products.length + ' 个产品）');
