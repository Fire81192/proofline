/**
 * 依据三档（basis）。
 *
 * 这个字段的用途只有一个：让「想出来的」也能入库，同时保证它永远不能
 * 被当成依据。所以这组测试守两件事——
 *
 *   1. 三档各自的准入条件不能松（松一格，判断档就变成随便写的后门）
 *   2. 判断档永远 decisive = false（哪怕它 layer 是标准、世界维度有结论）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntry, readerOf, SNAPSHOT } from './helpers.js';
import { validateEntry } from '../src/core/validate.js';
import { deriveStatus } from '../src/core/status.js';
import { sha256 } from '../src/core/snapshot.js';

const ID = '2026-11-21-xml-tag-prompt';

function check(text) {
  return validateEntry({ dirName: ID, text, snapshotText: SNAPSHOT, readSnapshot: readerOf({}), fix: false });
}

function status(text) {
  return deriveStatus({ dirName: ID, text, snapshotText: SNAPSHOT, readSnapshot: readerOf({}) });
}

const GAP = { question: '这条推理该怎么验', action: 'reanalyse', locator: '下一轮跑全量' };

/** 一条合法的判断型条目：没有原文，但有缺口说明打算怎么验。 */
function judged(over = {}) {
  return buildEntry({
    basis: '判断',
    source_sha256: undefined,
    source_extraction: '原文',
    quotes: [],
    evidence_status: 'not_checked',
    gaps: [GAP],
    ...over,
  });
}

// ---------------------------------------------------------------- 准入

test('basis：必填，缺了就拒（不许含糊）', () => {
  const text = buildEntry({ basis: undefined });
  const r = check(text);
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /basis/.test(h)));
});

test('basis：取值只能是三档之一', () => {
  const r = check(buildEntry({ basis: '推理' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /basis 的取值/.test(h)));
});

test('basis=判断：没有原文也能入库，前提是有 gaps', () => {
  const r = check(judged());
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('basis=判断：没有 gaps 就拒——说不出怎么验的推理只是猜测', () => {
  const r = check(judged({ gaps: [] }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /gaps/.test(h)));
});

test('basis=判断：不许声称来源支持这个结论', () => {
  const r = check(judged({ evidence_status: 'supported' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /not_checked/.test(h)));
});

test('basis=判断：不许同时挂实测——跑过了就算实测', () => {
  const r = check(judged({ runs: [{ script: 'a.py' }] }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /basis: 实测/.test(h)));
});

test('basis=实测：没有 runs 就拒', () => {
  const r = check(buildEntry({ basis: '实测' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /runs/.test(h)));
});

test('basis=条目：必须有原文快照', () => {
  const r = check(buildEntry({ basis: '条目', source_sha256: undefined, quotes: [], evidence_status: 'not_checked' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /读来的/.test(h)));
});

// ---------------------------------------------------------------- 用途限制

test('status：判断档在标准层也是 decisive = false', () => {
  const s = status(judged({ layer: '标准' }));
  assert.equal(s.basis, '判断');
  assert.equal(s.decisive, false);
  assert.equal(s.usable_as_basis, false);
});

test('status：判断档不可引用——不能拿它说「某处这么说过」', () => {
  const s = status(judged());
  assert.equal(s.citable, false);
});

test('status：basis 透传到派生视图，视图才能显示它', () => {
  assert.equal(status(buildEntry({ basis: '条目' })).basis, '条目');
  assert.equal(status(judged()).basis, '判断');
});

test('status：旧条目没有 basis，派生视图给 null 而不是猜一个', () => {
  const s = status(buildEntry({ basis: undefined }));
  assert.equal(s.basis, null);
});

// ---------------------------------------------------------------- 读时也要守

test('status：手改 evidence_status 也改不掉判断档的限制', () => {
  // 回归测试：validate 会拒，但「状态不存、读时算」意味着手改文件正是要防的场景。
  // 早先只在写闸门守，读时会把判断档标成「能引用」。
  // 攻击形态：判断档 + 手改 evidence 为 supported + 配上合法快照与引文。
  const s = status(judged({
    evidence_status: 'supported',
    source_sha256: sha256(SNAPSHOT),
    quotes: ['Claude 对 XML 标签很敏感。'],
  }));
  assert.equal(s.evidence_effective, 'not_checked');
  assert.equal(s.citable, false);
  assert.ok(s.reasons.some((r) => r.code === 'judged_basis_supported'));
});
