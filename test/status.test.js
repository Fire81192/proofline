import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStatus } from '../src/core/status.js';
import { sha256 } from '../src/core/snapshot.js';
import { buildEntry, buildCorroborated, readerOf, SNAPSHOT, CORROB_TEXT, DEFAULT_ID } from './helpers.js';

const derive = (text, snapshotText = SNAPSHOT) =>
  deriveStatus({ dirName: DEFAULT_ID, text, snapshotText });

test('合规条目不会被降级', () => {
  const s = derive(buildEntry());
  assert.equal(s.evidence_effective, 'supported');
  assert.equal(s.world_effective, 'unresolved');
  assert.equal(s.downgraded, false);
  assert.deepEqual(s.reasons, []);
});

test('快照被改过 -> 来源维度降级为 unresolved', () => {
  const s = derive(buildEntry(), `${SNAPSHOT}\n被人偷偷加了一句。`);
  assert.equal(s.evidence_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'snapshot_changed'));
});

test('快照丢了 -> 来源维度降级', () => {
  const s = derive(buildEntry(), null);
  assert.equal(s.evidence_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'snapshot_missing'));
});

test('引文定位不到 -> 来源维度降级，而且能说清是哪一条', () => {
  const s = derive(buildEntry({ quotes: ['这句在原文里不存在'] }));
  assert.equal(s.evidence_effective, 'unresolved');
  const r = s.reasons.find((x) => x.code === 'quote_not_found');
  assert.ok(r);
  assert.match(r.detail, /第 1 条/);
});

test('world 维度的阻塞缺口不会污染 evidence 维度', () => {
  const s = derive(buildEntry({
    gaps: [{ question: '有没有人独立复现过', action: 'search', blocking: true }],
  }));
  assert.equal(s.evidence_effective, 'supported', '来源确实这么说了，这个结论不该被吃掉');
  assert.equal(s.world_effective, 'unresolved');
  assert.deepEqual(s.blocking_gaps.world, ['有没有人独立复现过']);
  assert.deepEqual(s.blocking_gaps.evidence, []);
});

test('evidence 维度的阻塞缺口只压来源维度', () => {
  const text = buildCorroborated({
    gaps: [{ question: '原文完整版没拿到', action: 'search', blocking: true, dimension: 'evidence' }],
  });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    readSnapshot: readerOf({ 'raw/verify-1.txt': CORROB_TEXT }),
  });
  assert.equal(s.evidence_effective, 'unresolved');
  assert.equal(s.world_effective, 'supported', '世界层面的结论仍然保留');
});

test('blocking:false 的缺口不压任何维度', () => {
  const text = buildCorroborated({
    gaps: [{ question: '顺带查一下作者背景', action: 'search', blocking: false }],
  });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    readSnapshot: readerOf({ 'raw/verify-1.txt': CORROB_TEXT }),
  });
  assert.equal(s.evidence_effective, 'supported');
  assert.equal(s.world_effective, 'supported');
});

test('线索层永远不能下判断，标准层两个维度都定了才能', () => {
  const reader = readerOf({ 'raw/verify-1.txt': CORROB_TEXT });
  const d = (text) => deriveStatus({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT, readSnapshot: reader });
  assert.equal(d(buildCorroborated({ layer: '线索' })).decisive, false);
  assert.equal(d(buildCorroborated({ layer: '标准' })).decisive, true);
  assert.equal(d(buildEntry({ layer: '标准', world_status: 'unresolved' })).decisive, false);
});

test('声称世界为真却没有佐证 -> 降级为 unresolved', () => {
  const s = derive(buildEntry({ layer: '标准', world_status: 'supported' }));
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'world_unsubstantiated'));
  assert.equal(s.decisive, false);
});

test('佐证快照被改过 -> 佐证不算数，世界维度降级', () => {
  const text = buildCorroborated();
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    readSnapshot: readerOf({ 'raw/verify-1.txt': `${CORROB_TEXT}（被人加了字）` }),
  });
  assert.equal(s.world_basis, 0);
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'corroboration_changed'));
});

test('参考架构类：能引用但不能下判断——两级必须分开', () => {
  const s = derive(buildEntry({ kind: '参考架构', layer: '标准', world_status: 'unresolved' }));
  assert.equal(s.citable, true, '来源确实这么写过，这条能拿来引用');
  assert.equal(s.decisive, false, '只有一家这么做，还不能据此判别人业余');
});

test('not_checked 不算结论，不会因为「没查」就变成可引用', () => {
  const s = derive(buildEntry({
    source_sha256: undefined, quotes: [], evidence_status: 'not_checked', layer: '标准', world_status: 'supported',
  }));
  assert.equal(s.citable, false);
  assert.equal(s.decisive, false);
  assert.equal(s.evidence_effective, 'unresolved');
});

const deriveWithBoxes = (text, boxes) =>
  deriveStatus({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT, boxes });

