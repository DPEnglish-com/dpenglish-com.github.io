#!/usr/bin/env node
// 母站名称顺序与账号边界契约。纯静态读取，不启动浏览器。
//
//   node tools/site-contract.mjs
//
// 为什么单独一道门：build 只保证「数据能生成页面」，渲染审计只看对比度、
// 溢出和触控目标。产品名是不是英文在前、title/description/og 有没有同步、
// 账号区有没有偷偷出现凭据输入或已登录状态 —— 这些没人会从截图上发现。
// 这里把 2026-10-27 的增量写成可执行断言，改了名字或账号文案就会失败。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

const BRAND = 'HeadToToe 从头到脚';
const EXPECTED = [
  { id: 'argue', name: 'Wenbian 问辩' },
  { id: 'eye', name: 'CourseDistill 课蒸馏' },
  { id: 'lang', name: 'PaperEcho 纸上回声' },
  { id: 'se', name: 'SE English 英语训练' },
  { id: 'body', name: 'WorkoutLoop 训练环' },
  { id: 'outer', name: 'OuterStyle 外在' },
];
const SE_LOGIN = 'https://www.seandictation.site/login';

const fails = [];
const passes = [];
const check = (ok, msg) => { (ok ? passes : fails).push(msg); };
const firstCjk = s => s.search(/[\u3400-\u9FFF]/);
const firstLatin = s => s.search(/[A-Za-z]/);
const englishFirst = s => firstLatin(s) >= 0 && firstCjk(s) >= 0 && firstLatin(s) < firstCjk(s);

function inOrder(text, names) {
  let pos = -1;
  for (const name of names) {
    const at = text.indexOf(name, pos + 1);
    if (at <= pos) return false;
    pos = at;
  }
  return true;
}
function metaContent(html, attr, key) {
  const re = new RegExp('<meta\\s+' + attr + '="' + key + '"\\s+content="([^"]*)"');
  const m = html.match(re);
  return m ? m[1] : '';
}

/* ---------------------------------------------------------------- 数据源 */

const data = JSON.parse(read('data/products.json'));
const products = data.products;
const names = products.map(p => p.name);

check(products.length === 6, '数据里有 6 个产品');
check(products.every((p, i) => p.id === EXPECTED[i].id), '产品顺序仍是 01–06 的章节顺序');
EXPECTED.forEach((want, i) => {
  const got = products[i] && products[i].name;
  check(got === want.name, 'products[' + i + '].name = 「' + want.name + '」（实为「' + got + '」）');
  check(got && englishFirst(got), 'products[' + i + '] 英文在中文之前：' + got);
});
check(new Set(names).size === 6, '六个产品名互不重复');

const accountData = data.site && data.site.account;
check(!!accountData, 'data.site.account 存在（账号区有唯一数据源）');
check(accountData && accountData.status === '统一账号尚未接入', '数据声明的账号状态是「统一账号尚未接入」');
check(accountData && accountData.link && accountData.link.href === SE_LOGIN, '数据里的账号链接是 SE English 登录页');
check(accountData && accountData.link && accountData.link.label === '登录 SE English', '数据里的链接标签是「登录 SE English」');
check(accountData && accountData.link && /不等于统一账号/.test(accountData.link.note || ''), '数据里的链接说明写明不等于统一账号');

/* ---------------------------------------------------------------- 页面 */

const html = read('index.html');
const notFound = read('404.html');
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const desc = metaContent(html, 'name', 'description');
const ogTitle = metaContent(html, 'property', 'og:title');
const ogDesc = metaContent(html, 'property', 'og:description');
const ogSite = metaContent(html, 'property', 'og:site_name');

