import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendTrace, readTrace, verifyChain, readHead, verifyHead, lineHash } from '../src/core/trace.js';
import { deriveStatus } from '../src/core/status.js';
import { validateEntry } from '../src/core/validate.js';
import { sha256 } from '../src/core/snapshot.js';
import { buildEntry, buildCorroborated, SNAPSHOT, CORROB_TEXT } from './helpers.js';

/**
 * 第二轮修复的回归锁：链头锚、佐证去重、schema 版本、宽松命中可见。
 * 每一条对应一份外部审核里被复现过的洞。
 */

const tmp = () => mkdtemp(join(tmpdir(), 'pl-fix2-'));

test('链头：链本身自洽，但改末行会被抓出来', async () => {
  const root = await tmp();
  await appendTrace(root, { op: 'create', id: 'a', after: 'hash-a' });
  await appendTrace(root, { op: 'set', id: 'a', after: 'hash-b' });

  const before = await readTrace(root);
  assert.equal(verifyChain(before.lines).ok, true);
  assert.equal(verifyHead(await readHead(root), before.lines).ok, true);

  // 只改末行：prev 全部自洽，链校验看不出来
  const lines = before.lines.slice();
  lines[lines.length - 1] = { ...lines[lines.length - 1], after: 'forged' };
  assert.equal(verifyChain(lines).ok, true, '链本身还是自洽的——这正是问题');

  const chk = verifyHead(await readHead(root), lines);
  assert.equal(chk.ok, false);
  assert.equal(chk.kind, 'tail');
});

test('链头：往末尾追加一条 prev 正确的伪造记录，行数对不上', async () => {
  const root = await tmp();
  await appendTrace(root, { op: 'create', id: 'a', after: 'hash-a' });

  const { lines } = await readTrace(root);
  const forged = { v: 1, at: '2026-01-01', op: 'set', id: 'a', after: 'x', prev: lineHash(lines[0]) };
  await appendFile(join(root, '.trace.jsonl'), `${JSON.stringify(forged)}\n`, 'utf8');

  const after = await readTrace(root);
  assert.equal(verifyChain(after.lines).ok, true, '追加记录的 prev 是对的，链不断');

  const chk = verifyHead(await readHead(root), after.lines);
  assert.equal(chk.ok, false);
  assert.equal(chk.kind, 'count');
});

test('链头：没有链头文件的老库不判错', async () => {
  const root = await tmp();
  await appendTrace(root, { op: 'create', id: 'a', after: 'h' });
  // 手工删掉链头，模拟老库
  const { unlink } = await import('node:fs/promises');
  await unlink(join(root, '.trace.head'));
  const { lines } = await readTrace(root);
  assert.equal(verifyHead(await readHead(root), lines).kind, 'absent');
  assert.equal(verifyHead(await readHead(root), lines).ok, true);
});

test('佐证：同一份材料写两遍只算一份', () => {
  const c = {
    snapshot: 'raw/verify-1.txt',
    sha256: sha256(CORROB_TEXT),
    quote: CORROB_TEXT.slice(0, 12),
    uri: 'https://example.com',
  };
  const mk = (list) => deriveStatus({
    dirName: '2026-11-22-a',
    text: buildEntry({ id: '2026-11-22-a', corroborations: list, world_status: 'supported' }),
    snapshotText: SNAPSHOT,
    readSnapshot: (rel) => (rel === 'raw/verify-1.txt' ? CORROB_TEXT : null),
  });

  assert.equal(mk([c]).world_basis_detail.corroborations, 1);
  const dup = mk([c, { ...c }]);
  assert.equal(dup.world_basis_detail.corroborations, 1, '不是两份独立来源');
  assert.ok(dup.reasons.some((r) => r.code === 'corroboration_duplicate'));
});

test('schema：不认识的版本不许当 1 读', () => {
  const setLine = (t, k, v) => t.replace(new RegExp(`^${k}:.*$`, 'm'), `${k}: ${v}`);
  const V = (text) => validateEntry({ dirName: '2026-11-22-a', text, snapshotText: SNAPSHOT, readSnapshot: () => null, fix: false });
  assert.equal(V(setLine(buildEntry({ id: '2026-11-22-a' }), 'schema', '1')).status, 'pass');
  assert.equal(V(setLine(buildEntry({ id: '2026-11-22-a' }), 'schema', '2')).status, 'hard_fail');
});

test('引文：逐字命中记 exact，折叠后才命中记 normalized', () => {
  const d1 = deriveStatus({ dirName: '2026-11-22-a', text: buildEntry({ id: '2026-11-22-a' }), snapshotText: SNAPSHOT });
  assert.equal(d1.reasons.some((r) => r.code === 'quote_normalized'), false, '逐字命中不该报宽松');

  const q = buildEntry({ id: '2026-11-22-a' }).replace(/^quotes:.*$/m, 'quotes: ["XML  标签"]');
  const d2 = deriveStatus({ dirName: '2026-11-22-a', text: q, snapshotText: SNAPSHOT });
  assert.ok(d2.reasons.some((r) => r.code === 'quote_normalized'), '双空格应当被说出来');
  assert.equal(d2.citable, true, '宽松命中仍然是命中，不降级');
});
