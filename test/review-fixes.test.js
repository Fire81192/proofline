import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateEntry } from '../src/core/validate.js';
import { deriveStatus } from '../src/core/status.js';
import { buildEntry, SNAPSHOT } from './helpers.js';

/**
 * 两份外部审核（Codex 实测 + ChatGPT/DeepSeek 静态）指出的洞，逐条复现后修的。
 * 这里只放"修完了，别再回来"的断言——不是功能测试，是回归锁。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const setLine = (text, key, val) => text.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${val}`);
const V = (text) => validateEntry({ dirName: '2026-11-22-a', text, snapshotText: SNAPSHOT, readSnapshot: () => null, fix: false });

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const base = () => buildEntry({ id: '2026-11-22-a' });

test('claim 是对象或数组：hard_fail（以前会 pass）', () => {
  assert.equal(V(setLine(base(), 'claim', '{"a": 1}')).status, 'hard_fail');
  assert.equal(V(setLine(base(), 'claim', '["a"]')).status, 'hard_fail');
});

test('id 是数字：hard_fail（以前会 pass）', () => {
  assert.equal(V(setLine(base(), 'id', '123')).status, 'hard_fail');
});

test('gaps 的 dimension 拼错：hard_fail（以前静默，blocking 缺口谁的账都不进）', () => {
  const t = setLine(base(), 'gaps', '[{"question": "x", "action": "search", "blocking": true, "dimension": "evidenc"}]');
  assert.equal(V(t).status, 'hard_fail');
});

test('gaps 标了 blocking 却不说哪一维：hard_fail', () => {
  const t = setLine(base(), 'gaps', '[{"question": "x", "action": "search", "blocking": true}]');
  assert.equal(V(t).status, 'hard_fail');
});

test('basis 带尾随空格：status 也按判断档处理，不给引用', () => {
  const t = setLine(base(), 'basis', '"判断 "');
  const d = deriveStatus({ dirName: '2026-11-22-a', text: t, snapshotText: SNAPSHOT });
  assert.equal(d.citable, false, '以前 validate 判 hard_fail，status 却说可引用——两套结论');
});

test('check --fix 写回后仍受控（fix 也要留痕）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-fix-'));
  const dir = join(root, '2026-11-22-a');
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  await writeFile(join(dir, 'entry.md'), setLine(base(), 'added_at', '2026-1-5'), 'utf8');

  // 手工建一条 create 记录当起点
  const { appendTrace } = await import('../src/core/trace.js');
  const { contentHash } = await import('../src/core/store.js');
  await appendTrace(root, { op: 'create', id: '2026-11-22-a', after: contentHash(await readFile(join(dir, 'entry.md'), 'utf8')) });

  assert.equal(run(['check', root, '--fix']).code, 0);
  assert.match(run(['trace', root]).stdout, /受控 1\/1/, 'fix 之后不能变成未受控');
  assert.match(await readFile(join(root, '.trace.jsonl'), 'utf8'), /"op":"fix"/);
});

test('建条目时目录里已有别人的文件：拒绝，不删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-ne-'));
  const dir = join(root, '2026-11-22-a');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'notes.txt'), '别人放在这儿的', 'utf8');

  const { createEntry } = await import('../src/create.js');
  const r = await createEntry({ root, id: '2026-11-22-a', spec: { claim: '这是一条测试用的主张，够长了', kind: '方法', layer: '线索', basis: '判断' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'dir_not_empty');
  assert.ok((await readdir(dir)).includes('notes.txt'), '别人的文件不能被删');
});
