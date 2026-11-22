import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveInside, loadSnapshotMap } from '../src/core/store.js';

async function entryDir(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-store-'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  for (const [rel, text] of Object.entries(extra)) {
    await writeFile(join(dir, rel), text, 'utf8');
  }
  return dir;
}

test('resolveInside：目录内的相对路径放行', async () => {
  const dir = await entryDir();
  assert.ok(resolveInside(dir, 'raw/verify-1.txt'));
  assert.ok(resolveInside(dir, 'raw/sub/../verify-1.txt'), '绕一圈但仍在目录内，允许');
});

test('resolveInside：越界的路径一律返回 null', async () => {
  const dir = await entryDir();
  for (const bad of ['../x.txt', '../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '', '.']) {  // audit-ignore 夹具
    assert.equal(resolveInside(dir, bad), null, `不该放行：${bad}`);
  }
});

test('佐证指向目录外时，读取器拿不到内容（不是靠字符串猜）', async () => {
  const dir = await entryDir({ 'raw/verify-1.txt': '里面的快照' });
  const text = `---
corroborations: [{"uri":"x","sha256":"${'a'.repeat(64)}","snapshot":"../secrets.txt","quote":"q"}]
---`;
  const map = await loadSnapshotMap(dir, text);
  assert.equal(map.size, 0, '越界路径不该被读进 map');
});

test('正常的佐证快照能读出来', async () => {
  const dir = await entryDir({ 'raw/verify-1.txt': '外面的佐证' });
  const text = `---
corroborations: [{"uri":"x","sha256":"${'a'.repeat(64)}","snapshot":"raw/verify-1.txt","quote":"q"}]
---`;
  const map = await loadSnapshotMap(dir, text);
  assert.equal(map.get('raw/verify-1.txt'), '外面的佐证');
});

import { commit, contentHash, readEntry } from '../src/core/store.js';
import { joinFrontmatter } from '../src/core/frontmatter.js';
import { KEY_ORDER } from '../src/core/schema.js';
import { sha256 } from '../src/core/snapshot.js';
import { readFile } from 'node:fs/promises';

async function liveEntry() {
  const root = await mkdtemp(join(tmpdir(), 'proofline-commit-'));
  const id = '2026-11-21-live';
  const dir = join(root, id);
  await mkdir(join(dir, 'raw'), { recursive: true });
  const snap = 'hello world';
  await writeFile(join(dir, 'raw', 'source.txt'), snap, 'utf8');
  const data = {
    schema: 1, id, claim: '这是一条测试用的主张，够长了', kind: '方法', layer: '线索', basis: '条目',
    source_kind: '文章', source_extraction: '原文', source_sha256: sha256(snap),
    evidence_status: 'supported', world_status: 'unresolved', quotes: ['hello world'],
    added_at: '2026-11-21',
  };
  const text = joinFrontmatter(data, '', KEY_ORDER);
  await writeFile(join(dir, 'entry.md'), text, 'utf8');
  return { root, id, dir, text };
}

test('commit：版本对不上时一个字都不写', async () => {
  const { root, id, dir, text } = await liveEntry();
  const res = await commit({ root, id, text: text.replace('方法', '原理'), expect: '0000000000000000' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'drift');
  assert.equal(await readFile(join(dir, 'entry.md'), 'utf8'), text, '文件必须原封不动');
});

test('commit：已有文件但不给 expect -> 拒绝（不猜版本）', async () => {
  const { root, id, text } = await liveEntry();
  const res = await commit({ root, id, text, expect: null });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'expect_required');
});

test('commit：版本正确时写入，返回新版本号', async () => {
  const { root, id, text } = await liveEntry();
  const next = text.replace('方法', '原理');
  const res = await commit({ root, id, text: next, expect: contentHash(text) });
  assert.equal(res.ok, true);
  assert.equal(res.hash, contentHash(next));
});

test('commit：hard_fail 的文本拒绝写入', async () => {
  const { root, id, text } = await liveEntry();
  const res = await commit({ root, id, text: text.replace('这是一条测试用的主张，够长了', '短'), expect: contentHash(text) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'hard_fail');
});

test('符号链接指向库外：读和写都拒绝', async (t) => {
  const { root } = await liveEntry();

  const outside = join(root, '..', 'outside-secret');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'entry.md'), '库外的文件', 'utf8');

  let linked = true;
  try {
    symlinkSync(outside, join(root, '2026-11-22-evil'), 'junction');
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip('这个平台建不了符号链接（Windows 需要开发者模式或管理员）');
    return;
  }

  // resolveInside 只看字符串：`entries/2026-11-22-evil` 在库里，但它指向外面
  assert.equal(await readEntry(root, '2026-11-22-evil'), null, '读要拒绝');

  const w = await commit({ root, id: '2026-11-22-evil', text: 'x', expect: null, allowCreate: true });
  assert.equal(w.ok, false);
  assert.equal(w.code, 'escapes_root');
});
