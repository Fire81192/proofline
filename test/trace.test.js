import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';
import { appendTrace, readTrace, verifyChain, lineHash, controlState, lastByEntry } from '../src/core/trace.js';
import { contentHash } from '../src/core/store.js';

/**
 * 留痕。
 *
 * 它防的不是「写错」，是「绕过工具直接改」。拦不住——AI 有文件写权限；
 * 但改了要能被发现：没有记录、或者记录对不上，都算未受控。
 *
 * 它防不住「全量重写」（把整个文件删掉重生成，链是自洽的），
 * 那一层靠 git：trace 进版本库，重写会在 diff 里留痕。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const id = (s) => `2026-11-22-${s}`;

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function lib(names) {
  const base = await mkdtemp(join(tmpdir(), 'pl-trace-'));
  const root = join(base, 'lib', 'entries');
  await mkdir(root, { recursive: true });
  for (const n of names) {
    const dir = join(root, id(n));
    await mkdir(join(dir, 'raw'), { recursive: true });
    const text = buildEntry({ id: id(n) });
    await writeFile(join(dir, 'entry.md'), text, 'utf8');
    await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
    await appendTrace(root, { op: 'create', id: id(n), after: contentHash(text) });
  }
  return { base, root };
}

test('留痕：追加后链完整，记录能读回来', async () => {
  const { root } = await lib(['a', 'b']);
  const { lines, error } = await readTrace(root);
  assert.equal(error, null);
  assert.equal(lines.length, 2);
  assert.deepEqual(verifyChain(lines).ok, true);
  assert.equal(lastByEntry(lines).get(id('a')).op, 'create');
});

test('留痕：改一行 -> 链从那一行之后断掉', async () => {
  const { root } = await lib(['a', 'b', 'c']);
  const file = join(root, '.trace.jsonl');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const rec = JSON.parse(lines[1]);
  rec.after = 'deadbeefdeadbeef'; // 抹掉一次修改，还想假装没发生
  lines[1] = JSON.stringify(rec);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

  const reread = await readTrace(root);
  const v = verifyChain(reread.lines);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3, '第 2 行被改，断点报在第 3 行——因为第 3 行的 prev 对不上');
});

test('留痕：删掉中间一行 -> 链断，不是「少了一条也无所谓」', async () => {
  const { root } = await lib(['a', 'b', 'c']);
  const file = join(root, '.trace.jsonl');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  lines.splice(1, 1);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');

  const v = verifyChain((await readTrace(root)).lines);
  assert.equal(v.ok, false);
});

test('受控判定：没记录 / 对不上 / 正常，三种说法不同', () => {
  assert.equal(controlState(null, 'abc').kind, 'no_trace');
  assert.equal(controlState('abc', 'abd').kind, 'drift');
  assert.equal(controlState('abc', 'abc').controlled, true);
  assert.match(controlState(null, 'abc').why, /没有任何入库记录/);
  assert.match(controlState('abc', 'abd').why, /工具之外被改过/);
});

test('CLI：手改 entry.md 后 check 报未受控，status 不给引用', async () => {
  const { root } = await lib(['a']);
  const file = join(root, id('a'), 'entry.md');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('XML 标签', 'XML 标记'), 'utf8');

  const c = run(['check', root]);
  assert.match(c.stdout, /未受控 1 条/);
  assert.match(c.stdout, /工具之外被改过/);

  const s = run(['status', id('a'), root]);
  assert.match(s.stdout, /受控\s+否/);
  assert.match(s.stdout, /能引用\s+否（未受控/);
});

test('CLI：通过工具改（set）会自动留痕，仍然受控', async () => {
  const { root } = await lib(['a']);
  // 用 set 改一个不涉及哈希的字段
  const r = run(['set', id('a'), 'topic', 'trace.test', root]);
  assert.equal(r.code, 0);

  const { lines } = await readTrace(root);
  assert.equal(lines.at(-1).op, 'set');
  assert.equal(verifyChain(lines).ok, true);

  const t = run(['trace', root]);
  assert.match(t.stdout, /受控 1\/1/);
});

test('CLI：trace --adopt 建基线，并把「此前不可考」写进记录', async () => {
  const { base } = await lib([]);
  const root = join(base, 'lib', 'entries');
  const dir = join(root, id('z'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), buildEntry({ id: id('z') }), 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');

  // 没确认时只预览，不写
  const preview = run(['trace', root, '--adopt']);
  assert.match(preview.stdout, /建立基线/);
  assert.match(preview.stdout, /此前历史不可考/);
  assert.equal((await readTrace(root)).exists, false);

  assert.equal(run(['trace', root, '--adopt', '--confirm']).code, 0);
  const { lines } = await readTrace(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].op, 'adopt');
  assert.match(lines[0].note, /历史不可考/);
});

test('留痕：坏行不跳过——跳过等于把「被改坏」当成「没有」', async () => {
  const { root } = await lib(['a']);
  await writeFile(join(root, '.trace.jsonl'), '{"v":1}\n这不是 JSON\n', 'utf8');
  const r = await readTrace(root);
  assert.ok(r.error);
  assert.match(r.error, /第 2 行/);
});

test('留痕：lineHash 只认固定字段顺序，多一个字段不会改变哈希', () => {
  const a = { v: 1, at: 't', op: 'x', id: 'i', after: 'h', prev: '' };
  const b = { ...a, extra: 'ignored' };
  assert.equal(lineHash(a), lineHash(b));
});

test('留痕：并发追加不断链（.trace.lock）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pl-race-'));
  const N = 20;

  // 修之前实测：20 条全落盘，但相邻重复 prev 有 19 处，verifyChain 判「第 1 行之后被改动或插入」。
  // 根因是「读全链 → 算 prev → 追加」之间隔着 await，两个调用读到同样的 lines。
  await Promise.all(
    Array.from({ length: N }, (_, i) => appendTrace(root, { op: 'race', id: `id-${i}`, after: `hash-${i}` })),
  );

  const { lines } = await readTrace(root);
  assert.equal(lines.length, N, '一条都不能丢');

  const v = verifyChain(lines);
  assert.ok(v.ok, `链必须完整：${v.reason ?? JSON.stringify(v)}`);

  // 相邻 prev 重复 = 两条指向同一个前驱 = 分叉
  let dup = 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i].prev === lines[i - 1].prev) dup += 1;
  assert.equal(dup, 0, '不能有两条指向同一个前驱');
});
