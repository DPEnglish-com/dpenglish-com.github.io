// 从 data/products.json 生成 index.html 里四处产品内容。
//
//   node tools/build.mjs           写入
//   node tools/build.mjs --check   只检查是否同步（CI 用，不同步则退出码 1）
//
// 为什么要有这个：加一个产品原本要改三处（图版 DATA、产品槽位、<noscript> 清单），
// 三处各写一遍同样的数字，迟早会不一致。现在只有一处。
//
// 生成区由 index.html 里的标记界定：
//   <!-- @generated:名字 -->  …  <!-- @generated:end -->
//   /* @generated:名字 */      …  /* @generated:end */
// 标记之外的内容一律不碰。

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

/* ---------------------------------------------------------------- 校验
   数据本身先过一遍。生成器不该把坏数据安静地写进页面。 */

const problems = [];
const ID_RE = /^[a-z][a-z0-9-]*$/;

products.forEach((p, i) => {
  const where = `products[${i}]${p.id ? ' (' + p.id + ')' : ''}`;
  for (const f of ['id', 'part', 'k', 'accent', 'slot', 'name', 'short', 'platform', 'version', 'size', 'desc', 'note']) {
    if (!p[f] || typeof p[f] !== 'string') problems.push(`${where} 缺字段或不是字符串: ${f}`);
  }
  if (p.id && !ID_RE.test(p.id)) problems.push(`${where} id 只能是小写字母/数字/连字符: ${p.id}`);
  if (!Array.isArray(p.links) || p.links.length === 0) problems.push(`${where} links 不能为空`);
  (p.links || []).forEach((l, j) => {
    if (!l.label || !l.href) problems.push(`${where}.links[${j}] 缺 label 或 href`);
    if (l.href && !/^https:\/\//.test(l.href)) problems.push(`${where}.links[${j}] 必须是 https: ${l.href}`);
  });
  // media：字段要齐，路径要落在仓库里。写成 https:// 会打破"零外部请求"，
  // 写成绝对路径会在子路径部署时 404 —— 两者都在生成前拦下。
  if (!p.media || typeof p.media !== 'object') problems.push(`${where} 缺 media（video / poster / demo / demoNote）`);
  else {
    for (const f of ['video', 'poster', 'demo', 'demoNote']) {
      if (!p.media[f] || typeof p.media[f] !== 'string') problems.push(`${where}.media 缺字段: ${f}`);
    }
    for (const f of ['video', 'poster', 'demo']) {
      const v = p.media[f];
      if (!v) continue;
      if (/^([a-z]+:|\/)/i.test(v)) problems.push(`${where}.media.${f} 必须是仓库内的相对路径: ${v}`);
      else if (!existsSync(join(ROOT, v))) problems.push(`${where}.media.${f} 指向的文件不存在: ${v}`);
    }
  }
});

// id / accent / slot 不能撞：它们分别是人形区域、颜色、栅格位置的键
for (const key of ['id', 'accent', 'slot']) {
  const seen = new Map();
  products.forEach(p => {
    if (seen.has(p[key])) problems.push(`${key} 重复: ${p[key]}（${seen.get(p[key])} 与 ${p.id}）`);
    seen.set(p[key], p.id);
  });
}

/* 新增产品时最容易漏的一步：用了新的 accent / slot，
   却没有在 index.html 的 CSS 里加对应的令牌与规则。
   那样生成出来的 HTML 引用不存在的颜色和栅格位置 ——
   页面不会报错，只会安静地少一块颜色、错一个位置。
   所以在生成前就对一遍 CSS。

   注意：只搜 <style> 块。index.html 里同时有 CSS 和生成出来的 HTML，
   整文件搜索会被自己刚生成的内容满足（slot-d 出现在 HTML 里就算"找到了"），
   检查就永远通过、等于没查。 */

const fullSource = readFileSync(HTML_PATH, 'utf8');
const styleMatch = fullSource.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
  console.error('✗ index.html 里找不到 <style> 块，无法核对 accent / slot 是否有样式');
  process.exit(2);
}
const cssSource = styleMatch[1];

const hasToken = name => new RegExp('--' + name + ':\\s*[^;]+;').test(cssSource);
const hasSlotClass = slot => new RegExp('\\.slot-' + slot + '\\s*(,|\\{)').test(cssSource);

