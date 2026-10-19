// 核对母站对课蒸馏（眼睛）的声明，与子站仓库的实际情况是否一致。
//
// 为什么要有这一项：母站在 products.json 里声明了子站的版本、体积、包名与下载地址，
// 但这些数字的真正来源是子站仓库，母站这边没有任何东西会随子站一起更新。
// 子站换包后，母站会继续显示旧体积 —— 页面照常渲染、照常通过所有门禁，
// 只有人去点开子站才发现对不上。2026-10-17 就发生过一次包与数字的漂移
// （站上包比源码旧四天），所以这里把两边钉在一起。
//
//   node tools/check-subsites.mjs
//
// 子站仓库不在本机时跳过（CI 里没有兄弟仓库，不该因此失败）：
//   KELIUZHENG_SITE=/path/to/keliuzheng-site node tools/check-subsites.mjs

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 兄弟仓库位置：环境变量优先，其次默认的同级目录 */
const CANDIDATES = [
  process.env.KELIUZHENG_SITE,
  resolve(ROOT, '..', 'keliuzheng-site'),
].filter(Boolean);

const site = CANDIDATES.find(p => existsSync(join(p, 'index.html')));
if (!site) {
  console.log('− 找不到 keliuzheng-site 仓库，跳过（CI 里正常）。');
  console.log('  想跑本项：KELIUZHENG_SITE=/path/to/keliuzheng-site node tools/check-subsites.mjs');
  process.exit(0);
}

const fails = [];
const ok = [];
const read = p => readFileSync(join(site, p), 'utf8');

/* ---- 子站实际声明了什么 ---- */
const sub = read('index.html');

const apkNames = [...new Set([...sub.matchAll(/downloads\/(Keliuzheng-[^"]+\.apk)/g)].map(m => m[1]))];
if (apkNames.length !== 1) {
  fails.push(`子站 index.html 里的包名不唯一：${apkNames.join(' / ') || '（一个都没找到）'}`);
}
const apkName = apkNames[0];

const subHash = (sub.match(/<code class="hash">([0-9a-f]{64})<\/code>/) || [])[1];
const subSizes = [...new Set([...sub.matchAll(/(\d+\.\d+) MB/g)].map(m => m[1] + ' MB'))];
if (subSizes.length !== 1) {
  fails.push(`子站 index.html 里的体积不唯一：${subSizes.join(' / ') || '（一个都没找到）'}`);
}
const subSize = subSizes[0];

/* ---- 子站声明的哈希，必须真的等于那个包 ---- */
if (apkName && subHash) {
  const apk = join(site, 'downloads', apkName);
  if (!existsSync(apk)) {
    fails.push(`子站声明了 ${apkName}，但 downloads/ 里没有这个文件`);
  } else {
    const actual = createHash('sha256').update(readFileSync(apk)).digest('hex');
    if (actual !== subHash) {
      fails.push(
        `子站页面上的 SHA-256 与实际包不符（用户校验会失败）：\n` +
        `      页面: ${subHash}\n` +
        `      实际: ${actual}`
      );
    } else {
      // 体积与包大小对得上吗（页面按 MiB 记一位小数）
      const bytes = statSync(apk).size;
      const mib = (bytes / 1048576).toFixed(1) + ' MB';
      if (subSize && mib !== subSize) {
        fails.push(`子站页面写 ${subSize}，实际包是 ${mib}（${bytes} 字节）`);
      } else {
        ok.push(`子站：${apkName} ${mib}，哈希与包一致`);
      }
    }
  }
} else {
  fails.push('子站 index.html 里读不到包名或 SHA-256');
}

/* ---- 母站对子站的声明，必须与子站一致 ---- */
const products = JSON.parse(readFileSync(join(ROOT, 'data', 'products.json'), 'utf8'));
const eye = products.products.find(p => p.id === 'eye' || p.accent === 'eye');
if (!eye) {
  fails.push('data/products.json 里找不到课蒸馏（id/accent = eye）');
} else {
  if (eye.size !== subSize) {
    fails.push(`母站写体积 ${eye.size}，子站写 ${subSize}`);
  }
  const href = (eye.links.find(l => /下载|APK/.test(l.label)) || eye.links[0] || {}).href || '';
  if (apkName && !href.endsWith(apkName)) {
    fails.push(`母站的下载地址指向 ${href}，子站的包是 ${apkName}`);
  }
  // 版本：子站的包名里带版本，母站的 short / version 也带
  if (apkName) {
    const v = (apkName.match(/Keliuzheng-([\d.]+)-/) || [])[1];
    if (v && eye.version !== v) fails.push(`母站写版本 ${eye.version}，子站包名是 ${v}`);
    if (v && !eye.short.includes(v)) fails.push(`母站 short "${eye.short}" 里没有版本 ${v}`);
  }
  if (!fails.length) ok.push(`母站声明与子站一致：v${eye.version} · ${eye.size} · ${apkName}`);
}

console.log('─'.repeat(64));
ok.forEach(o => console.log('✓ ' + o));
if (fails.length) {
  console.log('\n✗ 母站与子站对不上：');
  fails.forEach(f => console.log('  - ' + f));
  console.log('\n  先改子站（换包走 sh tools/publish-apk.sh），再改母站 data/products.json，');
  console.log('  然后 node tools/build.mjs 重生成。两边不要各改各的。');
  process.exit(1);
}
console.log('\n✓ 母站对课蒸馏的声明与子站仓库一致');
