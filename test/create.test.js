import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEntry, CREATE_HANDLED, CREATE_SELF_COMPUTED } from '../src/create.js';
import { KEY_ORDER } from '../src/core/schema.js';

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

test('建条目失败时，不留下空目录污染全库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-create-'));
  const res = await createEntry({
    root,
    id: '2026-11-21-bad',
    spec: { claim: '一句话主张够长了吧', kind: '方法', layer: '线索', basis: '条目', source_kind: '文章' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_source');
  assert.equal(await exists(join(root, '2026-11-21-bad')), false, '失败后目录不该存在');
});

test('已存在的条目建失败时，不删别人的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-create2-'));
  const dir = join(root, '2026-11-21-keep');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'entry.md'), '原内容', 'utf8');

  const res = await createEntry({ root, id: '2026-11-21-keep', spec: { claim: '太短' } });
  assert.equal(res.ok, false);
  assert.equal(await exists(dir), true, '原本就存在的目录不能被清掉');
});

const SHA = 'a'.repeat(64);
const baseSpec = {
  claim: '一句话主张够长了吧',
  kind: '方法',
  layer: '线索',
  basis: '条目',
  source_kind: '文章',
  source_extraction: '原文',
  quotes: [],
};

test('id 已存在 -> 直接拒绝，一格都不写（不覆盖别人的快照）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-dup-'));
  const dir = join(root, '2026-11-21-dup');
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), '---\nclaim: 原有条目\n---\n', 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), '原始证据', 'utf8');

  const res = await createEntry({ root, id: '2026-11-21-dup', spec: { ...baseSpec, snapshot_text: '新证据' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'exists');

  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(dir, 'raw', 'source.txt'), 'utf8'), '原始证据', '原快照必须原封不动');
  assert.match(await readFile(join(dir, 'entry.md'), 'utf8'), /原有条目/);
});

test('空目录不算「已有条目」，失败时清理掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-empty-dir-'));
  await mkdir(join(root, '2026-11-21-shell'), { recursive: true }); // 空壳

  const res = await createEntry({ root, id: '2026-11-21-shell', spec: { ...baseSpec } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_source');
  assert.equal(await exists(join(root, '2026-11-21-shell')), false, '空壳应被清掉');
});

test('快照源文件读不到 -> 返回可判定的 code，不留目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-nosrc-'));
  const res = await createEntry({
    root,
    id: '2026-11-21-nosrc',
    spec: { ...baseSpec, snapshot_from: join(root, '不存在.txt') },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'snapshot_unreadable');
  assert.equal(await exists(join(root, '2026-11-21-nosrc')), false);
});

test('spec 里的 corroborations 不会被静默丢掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-corr-'));
  const res = await createEntry({
    root,
    id: '2026-11-21-corr',
    spec: {
      ...baseSpec,
      snapshot_text: '主快照内容',
      quotes: ['主快照内容'],
      world_status: 'supported',
      corroborations: [{ uri: 'https://x', sha256: SHA, snapshot: 'raw/verify-1.txt', quote: 'q' }],
    },
  });
  // 佐证快照不存在，所以应当 hard_fail。
  // 关键差别：错误必须是「佐证快照找不到」，而不是「必须至少给一条 corroborations」——
  // 后者说明佐证被静默丢掉了，作者明明给了。
  assert.equal(res.ok, false);
  assert.equal(res.code, 'hard_fail');
  assert.ok(!res.hardFails.some((h) => h.includes('必须至少给一条 corroborations')), res.hardFails.join('; '));
  assert.ok(res.hardFails.some((h) => h.includes('佐证')), res.hardFails.join('; '));
});

test('spec 里没用上的字段会给出警告', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-unknown-'));
  const res = await createEntry({
    root,
    id: '2026-11-21-u',
    spec: { ...baseSpec, snapshot_text: '内容', typo_field: 1 },
  });
  assert.ok(res.warnings.some((w) => w.includes('typo_field')), JSON.stringify(res.warnings));
});

// ---------------------------------------------------------------- 判断档入口

test('create：判断档可以没有来源（new 入口不该把这条路堵死）', async () => {
  // 回归测试：手写 entry.md 能过校验，用 new 建却被 no_source 拦住，
  // 两个入口对同一件事给出不同答案。
  const root = await mkdtemp(join(tmpdir(), 'proofline-judged-'));
  const r = await createEntry({
    root,
    id: '2026-11-22-judged',
    spec: {
      claim: '这是一条推出来的主张，长度够了',
      kind: '观点',
      layer: '标准',
      basis: '判断',
      evidence_status: 'not_checked',
      world_status: 'unresolved',
      gaps: [{ question: '怎么验', action: 'reanalyse', locator: '下一步', blocking: true, dimension: 'world' }],
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('create：条目档没有来源仍然拒（判断档的口子不能外溢）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proofline-nosource-'));
  const r = await createEntry({
    root,
    id: '2026-11-22-nosrc',
    spec: { claim: '没有来源的条目档主张，长度够了', kind: '方法', layer: '标准', basis: '条目' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_source');
});

// ---------------------------------------------------------------- 字段白名单

test('create：KEY_ORDER 里每个字段都必须被 create 认识（否则会静默丢掉）', () => {
  // 这条测试是在补一个反复犯的错。历史上 createEntry 漏接过三次字段：
  //   basis（加三档依据时）→ topic/checks/runs（加实测时）→ deprecated（加退役时）
  // 每次都是「加了 schema 字段，没加 create 的映射」，字段被静默丢弃，
  // 只留一条 warning。而 warning 没人看。
  //
  // 修法不是「下次记得」，是让测试盯着：漏一个就挂。
  const missing = KEY_ORDER.filter((k) => !CREATE_HANDLED.has(k) && !CREATE_SELF_COMPUTED.has(k));
  assert.deepEqual(missing, [], `这些字段 schema 里有、create 不认识：${missing.join(', ')}`);
});
