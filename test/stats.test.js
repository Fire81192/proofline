import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';
import { appendTrace } from '../src/core/trace.js';
import { contentHash } from '../src/core/store.js';

/**
 * 数字总览。
 *
 * 它存在的原因不是「再做一个统计命令」，而是文档会撒谎：
 * 三份文档分别停在不同时刻，同一件事写着 49 条、24 条、42 条，库里是 43 条。
 * 库变了，手抄的数字不会跟着变——这跟「来源说过」当成「世界为真」是同一个毛病。
 *
 * 所以这个命令的每个数都必须是现算的，且口径和 review / projects 一致。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// 条目 id 必须是「日期-短名」，否则形状不合规，可引用一律为否。
const id = (s) => `2026-11-22-${s}`;

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** 造一个库：每条都写 entry.md 和 raw/source.txt。 */
async function makeLib(base, name, entries) {
  const root = join(base, name, 'entries');
  await mkdir(root, { recursive: true });
  for (const e of entries) {
    const dir = join(root, e.id);
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'entry.md'), buildEntry({ ...e }), 'utf8');
    await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
    // 顺手留一条入库记录。没有 trace 的条目现在是「未受控」——
    // 那是对的做法（从没用过工具的库，所有条目都不该算依据），
    // 但这个测试要的是「正常入库的库」，所以补齐。
    await appendTrace(root, {
      op: 'create', id: e.id,
      after: contentHash(await readFile(join(dir, 'entry.md'), 'utf8')),
    });
  }
  return root;
}

test('stats：多库汇总，条数按库相加', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  await makeLib(ws, 'alpha', [{ id: id('a-1') }, { id: id('a-2') }]);
  await makeLib(ws, 'beta', [{ id: id('b-1') }]);

  const r = run(['stats', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /2 个库 · 3 条/);
  assert.match(r.stdout, /alpha\s+2 条/);
  assert.match(r.stdout, /beta\s+1 条/);
});

test('stats：传 entries 目录时，库名取父目录而不是 entries', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  const root = await makeLib(ws, 'aqi', [{ id: id('x-1') }]);

  const r = run(['stats', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 个库 · 1 条/);
  assert.match(r.stdout, /aqi\s+1 条/);
  assert.doesNotMatch(r.stdout, /entries\s+1 条/);
});

test('stats：依据档分列，实测与判断不能混进条目', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  await makeLib(ws, 'mix', [
    { id: id('m-1') },
    {
      id: id('m-2'),
      basis: '判断',
      source_kind: undefined,
      source_uri: undefined,
      source_published_at: undefined,
      source_available_basis: undefined,
      source_extraction: undefined,
      source_snapshot: undefined,
      source_sha256: undefined,
      quotes: undefined,
      evidence_status: 'inferred',
      world_status: 'unresolved',
      derived_from: [id('m-1')],
      not_for: ['不能当原始数据'],
    },
  ]);

  const r = run(['stats', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /依据\s+条目 1 · 实测 0 · 判断 1/);
});

test('stats：退役的条目还算总数，但不算可引用', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  await makeLib(ws, 'lib', [
    { id: id('r-1') },
    { id: id('r-2'), deprecated: { at: '2026-11-22', reason: '拆成两条了' } },
  ]);

  const r = run(['stats', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /2 条 · 引用\s+1/);
  assert.match(r.stdout, /退役 1/);
  assert.match(r.stdout, /已退役 1/);
});

test('stats：没有 source_uri 的报「几条主张」，不报布尔', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  await makeLib(ws, 'lib', [{ id: id('n-1'), source_uri: undefined }]);

  const r = run(['stats', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /含未登记 1 条主张/);
  assert.doesNotMatch(r.stdout, /未登记 true/);
});

test('stats：usage 里列的命令和代码里分发的命令一致', async () => {
  const r = run(['stats', dirname(CLI)]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage 与代码一致/);
  assert.doesNotMatch(r.stdout, /⚠ usage 没写/);
  assert.doesNotMatch(r.stdout, /⚠ 代码里没有/);
});

test('stats --json：字段齐全，好让文档生成器直接吃', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-stats-'));
  await makeLib(ws, 'lib', [{ id: id('j-1') }]);

  const r = run(['stats', ws, '--json']);
  assert.equal(r.code, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.libraries.length, 1);
  assert.equal(data.total.total, 1);
  assert.equal(typeof data.code.modules, 'number');
  assert.deepEqual(data.code.onlyInCode, []);
  assert.deepEqual(data.code.onlyInUsage, []);
});