for (const p of products) {
  if (!hasToken(p.accent)) {
    problems.push(
      `products(${p.id}) 用了 accent="${p.accent}"，但 CSS 里没有 --${p.accent} 令牌。\n` +
      `      请在 :root 与 :root[data-theme="light"] 各加一个（深色/浅色两个值），\n` +
      `      并在 tools/contrast-audit.py 的令牌清单里登记，否则对比度不受检。`
    );
  }
  if (!hasSlotClass(p.slot)) {
    problems.push(
      `products(${p.id}) 用了 slot="${p.slot}"，但 CSS 里没有 .slot-${p.slot} 规则。\n` +
      `      请加一条栅格位置（12 列里占几列），参考现有 .slot-a / .slot-b / .slot-c。`
    );
  }
}

if (problems.length) {
  console.error('data/products.json 有问题，未生成：');
  problems.forEach(p => console.error('  ✗ ' + p));
  process.exit(2);
}

/* ---------------------------------------------------------------- 派生值 */

// 「一行客观指标」由字段拼出，不在 JSON 里再写一遍
const domainOf = p => `${p.k} — ${p.platform} · ${p.version} · ${p.size}`;

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ---------------------------------------------------------------- 四段生成 */

// 1) 产品槽位。7/5 不对称：a=7 b=5 c=7，第三个左侧对齐，刻意不做三等分卡片墙。
function genSlots() {
  return products.map(p => {
    const specs = [['平台', p.platform], ['版本', p.version], ['体积', p.size]]
      .map(([k, v]) => `          <div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('\n');
    const links = p.links.map((l, i) => {
      const arrow = i === 0 ? ' <span class="arw" aria-hidden="true">→</span>' : '';
      return `          <a href="${esc(l.href)}">${esc(l.label)}${arrow}</a>`;
    }).join('\n');
    // 「查看视频」「在线试用」不是链接，是打开悬浮窗的按钮：写成 <a href> 的话，
    // 中键或回车会直接跳到一段裸的 mp4 / 一个裸的 demo 页，那是另一条没人维护的路径。
    // 地址与标题都挂在 data-* 上，脚本里不为任何产品写死内容。
    const acts = `        <div class="slot-acts">
          <button type="button" class="slot-act" data-open="video"
                  data-src="${esc(p.media.video)}" data-poster="${esc(p.media.poster)}"
                  data-title="${esc(p.name)} · 使用演示">查看视频</button>
          <button type="button" class="slot-act" data-open="demo"
                  data-src="${esc(p.media.demo)}" data-title="${esc(p.name)} · 在线试用"
                  data-note="${esc(p.media.demoNote)}">在线试用</button>
        </div>`;
    return `      <!-- ${esc(p.name)}：${esc(p.part)} -->
      <article class="slot slot-${esc(p.slot)} reveal" data-accent="${esc(p.accent)}">
        <p class="slot-domain">${esc(p.part)} · ${esc(p.k)}</p>
        <h3 class="slot-name">${esc(p.name)}</h3>
        <p class="slot-desc">
          ${esc(p.desc)}
        </p>
        <dl class="slot-specs">
${specs}
        </dl>
        <p class="slot-note">
          ${esc(p.note)}
        </p>
${acts}
        <div class="slot-links">
${links}
        </div>
      </article>`;
  }).join('\n\n');
}

// 2) 图版数据。形状与 JSON 一致，不再套一层 product，少一层心智负担。
function genData() {
  const slim = products.map(p => ({
    id: p.id, part: p.part, k: p.k, accent: p.accent,
    name: p.name, short: p.short,
    domain: domainOf(p),
    desc: p.desc, note: p.note, links: p.links,
  }));
  const body = JSON.stringify(slim, null, 2)
    .split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n');
  return `    var DATA = ${body};`;
}

// 3) 无 JS 清单。禁用脚本时信息不能缺，内容与图版逐字一致。
function genNoscript() {
  return products.map((p, i) => {
    const links = p.links.map(l => `            <a href="${esc(l.href)}">${esc(l.label)}</a>`).join('\n');
    const mt = i === 0 ? ' style="margin-top:16px"' : '';
    return `        <div class="map-panel"${mt}>
          <h3>${esc(p.name)}</h3>
          <p class="p-domain">${esc(domainOf(p))}</p>
          <p>${esc(p.desc)}</p>
          <ul>
            <li>${esc(p.note)}</li>
          </ul>
          <p class="p-actions">
${links}
          </p>
        </div>`;
  }).join('\n');
}

// 4) 敬请期待
//    只生成 <li>，自己不要再套一层 <ul>：外层已经是
//    <ul class="planned reveal">，生成器再套一层就成了 ul 嵌 ul ——
//    flex 布局失效、条目竖着堆成一列（页面凭空高 300 多像素）。
function genPlanned() {
  return data.planned.items
    .map(it => `      <li><p class="p-k">${esc(it.k)}</p><p class="p-s">${esc(it.s)}</p></li>`)
    .join('\n');
}

/* ---------------------------------------------------------------- 404.html

   整份生成，不是只填一段 —— 免得 404 页的颜色/字体跟主页各走各的。
   色值、字体子集、站点图标都从 index.html 现场读，主页改了这里自动跟上。 */

function gen404() {
  const src = readFileSync(HTML_PATH, 'utf8');
  const tok = n => {
    const m = src.match(new RegExp('--' + n + ':\\s*(#[0-9A-Fa-f]{6})'));
    if (!m) throw new Error('index.html 里找不到令牌 --' + n + '（404 页要用）');
    return m[1];
  };
  const fontB64 = src.match(/src: url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/);
  if (!fontB64) throw new Error('index.html 里找不到词标字体（404 页要用）');
  const icon = src.match(/<link rel="icon" href="([^"]+)">/);
  if (!icon) throw new Error('index.html 里找不到站点图标（404 页要用）');
  const hair = 'rgba(232, 234, 237, .12)';

  const links = products.map(p =>
    `        <li><a href="${esc(p.links[0].href)}"><b>${esc(p.part)} · ${esc(p.name)}</b><span>${esc(p.k)}</span></a></li>`
  ).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>没有这个页面 · 从头到脚</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="${tok('bg')}">
<link rel="icon" href="${icon[1]}">
<script>
/* 与主页同一套主题逻辑，键名也一样：从主页跳到 404 不会突然变色 */
(function () {
  var t;
  try { t = localStorage.getItem('ctdj-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
</script>
<style>
/* 本文件由 tools/build.mjs 生成，不要手改。改 data/products.json 或
   index.html 的令牌后重跑 build.mjs。 */
@font-face {
  font-family: "CongtoudaojiaoWordmark";
  src: url(data:font/woff2;base64,${fontB64[1]}) format("woff2");
  font-weight: 500; font-style: normal; font-display: swap;
}
:root {
  --bg: ${tok('bg')}; --ink: ${tok('ink')}; --ink-2: ${tok('ink-2')}; --ink-3: ${tok('ink-3')};
  --hair: ${hair};
  --wb: ${tok('wb')}; --pe: ${tok('pe')}; --wl: ${tok('wl')};
  --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
          "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --serif: "CongtoudaojiaoWordmark", "Songti SC", "Source Han Serif SC", "Noto Serif SC", serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
:root[data-theme="light"] {
  --bg: #F3F3F1; --ink: #101214; --ink-2: #4A4F54; --ink-3: #62686C;
  --hair: rgba(16, 18, 20, .12);
  --wb: #44603B; --pe: #C0432A; --wl: #1B5E54;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); font-size: 16.5px; line-height: 1.78;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh; display: flex; align-items: center;
}
.wrap { width: 100%; max-width: 1240px; margin: 0 auto; padding: 0 clamp(20px, 5vw, 64px); }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: .18em; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 2px; }
.mark {
  font-family: var(--serif); font-weight: 500; font-size: clamp(30px, 5vw, 46px);
  letter-spacing: .02em; line-height: 1;
}
.code { font-family: var(--mono); font-size: 12.5px; color: var(--ink-3); letter-spacing: .06em; }
h1 { font-size: clamp(26px, 3.2vw, 40px); font-weight: 700; line-height: 1.34; margin: 18px 0 12px; text-wrap: balance; }
.lead { color: var(--ink-2); font-size: 14.5px; max-width: 34em; margin: 0 0 44px; }
.spine { display: flex; gap: 2px; height: 3px; max-width: 300px; margin: 26px 0 0; }
.spine i { display: block; height: 100%; }
.spine i:nth-child(1) { flex: 3; background: var(--wb); }
.spine i:nth-child(2) { flex: 3; background: var(--pe); }
.spine i:nth-child(3) { flex: 2; background: var(--wl); }
ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--hair); }
li { border-bottom: 1px solid var(--hair); }
li a { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding: 15px 2px; min-height: 56px; }
li a:hover { text-decoration: none; }
li a:hover b { text-decoration: underline; text-underline-offset: .2em; }
li b { font-size: 16.5px; font-weight: 700; }
li span { font-family: var(--mono); font-size: 12.5px; color: var(--ink-3); }
.home { display: inline-flex; align-items: center; min-height: 44px; margin-top: 32px; font-size: 14.5px; color: var(--ink-2); }
.home:hover { color: var(--ink); }
</style>
</head>
<body>
<div class="wrap">
  <p class="code">404 · 没有这个页面</p>
  <h1>这里没有东西。</h1>
  <p class="lead">地址可能打错了，或者那个页面已经搬走。下面是全部三个产品。</p>
  <div class="spine" aria-hidden="true"><i></i><i></i><i></i></div>
  <ul style="margin-top:44px">
${links}
  </ul>
  <a class="home" href="/">← 回首页</a>
</div>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- 替换 */

const REGIONS = [
  { name: 'slots',    open: '<!-- @generated:slots -->',    close: '<!-- @generated:end -->', body: genSlots() },
  { name: 'noscript', open: '<!-- @generated:noscript -->', close: '<!-- @generated:end -->', body: genNoscript() },
  { name: 'planned',  open: '<!-- @generated:planned -->',  close: '<!-- @generated:end -->', body: genPlanned() },
  { name: 'data',     open: '/* @generated:data */',        close: '/* @generated:end */',    body: genData() },
];

let html = readFileSync(HTML_PATH, 'utf8');
const missing = [];

for (const r of REGIONS) {
  const o = html.indexOf(r.open);
  const c = html.indexOf(r.close, o + r.open.length);
  if (o === -1 || c === -1) { missing.push(r.name); continue; }
  const before = html.slice(0, o + r.open.length);
  const after = html.slice(c);
  html = before + '\n' + r.body + '\n' + after;
}

if (missing.length) {
  console.error('index.html 里找不到这些生成区的标记：' + missing.join(', '));
  console.error('标记必须成对存在：<!-- @generated:名字 --> … <!-- @generated:end -->');
  process.exit(2);
}

/* 结构自检：生成的内容不能自带**外层容器本身**。
   踩过一次：genPlanned 自己带了 <ul class="planned">，被塞进外层已有的
   <ul class="planned"> 里，变成 ul 嵌 ul —— flex 布局失效、条目竖成一列，
   页面凭空高 300 多像素，而所有门禁都是绿的（没有一条规则会因此报错）。

   判据是「标签 + class 都相同」，不能只看标签：
   生成区里本来就有重复单元（slots 的 <article>、noscript 的
   <div class="map-panel">），那些是对的；错的只有"把外层容器又写了一遍"。
   只看标签会把重复单元一起误杀。 */

const structProblems = [];

// 每个生成区外层容器的 标签 + class（已存在于手写 HTML 里）
const OUTER = {
  slots:    { tag: 'div', cls: 'slots' },
  noscript: { tag: 'div', cls: 'map' },
  planned:  { tag: 'ul',  cls: 'planned' },
  data:     null,             // JS 变量声明，没有容器概念
};

for (const r of REGIONS) {
  const outer = OUTER[r.name];
  if (outer) {
    const re = new RegExp('<' + outer.tag + '\\b[^>]*\\bclass\\s*=\\s*"([^"]*)"', 'gi');
    let m;
    while ((m = re.exec(r.body)) !== null) {
      if (m[1].split(/\s+/).includes(outer.cls)) {
        structProblems.push(
          `生成区 ${r.name} 里又写了一遍外层容器 <${outer.tag} class="${outer.cls}">。\n` +
          `      外层已经有它了，生成器只应产出容器**内部**的内容` +
          `（重复单元如 <li>/<article> 可以，容器本身不行）。`
        );
        break;
      }
    }
  }
  if (r.body.includes('@generated:')) {
    structProblems.push(`生成区 ${r.name} 的内容里又出现了 @generated 标记`);
  }
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
try { bad404 = readFileSync(HTML_404_PATH, 'utf8'); } catch { /* 首次生成，还没有 */ }

if (CHECK) {
  const problemsOut = [];
  if (current !== html) {
    // 指出第一处差异在哪一行，比丢一句"不同步"有用
    const a = current.split('\n'), b = html.split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
    problemsOut.push(
      '✗ index.html 与 data/products.json 不同步\n' +
      `  第一处差异在第 ${line + 1} 行：\n` +
      `    现在: ${(a[line] ?? '(文件结束)').trim().slice(0, 90)}\n` +
      `    应为: ${(b[line] ?? '(文件结束)').trim().slice(0, 90)}`
    );
  }
  if (bad404 !== notFound) problemsOut.push('✗ 404.html 与数据/令牌不同步');

  if (problemsOut.length) {
    problemsOut.forEach(p => console.error(p));
    console.error('  跑 `node tools/build.mjs` 重新生成。');
    process.exit(1);
  }
  console.log(`✓ 生成物与 data/products.json 同步（${products.length} 个产品，index.html + 404.html）`);
  process.exit(0);
}

const written = [];
if (current !== html) { writeFileSync(HTML_PATH, html); written.push('index.html'); }
if (bad404 !== notFound) { writeFileSync(HTML_404_PATH, notFound); written.push('404.html'); }

if (written.length) {
  console.log(`✓ 已生成 ${products.length} 个产品：${written.join(' + ')}`);
} else {
  console.log(`已是最新，无需改动（${products.length} 个产品）`);
}
