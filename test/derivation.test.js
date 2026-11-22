import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus } from '../src/core/status.js';
import { validateEntry } from '../src/core/validate.js';
import { buildEntry, readerOf, SNAPSHOT } from './helpers.js';

/**
 * 推理链。
 *
 * 判断档最容易被当成一坨黑——「反正是推的，都不能用」。但两种判断差得很远：
 *
 *   把三条可引的事实摆在一起，得出「这两句话不在同一条时间线上」
 *   我自己觉得主因是训练量不够
 *
 * 都是判断，都不能直接引用，但分量不同。`derived_from` 就是把这个差别做成结构。
 */

const ID = '2026-11-21-xml-tag-prompt';

function judged(extra = {}) {
  return buildEntry({
    basis: '判断',
    evidence_status: 'not_checked',
    world_status: 'unresolved',
    gaps: [{ question: '怎么验', action: 'reanalyse', locator: '下一步', dimension: 'world' }],
    ...extra,
  });
}

const status = (text, opts = {}) => deriveStatus({
  dirName: ID, text, snapshotText: SNAPSHOT, readSnapshot: readerOf({}), ...opts,
});

// ---------------------------------------------------------------- 只有判断档能写

test('validate：条目档写 derived_from 直接拒——它有原文，不需要「从哪几条推的」', () => {
  const r = validateEntry({
    dirName: ID,
    text: buildEntry({ basis: '条目', derived_from: ['2026-11-20-other'] }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /只在 basis=判断 时有意义/.test(h)));
});

test('validate：实测档也不许写', () => {
  const r = validateEntry({
    dirName: ID,
    text: buildEntry({ basis: '实测', world_status: 'supported', derived_from: ['2026-11-20-other'] }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
});

test('validate：空数组拒——要么删字段，要么写至少一条', () => {
  const r = validateEntry({
    dirName: ID, text: judged({ derived_from: [] }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /空数组/.test(h)));
});

test('validate：指向自己拒', () => {
  const r = validateEntry({
    dirName: ID, text: judged({ derived_from: [ID] }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /指向自己/.test(h)));
});

test('validate：重复 id 拒', () => {
  const r = validateEntry({
    dirName: ID, text: judged({ derived_from: ['2026-11-20-a', '2026-11-20-a'] }),
    snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false,
  });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /重复/.test(h)));
});

// ---------------------------------------------------------------- 推理链计算

test('derivation：没有 derived_from 时为 null（普通判断档，不装样子）', () => {
  assert.equal(status(judged()).derivation, null);
});

test('derivation：没注入 citableOf 时不假装算过', () => {
  const s = status(judged({ derived_from: ['2026-11-20-a', '2026-11-20-b'] }));
  assert.equal(s.derivation.total, 2);
  assert.equal(s.derivation.computed, false);
  assert.equal(s.derivation.complete, false);
});

test('derivation：全部可引用 -> 完整', () => {
  const s = status(judged({ derived_from: ['2026-11-20-a', '2026-11-20-b'] }), {
    citableOf: () => true,
  });
  assert.equal(s.derivation.usable, 2);
  assert.equal(s.derivation.complete, true);
  assert.deepEqual(s.derivation.unknown, []);
});

test('derivation：有一条掉队 -> 不完整，但不说是哪条（那要展开）', () => {
  const map = { '2026-11-20-a': true, '2026-11-20-b': false };
  const s = status(judged({ derived_from: ['2026-11-20-a', '2026-11-20-b'] }), {
    citableOf: (id) => map[id],
  });
  assert.equal(s.derivation.usable, 1);
  assert.equal(s.derivation.total, 2);
  assert.equal(s.derivation.complete, false);
});

test('derivation：指向不存在的条目 -> 记进 unknown', () => {
  const s = status(judged({ derived_from: ['2026-11-20-a', '2026-11-20-ghost'] }), {
    citableOf: (id) => (id === '2026-11-20-a' ? true : null),
  });
  assert.deepEqual(s.derivation.unknown, ['2026-11-20-ghost']);
  assert.equal(s.derivation.complete, false);
});

test('derivation：判断档仍然是判断档——推理链完整也不改 citable', () => {
  // 这是这个功能最容易写错的地方：算出一个「完整」就顺手放行。
  // 推理链完整只说明「推的那几条站得住」，不说明「这个结论是读来的」。
  const s = status(judged({ derived_from: ['2026-11-20-a'] }), { citableOf: () => true });
  assert.equal(s.derivation.complete, true);
  assert.equal(s.citable, false);
  assert.equal(s.decisive, false);
});