test('没有 boxes.json 时 original_verified 是 null，不是 false', () => {
  const s = derive(buildEntry());
  assert.equal(s.original_verified, null);
  assert.deepEqual(s.locations, []);
});

test('原件里全部命中 -> original_verified 为 true，并带出页码和框', () => {
  const quote = 'Claude 对 XML 标签很敏感。';
  const s = deriveWithBoxes(buildEntry(), {
    pdf: 'x.pdf',
    boxes: [{ quote, found: { page: 3, page_count: 12, bbox: { x0: 1, top: 2, x1: 3, bottom: 4 }, lines_spanned: 1 } }],
  });
  assert.equal(s.original_verified, true);
  assert.equal(s.locations.length, 1);
  assert.equal(s.locations[0].page, 3);
  assert.deepEqual(s.locations[0].bbox, { x0: 1, top: 2, x1: 3, bottom: 4 });
});

test('原件里找不到这句 -> original_verified 为 false，但不改两个 verdict', () => {
  const s = deriveWithBoxes(buildEntry(), {
    pdf: 'x.pdf',
    boxes: [{ quote: '完全不相干的另一句话', found: { page: 1, page_count: 1, bbox: null, lines_spanned: 1 } }],
  });
  assert.equal(s.original_verified, false);
  assert.ok(s.reasons.some((r) => r.code === 'box_missing'));
  assert.equal(s.evidence_effective, 'supported', '快照里确实有这句，来源维度不该被原件问题拉下来');
});

test('没有 source_sha256 -> 来源维度降级（没核不等于核过）', () => {
  const text = buildEntry({ source_sha256: undefined, evidence_status: 'supported' });
  const s = deriveStatus({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT });
  assert.equal(s.evidence_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'snapshot_unhashed'));
  assert.equal(s.citable, false);
});

test('佐证缺 sha256 -> 不算数，世界维度降级', () => {
  const text = buildEntry({
    world_status: 'supported',
    corroborations: [{ uri: 'https://x', snapshot: 'raw/verify-1.txt', quote: '随便' }],
  });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    readSnapshot: () => '随便',
  });
  assert.equal(s.world_basis, 0);
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'corroboration_unhashed'));
});

test('佐证缺 quote -> 不算数', () => {
  const snap = '随便';
  const text = buildEntry({
    world_status: 'supported',
    corroborations: [{ uri: 'https://x', snapshot: 'raw/verify-1.txt', sha256: sha256(snap) }],
  });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    readSnapshot: () => snap,
  });
  assert.equal(s.world_basis, 0);
  assert.ok(s.reasons.some((r) => r.code === 'corroboration_no_quote'));
});

test('contradicted 无佐证也不能下判断（两个方向都要证据）', () => {
  const s = deriveStatus({ dirName: DEFAULT_ID, text: buildEntry({ layer: '标准', world_status: 'contradicted' }), snapshotText: SNAPSHOT });
  assert.equal(s.world_effective, 'unresolved');
  assert.equal(s.decisive, false);
});

test('来源被标为弃用 -> 来源维度降级，且不覆盖人写的判定', () => {
  const text = buildEntry({ evidence_status: 'supported' });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT,
    sourceStatus: { status: '弃用', reason: '期刊勘误过', blocking: true },
  });
  assert.equal(s.evidence_effective, 'unresolved');
  assert.equal(s.citable, false);
  assert.equal(s.evidence_status, 'supported', '存着的判定不能被改，只能读时压下来');
  assert.ok(s.reasons.some((r) => r.code === 'source_blocked'));
});

test('来源可疑也降级，理由里带原始原因', () => {
  const s = deriveStatus({
    dirName: DEFAULT_ID, text: buildEntry(), snapshotText: SNAPSHOT,
    sourceStatus: { status: '可疑', reason: '还没核到原刊', blocking: true },
  });
  const r = s.reasons.find((x) => x.code === 'source_blocked');
  assert.ok(r);
  assert.match(r.detail, /还没核到原刊/);
});

test('能下判断但没写边界 -> 不判 decisive，且记下原因', () => {
  // 这条测的是新加的判据：not_for 不是格式要求，是可用性要求。
  // 一条能当依据去否定别人、却没说「不能被用来干什么」的主张，不该放行。
  const reader = readerOf({ 'raw/verify-1.txt': CORROB_TEXT });
  const text = buildCorroborated({ layer: '标准', not_for: null });
  const s = deriveStatus({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT, readSnapshot: reader });
  assert.equal(s.decisive, false);
  assert.equal(s.boundary_missing, true);
  assert.deepEqual(s.not_for, []);
});

test('写了边界 -> 恢复 decisive', () => {
  const reader = readerOf({ 'raw/verify-1.txt': CORROB_TEXT });
  const s = deriveStatus({
    dirName: DEFAULT_ID, text: buildCorroborated({ layer: '标准' }),
    snapshotText: SNAPSHOT, readSnapshot: reader,
  });
  assert.equal(s.decisive, true);
  assert.equal(s.boundary_missing, false);
});
