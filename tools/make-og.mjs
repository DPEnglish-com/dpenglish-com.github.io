// 生成 assets/og.png（社交分享卡片，1200×630）。
//
// 这张图以前是外部产出的、仓库里没有生成脚本 —— 于是加了第四个产品之后，
// 卡片上还写着「三个产品」，而页面已经改了。这里把它变成可重跑的：
//   · 词标字体不重新内嵌一份，直接从 index.html 里那份 base64 子集取，
//     所以「从头到脚」四个字在页面和卡片上永远同源；
//   · 产品行、色点、色码条写在 tools/og.html 里，改完跑这个脚本即可。
//
// 用法：node tools/make-og.mjs
// 需要 Chrome，路径解析与另一个工具共用（tools/chrome.mjs，认 $CHROME_PATH）。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CHROME } from './chrome.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'index.html');
const TPL = join(ROOT, 'tools', 'og.html');
const OUT = join(ROOT, 'assets', 'og.png');

const html = readFileSync(SRC, 'utf8');
const m = html.match(/url\((data:font\/woff2;base64,[^)]+)\)/);
if (!m) {
  throw new Error('在 index.html 里找不到内嵌的词标字体（data:font/woff2;base64,…）。' +
    '如果词标换了形式，这里要跟着改，不能静默出一张用错字体的图。');
}

const filled = readFileSync(TPL, 'utf8').replace('__FONT__', m[1]);
if (filled.includes('__FONT__')) throw new Error('tools/og.html 里没有 __FONT__ 占位符');

const dir = mkdtempSync(join(tmpdir(), 'og-'));
const page = join(dir, 'og.html');
writeFileSync(page, filled);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1200,630',
  `--screenshot=${OUT}`, 'file://' + page,
], { stdio: ['ignore', 'ignore', 'inherit'] });

chrome.on('exit', code => {
  if (code !== 0) throw new Error(`Chrome 退出码 ${code}`);
  console.log(`✓ 已生成 ${OUT.replace(ROOT + '/', '')}（1200×630）`);
});
