import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, replay, toRecords } from '../src/interrupt.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const cand = (over = {}) => ({
  key: 'k1',
  level: '失真',
  cost: 'high',
  reversible: true,
  action: '改成按时间切分',
  ...over,
});

const at = (n) => (d) => d.key === n;

test('没有下一步动作 -> 不说', () => {
  const [d] = decide({ candidates: [cand({ action: '' })], now: NOW });
  assert.equal(d.strength, 'silent');
  assert.deepEqual(d.reasons, ['no_action']);
});

test('说了他也改不了 -> 不说', () => {
  const [d] = decide({ candidates: [cand({ actionable: false })], now: NOW });
  assert.equal(d.strength, 'silent');
  assert.deepEqual(d.reasons, ['cannot_change']);
});

test('纯偏好 -> 不说', () => {
  const [d] = decide({ candidates: [cand({ level: '偏好' })], now: NOW });
  assert.equal(d.strength, 'silent');
  assert.deepEqual(d.reasons, ['preference_only']);
});

test('不可逆 -> 硬停，进正文', () => {
  const [d] = decide({ candidates: [cand({ reversible: false, level: '致命' })], now: NOW });
  assert.equal(d.strength, 'hardstop');
  assert.equal(d.channel, 'body');
  assert.ok(d.reasons.includes('irreversible'));
});

test('代价大 -> 正文说一句', () => {
  const [d] = decide({ candidates: [cand({ cost: 'high' })], now: NOW });
  assert.equal(d.strength, 'inline');
  assert.equal(d.channel, 'body');
});

test('代价小 -> 只记账，不打扰', () => {
  const [d] = decide({ candidates: [cand({ cost: 'low' })], now: NOW });
  assert.equal(d.strength, 'log');
  assert.equal(d.channel, 'none');
});

test('说过且没解决（可逆）-> 不再说', () => {
  const records = [{ ts: NOW.toISOString(), type: 'said', key: 'k1', channel: 'body' }];
  const [d] = decide({ candidates: [cand()], records, now: NOW });
  assert.equal(d.strength, 'silent');
  assert.ok(d.reasons.includes('already_open'));
});

test('说过且没解决（不可逆）-> 不再硬停，但仍留在正文', () => {
  const records = [{ ts: '2026-11-20T12:00:00Z', type: 'said', key: 'k1', channel: 'body' }];
  const [d] = decide({ candidates: [cand({ reversible: false, level: '致命' })], records, now: NOW });
  assert.equal(d.strength, 'inline', '不重复硬停，否则会一直卡住');
  assert.equal(d.channel, 'body', '只放清单等于他看不见');
  assert.ok(d.reasons.includes('kept_in_body'));
});

test('同一批里重复的 key 只认第一条', () => {
  const decisions = decide({
    candidates: [cand({ key: 'dup' }), cand({ key: 'dup' })],
    now: NOW,
  });
  assert.equal(decisions[1].strength, 'silent');
  assert.ok(decisions[1].reasons.includes('duplicate_in_batch'));
});

test('本批已经说出去的，要占当天的配额', () => {
  const decisions = decide({
    candidates: [cand({ key: 'a' }), cand({ key: 'b' }), cand({ key: 'c' })],
    now: NOW,
    policy: { maxPerDay: 2, maxInlinePerTurn: 5 },
  });
  const body = decisions.filter((d) => d.channel === 'body');
  assert.equal(body.length, 2, '配额是 2，本批只该说 2 条');
  const capped = decisions.find((d) => d.key === 'c');
  assert.ok(capped.reasons.includes('daily_cap'));
});

test('冷却期内再提 -> 退到清单', () => {
  const records = [
    { ts: '2026-11-21T10:00:00Z', type: 'said', key: 'k1', channel: 'body' },
    { ts: '2026-11-21T11:00:00Z', type: 'resolved', key: 'k1' },
  ];
  const [d] = decide({ candidates: [cand()], records, now: NOW });
  assert.equal(d.channel, 'list');
  assert.ok(d.reasons.includes('cooldown'));
});

test('日配额用完后 -> 退到清单', () => {
  const records = [
    { ts: '2026-11-21T01:00:00Z', type: 'said', key: 'a', channel: 'body' },
    { ts: '2026-11-21T02:00:00Z', type: 'said', key: 'b', channel: 'body' },
  ];
  const [d] = decide({ candidates: [cand({ key: 'c' })], records, now: NOW });
  assert.equal(d.channel, 'list');
  assert.ok(d.reasons.includes('daily_cap'));
});

test('配额压不掉不可逆', () => {
  const records = [
    { ts: '2026-11-21T01:00:00Z', type: 'said', key: 'a', channel: 'body' },
    { ts: '2026-11-21T02:00:00Z', type: 'said', key: 'b', channel: 'body' },
    { ts: '2026-11-21T03:00:00Z', type: 'said', key: 'c', channel: 'body' },
  ];
  const [d] = decide({ candidates: [cand({ key: 'z', reversible: false, level: '致命' })], records, now: NOW });
  assert.equal(d.strength, 'hardstop');
  assert.equal(d.channel, 'body');
});

