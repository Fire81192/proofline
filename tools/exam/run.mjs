/**
 * 跑考卷。
 *
 * 指标只有两个：
 *   recall        —— 正题里有多少能定位到（该收的收了吗）
 *   falsePositive —— 负题里有多少被误判命中（不该收的收了吗）
 *
 * 门：
 *   recall ≥ baseline.recall − 0.05
 *   falsePositive === 0
 *
 * ## 为什么误报的门是 0，不是「尽量少」
 *
 * 正题不中会被抱怨，负题中了没人知道。一个「偶尔把改过的字当成原文」的工具，
 * 会让整条证据链的可信度变成零——因为你没法知道哪几条是那种情况。
 *
 * 误报不是「质量下降」，是「这个工具的前提不成立了」。
 *
 * ## 调参只许在草稿题上做
 *
 * 这份 questions.jsonl 是冻结的。改 quote.js 之后如果过不了，不许改题，
 * 只能改代码——否则就是「改考题让它及格」。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateQuote } from '../../src/core/quote.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const Q = join(HERE, 'questions.jsonl');
const B = join(HERE, 'baseline.json');
const RECALL_MARGIN = 0.05;

if (!existsSync(Q)) {
  console.error('没有题库。先跑：node tools/exam/build.mjs');
  process.exit(2);
}

const rows = readFileSync(Q, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pos = rows.filter((r) => r.kind === 'positive');
const neg = rows.filter((r) => r.kind === 'negative');

let hitCount = 0;
let falsePositive = 0;
let degraded = 0;
const byMode = {};
const misses = [];
const fps = [];
const degradedList = [];

for (const r of pos) {
  const hit = locateQuote(r.snapshot, r.quote);
  if (hit) {
    hitCount += 1;
    byMode[hit.mode] = (byMode[hit.mode] ?? 0) + 1;
    // 级别退化：生成题库时是 exact，现在降成 normalized 了。
    // recall 看不见这个——降级匹配会把「该精确命中的」救回来，
    // 结果一样是「中了」，但引文的严谨度已经下降。
    // 实测：把 indexOf 人为弄坏，44 条正题仍全中，只是 exact 26 全变成 normalized。
    if (r.expectMode && hit.mode !== r.expectMode) {
      degraded += 1;
      degradedList.push({ id: r.id, expect: r.expectMode, got: hit.mode });
    }
  } else {
    misses.push(r);
  }
}

for (const r of neg) {
  const hit = locateQuote(r.snapshot, r.quote);
  if (hit) {
    falsePositive += 1;
    fps.push({ ...r, gotMode: hit.mode });
  }
}

const recall = pos.length > 0 ? hitCount / pos.length : 0;

const baseline = existsSync(B) ? JSON.parse(readFileSync(B, 'utf8')) : null;
const recallFloor = baseline ? baseline.recall - RECALL_MARGIN : 0;

// ---- 输出 ----

console.log(`正题 ${pos.length}：命中 ${hitCount}（${(recall * 100).toFixed(1)}%）`);
console.log(`  ${Object.entries(byMode).map(([k, v]) => `${k} ${v}`).join(' · ') || '（无）'}`);
if (misses.length > 0) {
  console.log(`  没中的 ${misses.length} 条：`);
  for (const m of misses) console.log(`    ${m.id}  「${m.quote.slice(0, 30)}${m.quote.length > 30 ? '…' : ''}」`);
}

console.log(`负题 ${neg.length}：误报 ${falsePositive}`);
if (fps.length > 0) {
  for (const f of fps) {
    console.log(`  ⚠ ${f.id}  被判 ${f.gotMode}`);
    console.log(`    引文「${f.quote.slice(0, 40)}…」`);
    console.log(`    ${f.note}`);
  }
}

if (degraded > 0) {
  console.log(`级别退化 ${degraded}：`);
  for (const d of degradedList.slice(0, 10)) console.log(`  ${d.id}  期望 ${d.expect}，实际 ${d.got}`);
  if (degradedList.length > 10) console.log(`  …还有 ${degradedList.length - 10} 条`);
} else {
  console.log('级别没有退化（生成时是 exact 的，现在还是 exact）');
}

// ---- 判定 ----

const recallOk = baseline ? recall >= recallFloor : true;
const fpOk = falsePositive === 0;
const degradedOk = degraded === 0;
const pass = recallOk && fpOk && degradedOk;

if (baseline) {
  console.log(`\n基线 recall ${baseline.recall.toFixed(3)} · 门 ${recallFloor.toFixed(3)} · 误报门 0`);
  console.log(`判定：${pass ? '通过' : !degradedOk ? '不通过（级别退化）' : !fpOk ? '不通过（有误报）' : '不通过（召回掉了）'}`);
} else {
  console.log('\n没有基线。这是第一次跑——把下面的数字写进 baseline.json：');
  console.log(JSON.stringify({ recall: Number(recall.toFixed(4)), falsePositive, degraded, questions: rows.length }, null, 2));
  if (fpOk) {
    writeFileSync(B, `${JSON.stringify({ recall: Number(recall.toFixed(4)), falsePositive, questions: rows.length }, null, 2)}\n`, 'utf8');
    console.log(`（已写入 ${B}）`);
  } else {
    console.log('有误报，不写基线——误报必须先修掉，不能记成「现状」。');
  }
}

process.exit(pass ? 0 : 1);
