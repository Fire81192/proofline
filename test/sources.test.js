import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupBySource, overview, statusOf, impactOf, readSources, writeSources } from '../src/sources.js';

const E = (id, uri, extra = {}) => ({ id, data: { claim: `主张 ${id}`, source_uri: uri, ...extra } });

test('按来源聚合：同一个 uri 的条目归到一起', () => {
  const g = groupBySource([E('a', 'p1'), E('b', 'p1'), E('c', 'p2')]);
  assert.equal(g.size, 2);
  assert.equal(g.get('p1').entries.length, 2);
  assert.equal(g.get('p2').entries.length, 1);
});

test('没填来源的条目归到「未登记来源」，不丢', () => {
  const g = groupBySource([E('a', undefined), E('b', '')]);
  assert.equal(g.size, 1);
  assert.equal(g.get('（未登记来源）').entries.length, 2);
});

test('没登记过的来源默认「在用」——默认信任，不是默认怀疑', () => {
  assert.equal(statusOf({}, 'p1').status, '在用');
  assert.equal(statusOf({}, 'p1').blocking, undefined);
});

test('登记表里的非法状态回落到「在用」', () => {
  assert.equal(statusOf({ p1: { status: '随便写的' } }, 'p1').status, '在用');
});

test('overview 按支撑数降序，并带上状态', () => {
  const rows = overview([E('a', 'p1'), E('b', 'p1'), E('c', 'p2')], { p2: { status: '弃用', reason: 'x' } });
  assert.equal(rows[0].uri, 'p1');
  assert.equal(rows[0].count, 2);
  assert.equal(rows[1].status, '弃用');
  assert.equal(rows[1].blocking, true);
});

test('impactOf：说清弃用会波及哪几条、还剩多少能用', () => {
  const entries = [E('a', 'p1'), E('b', 'p1'), E('c', 'p2')];
  const im = impactOf(entries, {}, 'p1');
  assert.equal(im.affectedCount, 2);
  assert.equal(im.remainingCitable, 1);
  assert.equal(im.orphaned, false);
});

test('impactOf：最后一个可用来源被弃用时，orphaned 为真', () => {
  const im = impactOf([E('a', 'p1')], {}, 'p1');
  assert.equal(im.orphaned, true, '这是必须警告的情况');
});

test('登记表能写能读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-src-'));
  await writeSources(root, { p1: { status: '可疑', reason: '待核' } });
  const back = await readSources(root);
  assert.equal(back.p1.status, '可疑');
  assert.match(await readFile(join(root, '.sources.json'), 'utf8'), /待核/);
});

test('登记表坏掉时当作空表，不让整个库不可用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-src2-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.sources.json'), '{坏掉的 json', 'utf8');
  assert.deepEqual(await readSources(root), {});
});
