/**
 * 第五轮审查（DeepSeek 跑命令 / ChatGPT 读 trace 完整性 / Kimi 校对文档）。
 *
 * 这一批全是同一个根因：**链和链头的校验没有成为「写入」和「判定」的前置条件**。
 *   - 改中间行 → 链断，但 set 照写、check 退出 0、status 说受控
 *   - 改末行 after → 链是完整的，只有链头能发现，而没人查链头
 *   - 调低 count → 只拦了 count > lines.length，相等就放行
 *   - .trace.head 是硬链接 → writeFile 跟着 inode 把库外文件覆盖了
 * 外加一个纯 bug：view 的失败路径返回数字被当对象解构，崩成 exit 3。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, link, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const SNAP = `沸点小记（虚构材料，仅供演示）

标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。`;

const SPEC = {
  claim: '标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃',
  kind: '原理', layer: '标准', basis: '条目', topic: 'demo.boiling',
  source_kind: '其他', source_extraction: '原文',
  source_uri: 'demo://沸点小记',
  snapshot_text: SNAP,
  quotes: ['标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。'],
  evidence_status: 'supported', world_status: 'unresolved',
  added_at: '2026-01-01',
};

function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

async function seed() {
  const base = await mkdtemp(join(tmpdir(), 'pl-r5-'));
  const root = join(base, 'entries');
  await mkdir(root, { recursive: true });
  const { createEntry } = await import('../src/create.js');
  for (const id of ['2026-01-01-a', '2026-01-01-b']) {
    const r = await createEntry({ root, id, spec: SPEC });
    assert.equal(r.ok, true, `seed 失败：${r.code}`);
  }
  return { base, root };
}

const tracePath = (root) => join(root, '.trace.jsonl');
const headPath = (root) => join(root, '.trace.head');

async function editLine(file, index, fn) {
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  const rec = JSON.parse(lines[index]);
  fn(rec);
  lines[index] = JSON.stringify(rec);
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

// ── 1. 改非末行：链断

test('改中间某行：写入被拒（trace_broken），check 退 1，status 不算受控', async () => {
  const { root } = await seed();
  // 改第 1 行的 at（这一条条目的 after 没变，以前照过）
  await editLine(tracePath(root), 0, (r) => { r.at = '2026-01-01T00:00:00.000Z'; });

  const r = cli(['set', '2026-01-01-a', 'topic', 'x', root]);
  assert.equal(r.code, 1);
  assert.match(r.out, /trace_broken/);

  assert.equal(cli(['check', root]).code, 1, '链断了 check 不能退出 0');
  assert.match(cli(['status', '2026-01-01-a', root]).out, /受控\s+否/);
  assert.match(cli(['status', '2026-01-01-a', root]).out, /能引用\s+否/);
});

// ── 2. 改末行 after：链是完整的，只有链头能发现

test('改末行 after：报 trace_tail_changed，不是「记录被删」', async () => {
  const { root } = await seed();
  await editLine(tracePath(root), 1, (r) => { r.after = 'deadbeef'.repeat(8); });

  const r = cli(['set', '2026-01-01-a', 'topic', 'x', root]);
  assert.equal(r.code, 1);
  assert.match(r.out, /trace_tail_changed/);
  assert.doesNotMatch(r.out, /trace_shrunk/, '末行被改不是「记录被删」，两种出路不一样');
});

// ── 3. 调低 count：只拦 count > lines.length 时会被绕过

test('删末行 + 把 count 改小：仍然被拒', async () => {
  const { root } = await seed();
  const lines = (await readFile(tracePath(root), 'utf8')).trim().split('\n');
  await writeFile(tracePath(root), `${lines.slice(0, -1).join('\n')}\n`, 'utf8');
  const h = JSON.parse(await readFile(headPath(root), 'utf8'));
  h.count = lines.length - 1;
  await writeFile(headPath(root), `${JSON.stringify(h)}\n`, 'utf8');

  const r = cli(['set', '2026-01-01-a', 'topic', 'x', root]);
  assert.equal(r.code, 1, 'count 改小 + 删行不能放行');
  assert.match(r.out, /trace_tail_changed|trace_shrunk/);
});

// ── 4. 硬链接：唯一能写到库外的路径

test('硬链接的 .trace.jsonl：整个写入被拒，条目一个字节都不动', async (t) => {
  const { base, root } = await seed();
  const tr = tracePath(root);
  const outside = join(base, 'outside.jsonl');
  await writeFile(outside, await readFile(tr, 'utf8'), 'utf8');

  try {
    await unlink(tr);
    await link(outside, tr);
  } catch (err) {
    t.skip(`这个文件系统建不了硬链接（${err.code}）`);
    return;
  }

  const before = await stat(join(root, '2026-01-01-a', 'entry.md'));
  const r = cli(['set', '2026-01-01-a', 'topic', 'x', root]);
  const after = await stat(join(root, '2026-01-01-a', 'entry.md'));

  assert.equal(r.code, 1);
  assert.match(r.out, /trace_hardlinked/);
  assert.equal(after.mtimeMs, before.mtimeMs, '被拒时 entry.md 不该被写');
  // 库外那份不能被追加
  assert.equal((await readFile(outside, 'utf8')).trim().split('\n').length, 2);
});

// ── 5. 链断时 reseal 要拒绝，不能假装修好

test('链断时 --reseal 拒绝，并说清它修不了', async () => {
  const { root } = await seed();
  await editLine(tracePath(root), 0, (r) => { r.at = '2026-01-01T00:00:00.000Z'; });

  const r = cli(['trace', root, '--reseal']);
  assert.equal(r.code, 1);
  assert.match(r.out, /只重建链头，不重算 prev/);
});

// ── 6. view 的失败路径不能崩

test('view：目录不存在时退 2，不是内部错误 3', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pl-view-'));
  const r = cli(['view', join(base, 'nope')]);
  assert.equal(r.code, 2, 'usage 承诺只有 0/1/2/3，3 是内部错误');
  assert.doesNotMatch(r.out, /内部错误|TypeError/);
});