test('小事攒够 3 次 -> 升级为正文', () => {
  const records = [1, 2, 3].map((i) => ({
    ts: `2026-11-2${i}T01:00:00Z`, type: 'noted', key: 'k1',
  }));
  const [d] = decide({ candidates: [cand({ cost: 'low', level: '偏离惯例' })], records, now: NOW });
  assert.equal(d.strength, 'inline');
  assert.equal(d.channel, 'body');
  assert.ok(d.reasons.some((r) => r.startsWith('escalated_after')));
});

test('一轮里正文只留最重的一条，其余进清单', () => {
  const decisions = decide({
    candidates: [
      cand({ key: 'light', level: '偏离惯例' }),
      cand({ key: 'heavy', level: '失真' }),
    ],
    now: NOW,
  });
  const body = decisions.filter((d) => d.channel === 'body');
  assert.equal(body.length, 1, '正文只留一条');
  assert.equal(body[0].key, 'heavy', '留下的应当是最重的那条');
  const bumped = decisions.find((d) => d.key === 'light');
  assert.equal(bumped.channel, 'list');
  assert.ok(bumped.reasons.includes('turn_limit'));
});

test('日志写回：说了的记 said，记账的记 noted', () => {
  const decisions = decide({
    candidates: [cand({ key: 'a' }), cand({ key: 'b', cost: 'low' })],
    now: NOW,
  });
  const recs = toRecords(decisions, { project: 'p', now: NOW });
  const byKey = Object.fromEntries(recs.map((r) => [r.key, r.type]));
  assert.equal(byKey.a, 'said');
  assert.equal(byKey.b, 'noted');
});

test('重放：解决之后重新出现，能标出 reopened', () => {
  const records = [
    { ts: '2026-11-21T01:00:00Z', type: 'said', key: 'k1', channel: 'body' },
    { ts: '2026-11-21T02:00:00Z', type: 'resolved', key: 'k1' },
  ];
  const [d] = decide({ candidates: [cand()], records, now: NOW });
  assert.ok(d.reasons.includes('reopened'));
});

test('重放状态：没记录时是 never', () => {
  const s = replay([]);
  assert.equal(s.size, 0);
});

test('被一轮上限挤到清单的，下一轮还能进正文（清单不等于说过）', () => {
  const first = decide({
    candidates: [cand({ key: 'heavy', level: '失真' }), cand({ key: 'light', level: '偏离惯例' })],
    now: NOW,
  });
  const recs = toRecords(first, { project: 'p', now: NOW });
  // light 这一轮只在清单里
  assert.equal(recs.find((r) => r.key === 'light').type, 'listed');

  const next = decide({
    candidates: [cand({ key: 'light', level: '偏离惯例' })],
    records: recs,
    now: new Date('2026-11-21T13:00:00Z'),
  });
  assert.equal(next[0].channel, 'body', '上一轮只在清单里，这一轮该说了');
});

test('正文说过之后才算说过，下一轮不再重复', () => {
  const first = decide({ candidates: [cand({ key: 'a' })], now: NOW });
  const recs = toRecords(first, { project: 'p', now: NOW });
  assert.equal(recs[0].type, 'said');

  const next = decide({
    candidates: [cand({ key: 'a' })],
    records: recs,
    now: new Date('2026-11-21T13:00:00Z'),
  });
  assert.equal(next[0].strength, 'silent');
});

test('不写 reversible 当作不可逆——缺省要朝安全方向偏', () => {
  const [d] = decide({
    candidates: [{ key: 'x', level: '致命', cost: 'high', action: '先备份再删' }],
    now: NOW,
  });
  assert.equal(d.strength, 'hardstop');
  assert.ok(d.reasons.includes('irreversible_assumed'), '要标出这是「假设」而不是作者明说');
});

test('显式写 reversible: true 才当可逆', () => {
  const [d] = decide({ candidates: [cand({ reversible: true })], now: NOW });
  assert.equal(d.strength, 'inline');
  assert.ok(!d.reasons.includes('irreversible_assumed'));
});

test('日配额不会把「记账」推成「进清单」（那是把不打扰变成打扰）', () => {
  const records = [
    { ts: '2026-11-21T01:00:00Z', type: 'said', key: 'a', channel: 'body' },
    { ts: '2026-11-21T02:00:00Z', type: 'said', key: 'b', channel: 'body' },
  ];
  const [d] = decide({
    candidates: [cand({ key: 'minor', cost: 'low' })],
    records,
    now: NOW,
  });
  assert.equal(d.strength, 'log');
  assert.equal(d.channel, 'none');
});

test('冷却也不会把「记账」推成「进清单」', () => {
  const records = [
    { ts: '2026-11-21T11:30:00Z', type: 'said', key: 'minor', channel: 'body' },
    { ts: '2026-11-21T11:45:00Z', type: 'resolved', key: 'minor' },
  ];
  const [d] = decide({ candidates: [cand({ key: 'minor', cost: 'low' })], records, now: NOW });
  assert.equal(d.strength, 'log');
});
