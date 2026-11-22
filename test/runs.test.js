/**
 * 实测复跑（runs）。
 *
 * 这一组测试守的不是「字段能不能存」，而是**一个过期结论会不会被自动收拾**。
 * 脚本改过、输出改过、期望值对不上——三种情况都必须让 world 维度掉下来，
 * 而且必须是读时掉，不能靠人记得去改字段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntry, readerOf, SNAPSHOT } from './helpers.js';
import { validateEntry } from '../src/core/validate.js';
import { deriveStatus } from '../src/core/status.js';
import { sha256 } from '../src/core/snapshot.js';

const SCRIPT = 'import pandas as pd\nprint("run")\n';
const OUT_TEXT = 'n_val=500\nmae_mmHg=18.9253\nmae_const_mmHg=19.5892\n';
const SCRIPT_REL = '复现/train.py';

function buildRun(over = {}) {
  return {
    script: SCRIPT_REL,
    script_sha256: sha256(SCRIPT),
    cmd: 'python train.py',
    output: 'raw/run-1.txt',
    output_sha256: sha256(OUT_TEXT),
    expect: { mae_mmHg: '18.9253', mae_const_mmHg: '19.5892' },
    at: '2026-11-22',
    env: 'Python 3.12',
    ...over,
  };
}

function readers({ run = {}, snapshots = {}, scripts = {} } = {}) {
  return {
    readSnapshot: readerOf({ 'raw/run-1.txt': OUT_TEXT, ...snapshots }),
    readRunScript: readerOf({ [SCRIPT_REL]: SCRIPT, ...scripts }),
  };
}

function build({ run = {}, entry = {} } = {}) {
  // 合并后把 null 当作「这条故意不要这个键」删掉。
  // 不能靠「传一个没有 expect 的对象」来表达缺失——展开运算不会删键，
  // 默认值会留下来，于是测试测的就不是它以为在测的东西。
  const merged = { ...buildRun(), ...run };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  // 标准层 + 来源支持 + 世界有结论 = 声明上能下判断，按新规则必须写 not_for。
  // 这是夹具不是被测对象，给一句就够。
  return buildEntry({
    world_status: 'supported', layer: '标准', basis: '实测',
    not_for: ['不能说这个模型已经训练好了——只是两条记录对上了'],
    runs: [merged], ...entry,
  });
}

function check(text, opts = {}) {
  return validateEntry({
    dirName: '2026-11-21-xml-tag-prompt',
    text,
    snapshotText: SNAPSHOT,
    ...readers(opts),
    fix: false,
  });
}

function status(text, opts = {}) {
  return deriveStatus({
    dirName: '2026-11-21-xml-tag-prompt',
    text,
    snapshotText: SNAPSHOT,
    ...readers(opts),
  });
}

// ---------------------------------------------------------------- validate

test('runs：合法的一条实测能入库', () => {
  const r = check(build());
  assert.notEqual(r.status, 'hard_fail', JSON.stringify(r.hardFails));
});

test('runs：缺 expect 直接拒——没有期望值的实测没法核', () => {
  const r = check(build({ run: { expect: null } }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /缺 expect/.test(h)));
});

test('runs：expect 写成数字就拒（必须是字符串，保持字面一致）', () => {
  const r = check(build({ run: { expect: { mae_mmHg: 18.9253 } } }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /必须是字符串/.test(h)));
});

test('runs：expect 的值在输出里找不到就拒——这是整个机制的核心', () => {
  const r = check(build({ run: { expect: { mae_mmHg: '10.5' } } }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /在输出快照里找不到/.test(h)));
});

test('runs：输出快照不在就拒，不许静默放行', () => {
  const run = buildRun({ output: 'raw/nope.txt' });
  const r = check(build({ run }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /输出快照找不到/.test(h)));
});

test('runs：输出哈希对不上就拒', () => {
  const run = buildRun({ output_sha256: sha256('别的内容') });
  const r = check(build({ run }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /输出快照哈希对不上/.test(h)));
});

test('runs：script 路径带 .. 就拒（脚本必须在 workspace 内）', () => {
  const r = check(build({ run: { script: '../../etc/passwd' } }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /script 路径不安全/.test(h)));
});

test('runs：output 用盘符路径就拒', () => {
  const r = check(build({ run: { output: 'C:/tmp/x.txt' } }));  // audit-ignore 假盘符路径，测拒绝
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /output 路径不安全/.test(h)));
});

test('runs：at 不是真实日期就拒', () => {
  const r = check(build({ run: { at: '2026-13-45' } }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /不是真实存在的日期/.test(h)));
});

test('runs：有 runs 就允许把 world_status 写成 supported', () => {
  const r = check(build());
  assert.notEqual(r.status, 'hard_fail');
});

test('runs：既无佐证也无实测，写 supported 仍然被拒', () => {
  const r = check(buildEntry({ world_status: 'supported' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => /corroborations/.test(h) && /runs/.test(h)));
});

// ---------------------------------------------------------------- status

test('status：脚本、输出、期望全对得上，world 才算数', () => {
  const s = status(build());
  assert.equal(s.world_effective, 'supported');
  assert.deepEqual(s.world_basis_detail, { corroborations: 0, runs: 1 });
  assert.equal(s.decisive, true);
});

test('status：脚本改过，实测立刻失效并说明原因', () => {
  const s = status(build(), { scripts: { [SCRIPT_REL]: `${SCRIPT}# 改动\n` } });
  assert.equal(s.world_effective, 'unresolved');
  assert.equal(s.world_basis_detail.runs, 0);
  assert.ok(s.reasons.some((r) => r.code === 'run_script_changed'));
});

test('status：输出快照被改过，实测失效', () => {
  const s = status(build(), { snapshots: { 'raw/run-1.txt': 'mae_mmHg=1\n' } });
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'run_output_changed'));
});

test('status：期望值后来在输出里找不到了，实测失效', () => {
  // 输出和哈希都对得上，只有 expect 被改成了输出里没有的值。
  // 这是「手工改了条目」的场景：validate 在入库时会拦，
  // 但读时这一层也必须守得住——否则改过的 entry.md 能悄悄通过。
  const s = status(build({ run: { expect: { mae_mmHg: '99.9-not-there' } } }));
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'run_expect_missing'));
});

test('status：脚本文件被删了，实测失效而不是崩', () => {
  const s = status(build(), { scripts: { [SCRIPT_REL]: undefined } });
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'run_script_missing'));
});

test('status：没提供脚本读取器时按「无法核验」处理，不是当作通过', () => {
  const s = deriveStatus({
    dirName: '2026-11-21-xml-tag-prompt',
    text: build(),
    snapshotText: SNAPSHOT,
    readSnapshot: readerOf({ 'raw/run-1.txt': OUT_TEXT }),
  });
  assert.equal(s.world_effective, 'unresolved');
  assert.ok(s.reasons.some((r) => r.code === 'run_unverifiable'));
});

test('status：两条实测一好一坏，只有好的那条算依据', () => {
  const good = buildRun();
  const bad = buildRun({ output: 'raw/run-2.txt' });
  const text = buildEntry({ world_status: 'supported', runs: [good, bad] });
  const s = deriveStatus({
    dirName: '2026-11-21-xml-tag-prompt',
    text,
    snapshotText: SNAPSHOT,
    readSnapshot: readerOf({ 'raw/run-1.txt': OUT_TEXT }),
    readRunScript: readerOf({ [SCRIPT_REL]: SCRIPT }),
  });
  assert.equal(s.world_basis_detail.runs, 1);
  assert.equal(s.world_effective, 'supported');
});
