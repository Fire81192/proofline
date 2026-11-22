import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { joinFrontmatter } from '../src/core/frontmatter.js';
import { KEY_ORDER } from '../src/core/schema.js';
import { valueTables, valueConflicts } from '../src/topics.js';
import { validateEntry } from '../src/core/validate.js';
import { buildEntry, readerOf, SNAPSHOT } from './helpers.js';

/**
 * 数值字段。
 *
 * 它解决的问题：`review` 原来只把主张一句一句列出来。八条主张说的都是
 * 「PM2.5 年均限值」、数值分别是 35/9/25/10/5，它一个旗都不挂——因为旗子
 * 比的是元数据，八条全是 unresolved、全可引用、全「标准」层。
 *
 * 这里做的不是判断对错，是**排版成可比的形态**。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function addEntry(root, id, overrides = {}) {
  const dir = join(root, id);
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  const data = {
    schema: 1, id,
    claim: '这是一条测试用的主张，够长了',
    kind: '方法', layer: '标准', basis: '条目', topic: 'aqi.pm25.annual',
    source_kind: '文章', source_extraction: '原文',
    source_sha256: sha256(SNAPSHOT),
    evidence_status: 'supported', world_status: 'unresolved',
    quotes: ['hello world'], added_at: '2026-11-21',
    ...overrides,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  await writeFile(join(dir, 'entry.md'), joinFrontmatter(data, '', KEY_ORDER), 'utf8');
  return dir;
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pl-value-'));
  const root = join(dir, 'entries');
  await mkdir(root, { recursive: true });
  return { dir, root };
}

const V = (n, scope, extra = {}) => ({ metric: 'pm25.annual', number: n, unit: 'µg/m³', scope, subject: scope.split(' ')[0], ...extra });

// ---------------------------------------------------------------- 分组与排序

test('valueTables：同一指标排成一张表，按数值降序', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, '中国') },
    { id: 'b', claim: '乙', value: V(9, '美国') },
    { id: 'c', claim: '丙', value: V(25, '欧盟') },
  ]);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows.map((r) => r.number), [35, 25, 9]);
  assert.equal(tables[0].distinct, 3);
});

test('valueTables：不同单位的同指标不混在一张表里', () => {
  // 每组两条，否则会被「不足两条不出表」先过滤掉，测不到单位分组。
  const tables = valueTables([
    { id: 'a', claim: '甲', value: { metric: 'x', number: 1, unit: 'µg/m³', scope: 's1' } },
    { id: 'b', claim: '乙', value: { metric: 'x', number: 2, unit: 'µg/m³', scope: 's2' } },
    { id: 'c', claim: '丙', value: { metric: 'x', number: 3, unit: 'ppm', scope: 's3' } },
    { id: 'd', claim: '丁', value: { metric: 'x', number: 4, unit: 'ppm', scope: 's4' } },
  ]);
  assert.equal(tables.length, 2);
  const units = tables.map((t) => t.unit).sort();
  assert.deepEqual(units, ['ppm', 'µg/m³']);
});

test('valueTables：只有一条数值时不出表（没有对照的意义）', () => {
  assert.deepEqual(valueTables([{ id: 'a', claim: '甲', value: V(35, '中国') }]), []);
});

test('valueTables：没有 value 的条目被跳过，不影响别的', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, '中国') },
    { id: 'b', claim: '乙' },
    { id: 'c', claim: '丙', value: V(9, '美国') },
  ]);
  assert.equal(tables[0].rows.length, 2);
});

test('valueTables：值越多的指标排越前（那才是要看的那张）', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: { metric: 'a', number: 1, unit: 'u', scope: 's' } },
    { id: 'b', claim: '乙', value: { metric: 'a', number: 2, unit: 'u', scope: 's' } },
    { id: 'c', claim: '丙', value: { metric: 'b', number: 1, unit: 'u', scope: 's' } },
    { id: 'd', claim: '丁', value: { metric: 'b', number: 2, unit: 'u', scope: 's' } },
    { id: 'e', claim: '戊', value: { metric: 'b', number: 3, unit: 'u', scope: 's' } },
  ]);
  assert.equal(tables[0].metric, 'b');
});

// ---------------------------------------------------------------- 同口径冲突

test('valueConflicts：同 scope 不同值 -> 冲突（唯一能说「不可能同时成立」的情况）', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(25, '欧盟 现行') },
    { id: 'b', claim: '乙', value: V(10, '欧盟 现行') },
  ]);
  const c = valueConflicts(tables);
  assert.equal(c.length, 1);
  assert.equal(c[0].scope, '欧盟 现行');
  assert.deepEqual(c[0].rows.map((r) => r.number).sort((x, y) => x - y), [10, 25]);
});

test('valueConflicts：不同 scope 不同值 -> 不是冲突（各说各的）', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, '中国') },
    { id: 'b', claim: '乙', value: V(9, '美国') },
  ]);
  assert.deepEqual(valueConflicts(tables), []);
});

test('valueConflicts：同 scope 同值不算冲突（只是重复）', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, 'WHO 过渡目标 IT-1') },
    { id: 'b', claim: '乙', value: V(35, 'WHO 过渡目标 IT-1') },
  ]);
  assert.deepEqual(valueConflicts(tables), []);
});

test('valueConflicts：同 scope 但生效日期不同 -> 不是冲突（是同一个规定的两个阶段）', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(25, '欧盟', { effective_from: '2015-01-01' }) },
    { id: 'b', claim: '乙', value: V(10, '欧盟', { effective_from: '2030-01-01' }) },
  ]);
  assert.deepEqual(valueConflicts(tables), []);
});

// ---------------------------------------------------------------- 校验

test('validate：value 缺 scope 直接拒——不写清口径的数没法比', () => {
  const r = validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text: buildEntry({ value: { metric: 'pm25.annual', number: 35, unit: 'µg/m³' } }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /scope 不能空/.test(h)));
});

test('validate：value 缺 subject 直接拒——表要靠它分组', () => {
  const r = validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text: buildEntry({ value: { metric: 'pm25.annual', number: 35, unit: 'µg/m³', scope: '中国 二级' } }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /subject 不能空/.test(h)));
});

test('validate：number 是字符串也不行（"35" 不是数值）', () => {
  const r = validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text: buildEntry({ value: V('35', '中国') }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /number 必须是有限数字/.test(h)));
});

test('validate：NaN / Infinity 被拒', () => {
  for (const n of [NaN, Infinity]) {
    const r = validateEntry({
      dirName: '2026-11-21-xml-tag-prompt',
      text: buildEntry({ value: { metric: 'x', number: n, unit: 'u', scope: 's' } }),
      snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
    });
    assert.equal(r.status, 'hard_fail', String(n));
  }
});

test('validate：value 有多余的键就拒', () => {
  const r = validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text: buildEntry({ value: { ...V(35, '中国'), note2: 'x' } }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /来路不明的键/.test(h)));
});

test('validate：effective_from 那天不存在就拒', () => {
  const r = validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text: buildEntry({ value: V(35, '中国', { effective_from: '2026-02-31' }) }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /那天不存在/.test(h)));
});

// ---------------------------------------------------------------- CLI 输出

test('review：数值表出现在条目列表之前，并点出重复的数值', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-22-a', { value: V(35, '中国 GB 3095-2012 二级') });
  await addEntry(root, '2026-11-22-b', { value: V(35, 'WHO 过渡目标 IT-1') });
  await addEntry(root, '2026-11-22-c', { value: V(9, '美国 EPA') });

  const r = run(['review', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /指标 pm25\.annual（µg\/m³） · 3 条带数值 · 2 个不同值/);
  assert.match(r.stdout, /35 出现 2 次/);
  // 表在列表之前：表的标题行位置要早于第一条 claim
  assert.ok(r.stdout.indexOf('指标 pm25.annual') < r.stdout.indexOf('[标准] 这是一条测试用'), '表应该在条目列表之前');
});

test('review：同口径不同值会单独点名', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-22-a', { value: V(25, '欧盟 现行') });
  await addEntry(root, '2026-11-22-b', { value: V(10, '欧盟 现行') });

  const r = run(['review', root]);
  assert.match(r.stdout, /同口径不同值/);
  assert.match(r.stdout, /不可能同时成立/);
});

test('review：没有 value 的条目照常列出，不因为缺字段就消失', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-22-a');
  const r = run(['review', root]);
  assert.match(r.stdout, /这是一条测试用的主张/);
  assert.equal(/指标 /.test(r.stdout), false);
});

// ---------------------------------------------------------------- 按主体分组

test('valueTables：按 subject 分组，组内按数值降序', () => {
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, '中国 二级') },
    { id: 'b', claim: '乙', value: V(25, '欧盟 现行') },
    { id: 'c', claim: '丙', value: V(10, '欧盟 2030') },
    { id: 'd', claim: '丁', value: V(5, 'WHO 准则') },
  ]);
  const g = tables[0].groups;
  // 组按组内最大值降序：中国 35 最前，WHO 5 最后
  assert.deepEqual(g.map((x) => x.subject), ['中国', '欧盟', 'WHO']);
  assert.deepEqual(g[1].rows.map((r) => r.number), [25, 10]);
});

test('valueTables：同一主体多个值 -> 分组后一眼看见', () => {
  // 这正是 subject 的用途：平铺一排数字看不出「谁是同一个人说的」。
  const tables = valueTables([
    { id: 'a', claim: '甲', value: V(35, 'WHO IT-1') },
    { id: 'b', claim: '乙', value: V(5, 'WHO AQG') },
    { id: 'c', claim: '丙', value: V(9, '美国 一级') },
  ]);
  const who = tables[0].groups.find((x) => x.subject === 'WHO');
  assert.equal(who.rows.length, 2);
  assert.deepEqual(who.rows.map((r) => r.number), [35, 5]);
});
