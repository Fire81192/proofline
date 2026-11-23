import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

// ---- 第三轮外部审核（DeepSeek）指出的两条「读时防线比写时松」 ----

test('run 的 expect 是数字：不给依据（以前零断言也 runBasis += 1）', () => {
  const SCRIPT = 'print("mae")';
  const OUT = 'mae: 4.02';
  const mk = (expect) => deriveStatus({
    dirName: '2026-11-22-a',
    text: buildEntry({
      id: '2026-11-22-a', basis: '实测', world_status: 'supported',
      runs: [{
        script: 'raw/run.py', script_sha256: sha256(SCRIPT),
        cmd: 'python run.py',
        output: 'raw/out.txt', output_sha256: sha256(OUT),
        expect, at: '2026-11-22', env: 'Python 3.12',
      }],
    }),
    snapshotText: SNAPSHOT,
    readSnapshot: (rel) => (rel === 'raw/out.txt' ? OUT : null),
    readRunScript: (rel) => (rel === 'raw/run.py' ? SCRIPT : null),
  });

  // 正确写法先立个基线
  const good = mk({ mae: '4.02' });
  assert.equal(good.world_basis_detail.runs, 1);

  // 忘加引号：YAML 读成数字。写入会拒，读时也必须拒——
  // 否则这条实测一条断言都没核，却拿到了世界维度的依据。
  const bad = mk({ mae: 4.02 });
  assert.equal(bad.world_basis_detail.runs, 0, '数字期望值不能被静默跳过');
  assert.equal(bad.world_effective, 'unresolved');
  assert.ok(bad.reasons.some((r) => r.code === 'run_expect_uncheckable'));

  // 空字符串同理：核不了
  assert.equal(mk({ mae: '' }).world_basis_detail.runs, 0);
});

test('佐证：同内容换文件名，仍然只算一份', () => {
  const c = {
    snapshot: 'raw/verify-1.txt',
    sha256: sha256(CORROB_TEXT),
    quote: CORROB_TEXT.slice(0, 12),
    uri: 'https://example.com',
  };
  const OTHER_TEXT = '另一份独立材料，讲的是完全不同的事。';
  const mk = (list) => deriveStatus({
    dirName: '2026-11-22-a',
    text: buildEntry({ id: '2026-11-22-a', corroborations: list, world_status: 'supported' }),
    snapshotText: SNAPSHOT,
    readSnapshot: (rel) => {
      if (/^raw\/(verify-1|copy)\.txt$/.test(rel)) return CORROB_TEXT;
      if (rel === 'raw/other.txt') return OTHER_TEXT;
      return null;
    },
  });

  assert.equal(mk([c]).world_basis_detail.corroborations, 1);

  // 同一篇文章存两个文件名：内容是同一份，来源不是两份。
  // 以前去重键里带了 snapshot 路径，改个名字就能骗成两份独立来源。
  const sameContentOtherName = mk([c, { ...c, snapshot: 'raw/copy.txt' }]);
  assert.equal(sameContentOtherName.world_basis_detail.corroborations, 1);
  assert.ok(sameContentOtherName.reasons.some((r) => r.code === 'corroboration_duplicate'));

  // 内容真的不同，仍然是两份
  const other = {
    snapshot: 'raw/other.txt',
    sha256: sha256(OTHER_TEXT),
    quote: OTHER_TEXT.slice(0, 8),
    uri: 'https://another.example.com',
  };
  assert.equal(mk([c, other]).world_basis_detail.corroborations, 2);
});

// ---- GLM 审查抓到的两条：输出口径不一致、手改可被一次工具写入洗白 ----

const CLI2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const cliRun = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI2, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

/** demo 那条沸点条目的原文（虚构材料，和 demo 库一致）。 */
const BOIL = `沸点小记（虚构材料，仅供演示）

标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。
气压降低时沸点随之降低：海拔每升高约 300 米，沸点下降约 1 ℃。`;

/** 建一条「正常入库」的条目：有 entry.md、有快照、有 trace 记录。 */
async function seed(root, id) {
  const { createEntry } = await import('../src/create.js');
  const r = await createEntry({
    root, id,
    spec: {
      claim: '标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃',
      kind: '原理', layer: '标准', basis: '条目', topic: 'demo.boiling',
      source_kind: '其他', source_extraction: '原文',
      source_uri: 'demo://沸点小记',
      snapshot_text: BOIL,
      quotes: ['标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。'],
      evidence_status: 'supported', world_status: 'unresolved',
      added_at: '2026-01-01',
    },
  });
  assert.equal(r.ok, true, `seed 失败：${r.code}`);
  return join(root, id, 'entry.md');
}

test('手改之后：status / index / stats 三个输出口径一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-untracked-'));
  const file = await seed(root, '2026-01-01-a');

  // 改之前：可引用
  assert.match(cliRun(['status', '2026-01-01-a', root]).out, /能引用\s+是/);

  await writeFile(file, (await readFile(file, 'utf8')).replace('沸点是 100 ℃', '沸点是 120 ℃'), 'utf8');

  // status 一票否决
  const st = cliRun(['status', '2026-01-01-a', root]).out;
  assert.match(st, /受控\s+否/);
  assert.match(st, /能引用\s+否/);

  // index 必须跟着否 —— 以前它走 deriveStatus，不知道留痕这回事，照标「可引用」
  cliRun(['index', root]);
  const idx = await readFile(join(root, 'INDEX.md'), 'utf8');
  assert.doesNotMatch(idx, /可引用/, 'index 不能把未受控的条目标成可引用');

  // stats 的可引用数必须是 0
  assert.match(cliRun(['stats', root]).out, /引用\s+0/);
});

test('手改之后跑 set：被拒，不能洗白', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-launder-'));
  const file = await seed(root, '2026-01-01-b');

  await writeFile(file, (await readFile(file, 'utf8')).replace('100 ℃', '120 ℃'), 'utf8');

  // 以前的洗白路径：set 拿「当前文件的哈希」当 expect，自己跟自己比，永远通过
  const r = cliRun(['set', '2026-01-01-b', 'topic', 'demo.x', root]);
  assert.equal(r.code, 1);
  assert.match(r.out, /untracked_change/);
  assert.match(r.out, /trace --adopt/, '报错要说怎么接受现状');

  // 拒了之后状态不能变
  assert.match(cliRun(['status', '2026-01-01-b', root]).out, /受控\s+否/);
});
