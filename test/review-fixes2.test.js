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
