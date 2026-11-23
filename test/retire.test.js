import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { joinFrontmatter, parseFrontmatter } from '../src/core/frontmatter.js';
import { KEY_ORDER, retiredOf } from '../src/core/schema.js';
import { deriveStatus } from '../src/core/status.js';
import { validateEntry } from '../src/core/validate.js';
import { groupByTopic } from '../src/topics.js';
import { seedTrace } from './helpers.js';

/**
 * 条目退役。
 *
 * 它解决的是一个具体麻烦：一条条目记错了、或者只是当时试试，怎么办？
 * 删掉 —— 历史没了，别人的 prereq 断了，而且 rm 绕过所有闸门。
 * 改 claim —— 错被抹掉，之后没人知道你错过。
 *
 * 退役是第三条路：留着原文，摘掉可用性，可撤销。
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

const SNAPSHOT = 'hello world';

async function addEntry(root, id, overrides = {}) {
  const dir = join(root, id);
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  const data = {
    schema: 1,
    id,
    claim: '这是一条测试用的主张，够长了',
    kind: '方法',
    layer: '标准',
    basis: '条目',
    source_kind: '文章',
    source_extraction: '原文',
    source_sha256: sha256(SNAPSHOT),
    evidence_status: 'supported',
    world_status: 'resolved_placeholder',
    quotes: ['hello world'],
    added_at: '2026-11-21',
    ...overrides,
  };
  if (!['resolved_placeholder'].includes(data.world_status)) {
    // 保留调用方给的合法值
  } else {
    data.world_status = 'unresolved';
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  await writeFile(join(dir, 'entry.md'), joinFrontmatter(data, '', KEY_ORDER), 'utf8');
  // 手写库也算「工具建出来的库」：不补这笔，条目标未受控，check 退出码变 1。
  await seedTrace(root, dir, id);
  return dir;
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pl-retire-'));
  const root = join(dir, 'entries');
  await mkdir(root, { recursive: true });
  return { dir, root };
}

/** 直接从磁盘读出来跑派生，绕过 CLI 的输出格式。 */
async function statusOf(root, id) {
  const text = await readFile(join(root, id, 'entry.md'), 'utf8');
  const snapshotText = await readFile(join(root, id, 'raw', 'source.txt'), 'utf8').catch(() => null);
  return deriveStatus({ dirName: id, text, snapshotText, readSnapshot: () => null });
}

// ---------------------------------------------------------------- 不确认就不写

test('retire：不给 --confirm 一个字都不写', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const before = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');

  const r = run(['retire', '2026-11-21-a', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有改动任何东西/);
  assert.equal(await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8'), before);
});

test('retire：预览里要说清「之后不能引用」和「条目还在」', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', root]);
  assert.match(r.stdout, /能引用\s+否/);
  assert.match(r.stdout, /留在库里/);
});

// ---------------------------------------------------------------- 给了确认，还缺理由

test('retire：--confirm 但没有 --reason 仍然拒', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', '--confirm', root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /必须给理由/);
});

test('retire：理由太短也算没给理由', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', '--confirm', '--reason', '不对', root]);
  assert.equal(r.code, 2);
});

// ---------------------------------------------------------------- 正常退役

test('retire：退役后不可引用、不可判定，但条目还在', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', '--confirm', '--reason', '当时记错了口径，后来重读原文发现说过头了', root]);
  assert.equal(r.code, 0, r.stdout);

  const s = await statusOf(root, '2026-11-21-a');
  assert.equal(s.retired, true);
  assert.equal(s.citable, false);
  assert.equal(s.decisive, false);
  // 退役不进 reasons。
  // 第一版 push 了一个 dimension=evidence 的 entry_retired，于是 status 出现
  // 「来源维度 supported -> supported」紧跟「为什么降级」的自相矛盾。
  // 退役是独立状态，理由在 s.deprecated 里。
  assert.equal(s.reasons.some((x) => x.code === 'entry_retired'), false);
  assert.equal(s.deprecated.reason.includes('记错了口径'), true);
});

test('retire：退役**不改** evidence_effective——原文说过就是说过', async () => {
  // 这是这个功能最容易写错的地方：把「不用了」写成「证据失效了」，
  // 于是有人去补一份新证据来修一个本来不需要修的东西。
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', '这条不再用了，但原文确实是这么说的', root]);

  const s = await statusOf(root, '2026-11-21-a');
  assert.equal(s.evidence_effective, 'supported');
  assert.equal(s.evidence_status, 'supported');
  assert.equal(s.downgraded, false);
});

test('retire：退役的条目仍然能通过 check（它不是坏数据）', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', '不再使用这条，理由是外推过头了', root]);

  const r = run(['check', root]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /pass=1/);
});

// ---------------------------------------------------------------- 撤销

