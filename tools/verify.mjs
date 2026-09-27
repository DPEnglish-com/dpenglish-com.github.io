// 一次跑完所有门禁。CI 和本机用同一个入口，避免"CI 跑的和我跑的不一样"。
//
//   node tools/verify.mjs              全部
//   node tools/verify.mjs --no-browser 跳过需要 Chrome 的项（快，改文案时用）
//   node tools/verify.mjs --target URL 对线上跑（渲染/交互/动画/边界四项）
//
// 每项独立进程，一项失败不影响后面的继续跑 —— 一次看到全部问题，
// 而不是修一个跑一遍。最后汇总，有失败则整体退出码 1。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const NO_BROWSER = args.includes('--no-browser');
const ti = args.indexOf('--target');
const TARGET = ti >= 0 ? args[ti + 1] : 'index.html';
const REMOTE = /^https?:\/\//.test(TARGET);

// [名称, 命令, 是否用浏览器, 是否可在线上跑]
const GATES = [
  ['0) 生成物同步', ['node', ['tools/build.mjs', '--check']], false, false],
  ['1) 静态令牌对比度', ['python3', ['tools/contrast-audit.py', 'index.html']], false, false],
  ['2) 真实渲染审计', ['node', ['tools/render-audit.mjs', TARGET]], true, true],
  ['3) 图版交互', ['node', ['tools/map-interact.mjs', TARGET, '/tmp/verify-map', '1440', 'dark']], true, true],
  ['4) 动画时序', ['node', ['tools/map-anim.mjs', TARGET, '/tmp/verify-anim', 'dark']], true, true],
  ['5) 边界路径', ['node', ['tools/edge-cases.mjs', TARGET]], true, true],
  ['6) 设计规则检测', ['node', ['tools/design-lint.mjs', 'index.html']], false, false],
  ['7) 豁免依据复核', ['node', ['tools/measure-exemptions.mjs']], true, false],
];

const results = [];
const started = Date.now();

for (const [name, [cmd, cmdArgs], needsBrowser, remoteOk] of GATES) {
  if (NO_BROWSER && needsBrowser) { results.push({ name, status: 'skip', why: '--no-browser' }); continue; }
  if (REMOTE && !remoteOk) { results.push({ name, status: 'skip', why: '只对本地跑' }); continue; }

  process.stdout.write(`\n──────── ${name} ────────\n`);
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  const ms = Date.now() - t0;

  if (r.error) results.push({ name, status: 'error', why: r.error.message, ms });
  else if (r.status === 0) results.push({ name, status: 'pass', ms });
  else results.push({ name, status: 'fail', code: r.status, ms });
}

/* ---------------------------------------------------------------- 汇总 */

const mark = { pass: '✓', fail: '✗', skip: '−', error: '!' };
console.log('\n' + '═'.repeat(58));
console.log(`验收汇总${REMOTE ? '（目标：' + TARGET + '）' : ''}`);
console.log('─'.repeat(58));
for (const r of results) {
  const t = r.ms != null ? `${(r.ms / 1000).toFixed(1)}s`.padStart(7) : '      —';
  const why = r.why ? `  (${r.why})` : r.code ? `  (退出码 ${r.code})` : '';
  console.log(`  ${mark[r.status]} ${r.name.padEnd(20)}${t}${why}`);
}
const bad = results.filter(r => r.status === 'fail' || r.status === 'error');
const skipped = results.filter(r => r.status === 'skip');
console.log('─'.repeat(58));
console.log(`  ${results.length - bad.length - skipped.length} 通过 / ${bad.length} 失败 / ${skipped.length} 跳过` +
  `　共 ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (bad.length) {
  console.log('\n  失败项的详细输出见上方各自的小节。');
  process.exit(1);
}
console.log('\n✓ 全部通过');
process.exit(0);