check(title.includes(BRAND), 'title 含品牌全称');
check(title.indexOf('HeadToToe') < title.indexOf('从头到脚'), 'title 里英文在中文之前');
check(title === 'HeadToToe 从头到脚 · 六个产品，各管一处', 'title 是本次约定的完整标题');
check(desc.includes(BRAND), 'description 含品牌全称');
check(desc.indexOf('HeadToToe') < desc.indexOf('从头到脚'), 'description 里英文在中文之前');
check(inOrder(desc, names), 'description 里六个产品名按英文在前顺序排列');
check(ogTitle === title, 'og:title 与 title 一致');
check(ogSite === BRAND, 'og:site_name 是「' + BRAND + '」');
check(ogDesc.includes(BRAND), 'og:description 含品牌全称');

/* 顶栏词标与首屏词标：两段文字，英文在前，移动端不隐藏英文 */
const header = (html.match(/<a class="brand"[\s\S]*?<\/a>/) || [])[0] || '';
check(!!header, '顶栏有词标');
check(header.indexOf('HeadToToe') >= 0 && header.indexOf('HeadToToe') < header.indexOf('从头到脚'), '顶栏词标英文在前');
check(/aria-label="HeadToToe 从头到脚[^"]*"/.test(header), '顶栏词标 aria-label 同步');

const hero = (html.match(/<h1 class="hero-title"[\s\S]*?<\/h1>/) || [])[0] || '';
check(!!hero, '首屏 h1 存在');
check(hero.indexOf('HeadToToe') >= 0 && hero.indexOf('HeadToToe') < hero.indexOf('从头到脚'), '首屏 h1 英文在前');
check(/aria-label="HeadToToe 从头到脚"/.test(hero), '首屏 h1 aria-label 同步');