test('retire --undo：撤销后重新可用，且字段被彻底移除', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', '先退役，随后撤销，验证来回都通', root]);
  const r = run(['retire', '2026-11-21-a', '--undo', root]);
  assert.equal(r.code, 0, r.stdout);

  const s = await statusOf(root, '2026-11-21-a');
  assert.equal(s.retired, false);
  assert.equal(s.citable, true);
  assert.equal(s.deprecated, null);

  const text = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');
  assert.equal('deprecated' in parseFrontmatter(text).data, false);
});

test('retire --undo：本来就退役过的条目，撤销是幂等的', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', '--undo', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /本来就没退役/);
});

test('retire：已经退役的再退役一次，不覆盖原记录', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', '第一次的理由，八十字以上不需要', root]);
  const r = run(['retire', '2026-11-21-a', '--confirm', '--reason', '第二次的理由，不该覆盖第一次的', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /已经退役/);

  const text = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');
  assert.match(parseFrontmatter(text).data.deprecated.reason, /第一次/);
});

// ---------------------------------------------------------------- 结构校验

test('validate：deprecated 缺 at / 缺 reason 都是 hard_fail', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { deprecated: { reason: '只有理由没有日期，不够' } });
  const text = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');
  const v = validateEntry({ dirName: '2026-11-21-a', text, snapshotText: SNAPSHOT, readSnapshot: () => null, fix: false });
  assert.equal(v.status, 'hard_fail');
  assert.ok(v.hardFails.some((h) => /deprecated\.at/.test(h)));
});

test('validate：deprecated 有来路不明的键就拒——结构不是注释位', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', {
    deprecated: { at: '2026-11-22', reason: '理由够长了，但这个对象多了个键', note: '随手加的' },
  });
  const text = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');
  const v = validateEntry({ dirName: '2026-11-21-a', text, snapshotText: SNAPSHOT, readSnapshot: () => null, fix: false });
  assert.equal(v.status, 'hard_fail');
  assert.ok(v.hardFails.some((h) => /来路不明的键/.test(h)));
});

test('validate：superseded_by 指向自己是循环，拒', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', {
    deprecated: { at: '2026-11-22', reason: '被自己取代，这是逻辑错误', superseded_by: '2026-11-21-a' },
  });
  const text = await readFile(join(root, '2026-11-21-a', 'entry.md'), 'utf8');
  const v = validateEntry({ dirName: '2026-11-21-a', text, snapshotText: SNAPSHOT, readSnapshot: () => null, fix: false });
  assert.equal(v.status, 'hard_fail');
  assert.ok(v.hardFails.some((h) => /指向自己/.test(h)));
});

// ---------------------------------------------------------------- 接替者

test('retire --by：接替者必须是真实存在的条目', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['retire', '2026-11-21-a', '--confirm', '--reason', '换一条新的说法，但新的还没建', '--by', '2026-11-21-b', root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /不存在/);
});

test('retire --by：接替者存在时记进条目，status 里能看到', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  await addEntry(root, '2026-11-21-b');
  const r = run(['retire', '2026-11-21-a', '--confirm', '--reason', '说法被新版取代，详见接替者', '--by', '2026-11-21-b', root]);
  assert.equal(r.code, 0, r.stdout);

  const s = run(['status', '2026-11-21-a', root]);
  assert.match(s.stdout, /由谁接替\s+2026-11-21-b/);
});

// ---------------------------------------------------------------- 跨条目

test('check：前置指向已退役条目时会报出来（但不判废）', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  await addEntry(root, '2026-11-21-b', { prereq: ['2026-11-21-a'] });
  run(['retire', '2026-11-21-a', '--confirm', '--reason', '退役之后要能看见谁还依赖它', root]);

  const r = run(['check', root]);
  assert.equal(r.code, 0, '引用断链不是形状错误，不该让 check 失败');
  assert.match(r.stdout, /前置指向已退役的条目/);
  assert.match(r.stdout, /2026-11-21-b\s+→\s+2026-11-21-a/);
});

test('check：没有退役条目时不出现那一段（不制造空提示）', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['check', root]);
  assert.equal(/前置指向已退役/.test(r.stdout), false);
});

// ---------------------------------------------------------------- 话题旗子

test('topics：退役条目不制造「可用性不一」', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: true, decisive: false, retired: false, source: 's' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: false, decisive: false, retired: true, source: 's' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});

test('topics：全组退役 -> 挂「全组已退役」，不是「可用性不一」', () => {
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: false, decisive: false, retired: true, source: 's' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '条目', evidence: 'supported', world: 'unresolved', citable: false, decisive: false, retired: true, source: 's' },
  ]);
  assert.deepEqual(groups[0].flags, ['全组已退役']);
});

