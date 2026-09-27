// 设计规则检测。用 design-stack skill 的同一个引擎（impeccable）。
//
//   node tools/design-lint.mjs index.html
//   node tools/design-lint.mjs index.html --json    原始 findings（未过滤）
//
// 为什么不用 `$DSH_HOME/skills/design-stack/scripts/design-check`：
// 那个脚本依赖本机的技能目录，CI 里没有。这个包装走 npm 上的同一个引擎，
// 本机和 CI 跑的是同一套规则。
//
// 关于豁免：引擎自己会读 .impeccable/config.json 的 detector.ignoreRules
// 并把命中的规则直接滤掉 —— 那样输出里就只剩"0 条"，
// 看不出"本来有几条、豁免了几条"。这里用 --no-config 拿完整结果，
// 再按同一份配置自己过滤，把两边的数字都打出来。豁免因此是**可见的**：
// 被豁免的规则一旦出现新实例（比如又加了一个 cramped-padding 的区块），
// 条数会变，但不静默消失。

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? 'index.html';
const asJson = process.argv.includes('--json');

/* ---- 读豁免 ---- */

let ignoreRules = [];
const cfgPath = join(ROOT, '.impeccable', 'config.json');
if (existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    ignoreRules = cfg?.detector?.ignoreRules ?? [];
  } catch (e) {
    console.error('✗ .impeccable/config.json 解析失败：' + e.message);
    process.exit(2);
  }
}

/* ---- 跑引擎（--no-config：拿未过滤的完整结果）---- */

const localBin = join(ROOT, 'node_modules', '.bin', 'impeccable');
const hasLocal = existsSync(localBin);

const args = ['detect', '--json', '--no-config', resolve(ROOT, target)];
const r = hasLocal
  ? spawnSync(localBin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  : spawnSync('npx', ['-y', 'impeccable@4', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

if (r.error) {
  console.error('✗ 跑不起来检测器：' + r.error.message);
  console.error('  先 `npm install`（或让 npx 能联网拉 impeccable）。');
  process.exit(2);
}

let findings;
try {
  // 引擎在 stderr 上可能带 npm 警告，stdout 才是 JSON
  findings = JSON.parse(r.stdout);
} catch (e) {
  console.error('✗ 检测器输出不是 JSON：' + e.message);
  console.error('  stdout 前 400 字：' + (r.stdout || '(空)').slice(0, 400));
  console.error('  stderr 前 400 字：' + (r.stderr || '(空)').slice(0, 400));
  process.exit(2);
}

if (!Array.isArray(findings)) {
  console.error('✗ 检测器返回的不是数组');
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

/* ---- 分类 ---- */

const ignored = findings.filter(f => ignoreRules.includes(f.antipattern));
const kept = findings.filter(f => !ignoreRules.includes(f.antipattern));

const byRule = new Map();
for (const f of kept) {
  const k = f.antipattern;
  if (!byRule.has(k)) byRule.set(k, []);
  byRule.get(k).push(f);
}

console.log(`检测目标：${target}`);
console.log(`引擎报告 ${findings.length} 条；豁免 ${ignored.length} 条；待处理 ${kept.length} 条`);

if (ignored.length) {
  const counts = new Map();
  for (const f of ignored) counts.set(f.antipattern, (counts.get(f.antipattern) ?? 0) + 1);
  for (const [rule, n] of counts) {
    console.log(`  · 已豁免 [${rule}] ${n} 条 —— 理由见 .impeccable/config.json`);
  }
}

if (kept.length === 0) {
  console.log('✓ 设计规则检测通过');
  process.exit(0);
}

console.log(`✗ ${kept.length} 条需要处理：`);
for (const [rule, list] of byRule) {
  console.log(`\n  [${rule}] ${list.length} 条  (${list[0].severity} / ${list[0].category})`);
  list.slice(0, 5).forEach(f => {
    console.log(`    ${f.snippet.slice(0, 120)}`);
  });
  if (list.length > 5) console.log(`    …还有 ${list.length - 5} 条`);
}
console.log('\n  确实不该改的，把规则名加进 .impeccable/config.json 的 detector.ignoreRules，');
console.log('  并在同一文件里写清可复现的证据。不要靠删检测器来"通过"。');
process.exit(1);
