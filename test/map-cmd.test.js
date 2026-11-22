import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';

/**
 * map 命令的落盘纪律。
 *
 * 任务书里写着「0 个 problem 再交」——如果带着问题还生成一张图，
 * 人看到「已生成」就以为过了。坏图比没有图更糟：它看起来像成品。
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

async function libWithMap(map) {
  const base = await mkdtemp(join(tmpdir(), 'pl-map-cmd-'));
  const root = join(base, 'lib', 'entries');
  const dir = join(root, id('a'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), buildEntry({ id: id('a') }), 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  await writeFile(join(base, 'lib', 'knowledge-map.json'), JSON.stringify(map), 'utf8');
  return { base, root };
}

const emptyMap = (blocks) => ({ version: 1, goal: '测试', blocks, domains: [], points: [] });

test('map：地图有硬问题时不写文件，退出码 1', async () => {
  const { base, root } = await libWithMap(emptyMap([
    { id: 'x', name: 'x', needs: ['ghost'], entries: [id('a')], basis: '条目', gap: '' },
  ]));

  const r = run(['map', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /没有写文件/);
  assert.match(r.stdout, /不存在的知识域：ghost/);
  await assert.rejects(stat(join(base, 'lib', '课程地图.html')));
});

test('map：问题修好后正常出图', async () => {
  const { base, root } = await libWithMap(emptyMap([
    { id: 'x', name: 'x', needs: [], entries: [id('a')], basis: '条目', gap: '' },
  ]));

  const r = run(['map', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /已生成/);
  const st = await stat(join(base, 'lib', '课程地图.html'));
  assert.ok(st.size > 0);
});

test('map --brief 写的约束和 map 的检查对得上：写着会被拒的，真的会被拒', async () => {
  const { base, root } = await libWithMap(emptyMap([
    { id: 'x', name: 'x', needs: [], entries: [id('a')], basis: '听说', gap: '' },
  ]));

  const r = run(['map', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /依据「听说」不认识/);
});