check(!/\.brand-(?:en|mark)[^{}]*\{[^{}]*display\s*:\s*none/.test(html), '没有 CSS 规则把顶栏英文/中文整段隐藏');
check(html.includes('HeadToToe'), '移动端仍能在顶栏读到英文品牌');

/* 生成区同步：目录、章节、页脚、404 都按同一顺序 */
const tocNames = [...html.matchAll(/<span class="toc-name">([^<]*)<\/span>/g)].map(m => m[1]);
const chapterNames = [...html.matchAll(/<h2 class="chapter-name"[^>]*>([^<]*)<\/h2>/g)].map(m => m[1]);
const frameNames = [...html.matchAll(/<span class="frame-name">([^<]*)<\/span>/g)].map(m => m[1]);
const footNames = [...html.matchAll(/<div class="foot-links">([\s\S]*?)<!-- @generated:end -->/g)]
  .flatMap(m => [...m[1].matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map(x => x[1]));
check(tocNames.join('|') === names.join('|'), '目录六行按英文在前顺序：' + tocNames.join(' / '));
check(chapterNames.join('|') === names.join('|'), '六章标题按英文在前顺序');
check(frameNames.join('|') === names.join('|'), '首屏六帧按英文在前顺序');
check(footNames.join('|') === names.join('|'), '页脚六个产品按英文在前顺序（实为 ' + footNames.join(' / ') + '）');

const notFoundTitle = (notFound.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
check(notFoundTitle.includes(BRAND), '404 title 含品牌全称');
check(notFoundTitle.indexOf('HeadToToe') < notFoundTitle.indexOf('从头到脚'), '404 title 英文在中文之前');
check(notFound.includes('<a href="/">' + BRAND + '</a>'), '404 可见品牌链接同步');
check(inOrder(notFound, names), '404 六个产品按英文在前顺序');

check(!html.includes('问辩 Wenbian') && !notFound.includes('问辩 Wenbian'), '旧的「问辩 Wenbian」写法已清除');
check(!html.includes('外在 OuterStyle') && !notFound.includes('外在 OuterStyle'), '旧的「外在 OuterStyle」写法已清除');

/* aria 同步：每个产品至少有一个播放入口以新名字命名 */
names.forEach(name => {
  check(html.includes('aria-label="播放' + name + '的片子"'), '播放入口 aria-label 使用「' + name + '」');
});

/* ---------------------------------------------------------------- 账号边界 */

check(html.includes('id="account"'), '页面有账号区');
check(html.includes('aria-labelledby="accountTitle"'), '账号区有可读标题关联');
check(html.includes('<a href="#account">账号</a>'), '顶栏有可达的账号入口');
check(html.includes('<h2 id="accountTitle">账号</h2>'), '账号区标题是「账号」');

const accStart = html.indexOf('id="account"');
const accEnd = html.indexOf('</section>', accStart);
const accountHtml = accStart >= 0 && accEnd > accStart ? html.slice(accStart, accEnd) : '';
check(!!accountHtml, '能定位账号区内容');
check(accountHtml.includes('统一账号尚未接入'), '账号区明说「统一账号尚未接入」');
check(accountHtml.includes('项目数据仍各自保管'), '账号区明说项目数据仍各自保管');
check(accountHtml.includes('不是你的学习进度或项目摘要'), '账号区不把公开简介冒充用户摘要');
check(new RegExp('<a class="btn btn-line" href="' + SE_LOGIN + '"[^>]*>登录 SE English').test(accountHtml),
  '账号区只有准确标注的「登录 SE English」真实链接');
check(accountHtml.includes('不等于统一账号'), '账号区不把 SE 会话说成统一会话');

check(!/<form\b/i.test(accountHtml), '账号区没有表单');
check(!/<input\b/i.test(accountHtml), '账号区没有输入框');
check(!/<textarea\b/i.test(accountHtml), '账号区没有文本域');
check(!/type="password"/i.test(accountHtml), '账号区没有密码字段');
check(!/name="(email|password)"/i.test(accountHtml), '账号区没有邮箱/密码字段');
check(!/autocomplete="(email|current-password|username)"/i.test(accountHtml), '账号区没有凭据自动填充提示');
for (const fake of ['退出登录', '我的账号', '欢迎回来', '登录成功', '当前用户', '我的进度']) {
  check(!accountHtml.includes(fake), '账号区没有假登录状态文案「' + fake + '」');
}

/* 全页不创建本机账号状态：唯一的持久化是主题键 */
const setItems = [...html.matchAll(/localStorage\.setItem\(([^)]*)\)/g)].map(m => m[1]);
check(setItems.length === 1 && setItems[0].includes('ctdj-theme'), '全页只写一个 localStorage 键：ctdj-theme');
check(!/sessionStorage|document\.cookie|indexedDB/.test(html), '没有 sessionStorage / cookie / IndexedDB 账号状态');
check(!/fetch\(|XMLHttpRequest/.test(html), '页面没有向任何账号接口发请求');

/* ---------------------------------------------------------------- 结构保留 */

const count = re => (html.match(re) || []).length;
check(count(/<article class="chapter"/g) === 6, '六章保留');
check(count(/<li class="toc-row"/g) === 6, '六行目录保留');
check(count(/<a class="frame"/g) === 6, '六帧接触印样保留');
check(count(/class="rail-item"/g) === 5, '五个部位锚点保留');
check(count(/class="body-figure"/g) === 2, '首屏与脊柱两具人形保留');
check(count(/data-open="video"/g) === 6, '六个播放入口保留');
check(count(/data-open="demo"/g) === 6, '六个试用入口保留');
check(count(/<noscript>/g) === 6, '六章 noscript 直链保留');
check(count(/<img [^>]*loading="lazy"/g) >= 12, '封面图继续懒加载');

/* ---------------------------------------------------------------- 汇总 */

console.log('站点契约：' + passes.length + ' 项通过 / ' + fails.length + ' 项失败');
if (fails.length) {
  console.log('\n✗ 名称、元数据或账号边界不符合契约：');
  fails.forEach(f => console.log('  - ' + f));
  console.log('\n  改 data/products.json 与 index.html 后重跑。不要删断言换取通过。');
  process.exit(1);
}
console.log('✓ 7 个品牌英文在前、元数据与 404 同步、账号区无凭据输入且只给真实 SE 登录页');
process.exit(0);
