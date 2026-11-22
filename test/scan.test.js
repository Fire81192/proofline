import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject } from '../src/scan.js';

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-scan-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  return dir;
}

test('同一条坑出现在两个文件里 -> 聚合成一条候选，位置都带上', async () => {
  const dir = await project({
    'a.py': 'b, a = butter(4, 0.2)\ny = lfilter(b, a, x)\n',
    'b.py': 'b2, a2 = butter(2, 0.5)\nz = lfilter(b2, a2, y)\n',
  });
  const { candidates, stats } = await scanProject(dir);
  assert.equal(stats.files, 2);

  const c = candidates.find((x) => x.key === 'filter-phase-shift');
  assert.ok(c, '应当报相位失真');
  assert.equal(c.hits, 2);
  assert.equal(c.evidence.length, 2);
  assert.deepEqual(c.evidence.map((e) => e.file).sort(), ['a.py', 'b.py']);
});

test('候选自带 level / cost / action / origin，能直接喂给判定层', async () => {
  const dir = await project({ 'x.py': 'rm -rf ./build\n' });
  const { candidates } = await scanProject(dir);
  const c = candidates.find((x) => x.key === 'destructive-cleanup');
  assert.ok(c);
  assert.equal(c.level, '致命');
  assert.equal(c.reversible, false);
  assert.ok(c.action.length > 0);
  assert.equal(c.origin, 'builtin:destructive-cleanup');
});

test('跳过依赖目录与非代码文件', async () => {
  const dir = await project({
    'node_modules/pkg/x.py': 'b, a = butter(2, 0.1)\ny = lfilter(b, a, x)\n',
    'readme.md': 'b, a = butter(2, 0.1)\ny = lfilter(b, a, x)\n',
    'ok.py': 'print(1)\n',
  });
  const { candidates, stats } = await scanProject(dir);
  assert.equal(stats.files, 1, '只该扫到 ok.py');
  assert.equal(candidates.length, 0);
});

test('干净的项目扫不出东西', async () => {
  const dir = await project({ 'clean.py': 'import numpy as np\nrng = np.random.default_rng(0)\nprint(rng.random())\n' });
  const { candidates } = await scanProject(dir);
  assert.deepEqual(candidates, []);
});

test('evidence 有上限，不会把几十处全塞进来', async () => {
  const lines = Array.from({ length: 10 }, () => 'y = lfilter(b, a, x)').join('\n');
  const dir = await project({ 'many.py': `b, a = butter(2, 0.1)\n${lines}\n` });
  const { candidates } = await scanProject(dir, { maxEvidence: 3 });
  const c = candidates.find((x) => x.key === 'filter-phase-shift');
  assert.equal(c.evidence.length, 3);
  assert.equal(c.hits, 10, '命中总数仍要如实统计');
});

test('stats 里带不可读目录计数（不静默跳过）', async () => {
  const dir = await project({ 'ok.py': 'print(1)\n' });
  const { stats } = await scanProject(dir);
  assert.equal(typeof stats.unreadable, 'number');
  assert.ok(Array.isArray(stats.unreadableDirs));
});
