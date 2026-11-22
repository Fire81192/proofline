import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';

/**
 * 结构提示：这个库有没有骨架，地图跟没跟上。
 *
 * 它解决的不是「画图」，是「想不起来该画图」。
 * 知识地图是一条要人主动跑的命令，没人跑就不存在——所以让每次 check 都说一句：
 * 这个库现在只是一堆各自成立的句子，或者地图已经落后了。
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

async function makeLib(names) {
  const base = await mkdtemp(join(tmpdir(), 'pl-struct-'));
  const root = join(base, 'lib', 'entries');
  await mkdir(root, { recursive: true });
  for (const n of names) {
    const dir = join(root, id(n));
    await mkdir(join(dir, 'raw'), { recursive: true });
    await writeFile(join(dir, 'entry.md'), buildEntry({ id: id(n) }), 'utf8');
    await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  }
  return { base, root };
}

async function writeMap(base, blocks) {
  const map = { version: 1, goal: '测试', note: '', blocks, domains: [], points: [] };
  await writeFile(join(base, 'lib', 'knowledge-map.json'), JSON.stringify(map), 'utf8');
}

const block = (bid, entries) => ({
  id: bid, name: bid, needs: [], entries, basis: '条目', gap: '',
});

test('check：没有地图的库会被点名——不静默', async () => {
  const { root } = await makeLib(['a']);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有 knowledge-map\.json/);
  assert.match(r.stdout, /1 条主张现在是彼此的孤岛/);
});

test('check：地图覆盖全部在用条目时，不啰嗦', async () => {
  const { base, root } = await makeLib(['a', 'b']);

  await writeMap(base, [block('x', [id('a'), id('b')])]);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /结构提示/);
});

test('check：地图落后的条目不藏——点名到 id', async () => {
  const { base, root } = await makeLib(['a', 'b']);

  await writeMap(base, [block('x', [id('a')])]);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 条没挂到任何能力块/);
  assert.match(r.stdout, new RegExp(id('b')));
});

test('check：地图指向不存在的条目要报——条目删了图还在指', async () => {
  const { base, root } = await makeLib(['a']);

  await writeMap(base, [block('x', [id('a'), '2026-11-22-ghost'])]);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /库里不存在的条目/);
  assert.match(r.stdout, /ghost/);
});

test('check：退役的条目不算孤儿——它本来就不该挂在地图上', async () => {
  const { base } = await makeLib([]);
  const root = join(base, 'lib', 'entries');
  const dir = join(root, id('r'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), buildEntry({
    id: id('r'), deprecated: { at: '2026-11-22', reason: '这条已经拆成两条了，留着只看历史' },
  }), 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');

  await writeMap(base, [block('x', [])]);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /没挂到任何能力块/);
});

test('check：地图文件坏了，报「读不了」而不是「还没有」', async () => {
  const { base, root } = await makeLib(['a']);
  await writeFile(join(base, 'lib', 'knowledge-map.json'), '{ 这不是 JSON', 'utf8');

  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /读不了/);
  assert.doesNotMatch(r.stdout, /没有 knowledge-map\.json/);
});

test('check：地图还挂着已退役的条目，要报——那一块看起来就有支撑', async () => {
  const { base } = await makeLib([]);
  const root = join(base, 'lib', 'entries');
  const dir = join(root, id('r'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), buildEntry({
    id: id('r'), deprecated: { at: '2026-11-22', reason: '结论被后来的实测推翻了，留着只看历史' },
  }), 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');

  await writeMap(base, [block('x', [id('r')])]);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /还挂着 1 条已退役的条目/);
});

test('check：有文件但 blocks 是空的，不等于有地图', async () => {
  const { base, root } = await makeLib(['a']);
  await writeMap(base, []);
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /一个能力块都没有/);
  assert.match(r.stdout, /空 blocks 只是让检查闭嘴/);
});

test('stats：地图列把「有没有骨架」带进总览', async () => {
  const { base } = await makeLib(['a']);
  let r = run(['stats', join(base, 'lib', 'entries')]);
  assert.match(r.stdout, /无地图/);
  assert.match(r.stdout, /0\/1 个库有知识地图/);

  await writeMap(base, [block('x', [id('a')])]);
  r = run(['stats', join(base, 'lib', 'entries')]);
  assert.match(r.stdout, /地图 1 块·覆盖 1\/1/);
  assert.match(r.stdout, /1\/1 个库有知识地图/);
});

test('map --brief：没有地图的库，任务书让人从零画', async () => {
  const { root } = await makeLib(['a', 'b']);
  const r = run(['map', '--brief', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /# 任务：给这个库写一份知识地图/);
  assert.match(r.stdout, /没有地图/);
  // 材料必须给全：没给 id，AI 只能编
  assert.match(r.stdout, new RegExp(id('a')));
  assert.match(r.stdout, new RegExp(id('b')));
  // 约束必须是机器真会查的，否则等于没写
  assert.match(r.stdout, /不能成环/);
  assert.match(r.stdout, /只能引用上面表里出现过的 id/);
});

test('map --brief：地图已完整时说「别动」，不诱导重写', async () => {
  const { base, root } = await makeLib(['a']);

  await writeMap(base, [block('x', [id('a')])]);
  const r = run(['map', '--brief', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /这份地图目前是完整的/);
  assert.match(r.stdout, /别动它/);
});

test('map --brief：没有条目的库不生成任务书——没材料可切', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pl-struct-'));
  const root = join(base, 'lib', 'entries');
  await mkdir(root, { recursive: true });

  const r = run(['map', '--brief', root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /还没有条目/);
});
