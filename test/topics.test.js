import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupByTopic, flagged } from '../src/topics.js';

const item = (over = {}) => ({
  id: 'x',
  claim: '一句话主张',
  topic: 'ppg.preprocess',
  layer: '标准',
  kind: '方法',
  evidence: 'supported',
  world: 'unresolved',
  citable: true,
  decisive: false,
  source: 'src',
  ...over,
});

test('没写 topic 的进 untagged，不进任何组', () => {
  const r = groupByTopic([item({ id: 'a', topic: null }), item({ id: 'b' })]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.untagged.map((x) => x.id), ['a']);
});

test('同 topic 合成一组，组内按 id 稳定排序', () => {
  const r = groupByTopic([item({ id: 'c' }), item({ id: 'a' }), item({ id: 'b' })]);
  assert.deepEqual(r.groups[0].items.map((x) => x.id), ['a', 'b', 'c']);
});

test('单个条目的组不挂旗子', () => {
  const r = groupByTopic([item()]);
  assert.deepEqual(r.groups[0].flags, []);
});

test('世界维度一个 supported 一个 unresolved -> 结论不一', () => {
  const r = groupByTopic([item({ id: 'a', world: 'supported' }), item({ id: 'b', world: 'unresolved' })]);
  assert.ok(r.groups[0].flags.includes('结论不一'));
});

test('都 unresolved 时不挂「结论不一」（未定不代表矛盾）', () => {
  const r = groupByTopic([item({ id: 'a' }), item({ id: 'b' })]);
  assert.ok(!r.groups[0].flags.includes('结论不一'));
});

test('一条能引用一条不能 -> 可用性不一', () => {
  const r = groupByTopic([item({ id: 'a', citable: true }), item({ id: 'b', citable: false })]);
  assert.ok(r.groups[0].flags.includes('可用性不一'));
});

test('标准与线索混在一起 -> 层级混用', () => {
  const r = groupByTopic([item({ id: 'a', layer: '标准' }), item({ id: 'b', layer: '线索' })]);
  assert.ok(r.groups[0].flags.includes('层级混用'));
});

test('flagged 只挑有旗子的组', () => {
  const r = groupByTopic([
    item({ id: 'a' }), item({ id: 'b' }),
    item({ id: 'c', topic: 'other', layer: '标准' }),
    item({ id: 'd', topic: 'other', layer: '线索' }),
  ]);
  assert.deepEqual(flagged(r.groups).map((g) => g.topic), ['other']);
});

test('话题名两端的空白会被归一（不会被当成两个话题）', () => {
  const r = groupByTopic([item({ id: 'a', topic: ' ppg.x ' }), item({ id: 'b', topic: 'ppg.x' })]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].items.length, 2);
});

// ---------------------------------------------------------------- 判断档

test('判断档不参与「不一致」比较——它的不可引用是设计如此', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: true, decisive: false, source: 's' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});

test('两条都是判断档 -> 无旗子（不是「两条都不能用」这种假不一致）', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, source: '' },
    { id: 'b', claim: '乙', topic: 't', layer: '线索', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});

test('去掉判断档后只剩一条可比的 -> 也不挂旗', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'supported', citable: true, decisive: true, source: 's' },
    { id: 'b', claim: '乙', topic: 't', layer: '线索', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});

// ---------------------------------------------------------------- 无可用依据

test('topics：1 条退役 + 1 条判断档 -> 无可用依据（不是无旗）', () => {
  // 这一组曾经有一条能引用的（那条退役的），现在没了。
  // 只报「全组已退役」会漏掉它——因为还剩一条没退役的判断档。
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: false, decisive: false, retired: true, source: 's' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, retired: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, ['无可用依据']);
});

test('topics：全组都是判断档 -> 仍然不挂旗（从一开始就没有可引用的，是预期状态）', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, retired: false, source: '' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, retired: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});