test('topics：全组都是判断档不等于全组退役', () => {
  // 这两个场景的 comparable 都是 0，但说的不是一回事。
  // 混为一谈就是谎报。
  const { groups } = groupByTopic([
    { id: 'a', claim: '甲', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, retired: false, source: '' },
    { id: 'b', claim: '乙', topic: 't', layer: '标准', basis: '判断', evidence: 'not_checked', world: 'unresolved', citable: false, decisive: false, retired: false, source: '' },
  ]);
  assert.deepEqual(groups[0].flags, []);
});

// ---------------------------------------------------------------- 来源统计

test('retiredOf：字段写了就是退役，写残了也算——坏数据只能更不可用', () => {
  // 这条的方向是「宁可错杀」。第一版反过来（写残了算没退役），后果是：
  // 一条想退役却手写残了的条目，会继续可引用。那是「失败路径静默通过」。
  const ok = retiredOf({ deprecated: { at: '2026-11-22', reason: '理由够长的一段文字' } });
  assert.equal(ok.invalid, false);
  assert.equal(ok.at, '2026-11-22');

  for (const broken of [{}, [], { at: '2026-11-22' }, { reason: '只有理由' }, '2026-11-22', ['x'], 0, false]) {
    const r = retiredOf({ deprecated: broken });
    assert.notEqual(r, null, `deprecated=${JSON.stringify(broken)} 应该算退役`);
    assert.equal(r.invalid, true, `deprecated=${JSON.stringify(broken)} 应该标成残缺`);
  }

  // null 和「字段不存在」一个意思：JSON 里 null 就是空，不算退役。
  assert.equal(retiredOf({ deprecated: null }), null);
  assert.equal(retiredOf({}), null);
});

// ---------------------------------------------------------------- 接替关系

test('check：接替者自己也退役了，要说出来', async () => {
  // 「A 由 B 接替」是给人指路的。B 自己也退役了，这句话就在骗人。
  // retire --by 只在写入那一刻看 B 存不存在，之后的事它不知道。
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  await addEntry(root, '2026-11-21-b');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', 'A 说法被 B 取代，这是第一段理由', '--by', '2026-11-21-b', root]);
  run(['retire', '2026-11-21-b', '--confirm', '--reason', 'B 后来也作废了，这是第二段理由', root]);

  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /接替者自己也退役了/);
});

test('check：两条互相接替要报环', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  await addEntry(root, '2026-11-21-b');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', 'A 由 B 接替，这是第一段理由文字', '--by', '2026-11-21-b', root]);
  run(['retire', '2026-11-21-b', '--confirm', '--reason', 'B 由 A 接替，这是第二段理由文字', '--by', '2026-11-21-a', root]);

  const r = run(['check', root]);
  assert.match(r.stdout, /互相接替/);
});

test('check：接替者不存在时（手改出来的）也要报', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', {
    deprecated: { at: '2026-11-22', reason: '手写了一条指向不存在条目的接替关系', superseded_by: '2026-11-21-ghost' },
  });
  const r = run(['check', root]);
  assert.match(r.stdout, /这个条目不存在/);
});

test('check：接替关系正常时不报（不制造空提示）', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  await addEntry(root, '2026-11-21-b');
  run(['retire', '2026-11-21-a', '--confirm', '--reason', 'A 被 B 取代，B 还在用，这是正常情况', '--by', '2026-11-21-b', root]);
  const r = run(['check', root]);
  assert.equal(/接替关系有问题/.test(r.stdout), false);
});

// ---------------------------------------------------------------- create 入口

test('create：spec 里的 deprecated 要真的写进文件（不能只给 warning）', async () => {
  // 回归测试：createEntry 的字段白名单漏过三次（basis、topic/checks/runs、deprecated）。
  // 每次都是「字段被静默丢弃，只留一条没人看的 warning」。
  const { root } = await workspace();
  const r = run(['new', '2026-11-22-x', '--spec', '-', root]);
  // new 从 stdin 读 spec 不方便，直接用 createEntry
  const { createEntry } = await import('../src/create.js');
  const res = await createEntry({
    root, id: '2026-11-22-y',
    spec: {
      claim: '创建时就带着退役标记的主张，看会不会被丢掉',
      kind: '观点', layer: '标准', basis: '判断',
      evidence_status: 'not_checked', world_status: 'unresolved',
      gaps: [{ question: '怎么验', action: 'reanalyse', locator: '下一步' }],
      deprecated: { at: '2026-11-22', reason: '创建时就退役，用来测字段映射有没有漏' },
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const text = await readFile(join(root, '2026-11-22-y', 'entry.md'), 'utf8');
  assert.match(text, /^deprecated:/m);
  assert.equal(/没有被使用/.test((res.warnings ?? []).join(' ')), false);
});
