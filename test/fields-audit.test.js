import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';

/**
 * 字段审计。
 *
 * 规矩是从 Alexandria 的 field law 抄的：每个字段要说清谁写谁读。
 * 判据两条——代码里有没有业务读者，数据里有几种取值。
 *
 * 这里只测「工具能不能跑、会不会把两类命中分开报」，
 * 不测具体哪个字段该死——那是人看了报告再决定的。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function lib(name, ids) {
  const base = await mkdtemp(join(tmpdir(), `pl-fa-${name}-`));
  const root = join(base, 'lib', 'entries');
  await mkdir(root, { recursive: true });
  for (const id of ids) {
    const dir = join(root, id);
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'entry.md'), buildEntry({ id }), 'utf8');
    await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  }
  return { base, root };
}

test('fields --audit：能跑，且把「要看的」和「没列的」分开', async () => {
  const { root } = await lib('one', ['2026-11-22-a']);
  const r = run(['fields', '--audit', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /字段审计：\d+ 个字段/);
  assert.match(r.stdout, /要看的|每个字段都有多种取值/);
  assert.match(r.stdout, /其余 \d+ 个/, '正常的字段只报数，不逐条列');
});

test('fields --audit：传 workspace 会把多个库合起来算', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pl-fa-multi-'));
  for (const name of ['a', 'b']) {
    const root = join(base, name, 'entries');
    const dir = join(root, '2026-11-22-x');
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'entry.md'), buildEntry({ id: '2026-11-22-x' }), 'utf8');
    await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  }
  const r = run(['fields', '--audit', base]);
  assert.match(r.stdout, /2 个库/);
  assert.match(r.stdout, /2 条条目/);
});

test('fields --audit：空目录不崩', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pl-fa-empty-'));
  const r = run(['fields', '--audit', base]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /0 条条目/);
  assert.doesNotMatch(r.stdout, /内部错误/);
});

test('fields（不带 --audit）：仍然是打印契约，不是审计', async () => {
  const r = run(['fields']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /claim/);
  assert.doesNotMatch(r.stdout, /字段审计/);
});
