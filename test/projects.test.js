import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目总览。
 *
 * 架构约束：**插件只读不写，不存任何项目数据。** 分类信息在各自的
 * `project.json` 里，这个命令只负责读出来排在一起。少了文件就显示
 * 「未登记」，不编造。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** 造一个 workspace：每个项目一个 entries/ 目录，可选 project.json。 */
async function workspace(specs) {
  const base = await mkdtemp(join(tmpdir(), 'pl-projects-'));
  for (const [name, meta] of Object.entries(specs)) {
    const root = join(base, name, 'entries');
    await mkdir(root, { recursive: true });
    if (meta) await writeFile(join(base, name, 'project.json'), JSON.stringify(meta), 'utf8');
  }
  return base;
}

test('projects：有 project.json 的显示名称与领域', async () => {
  const ws = await workspace({
    alpha: { name: '甲项目', domain: '测试领域', purpose: '验证一件事' },
    beta: null,
  });
  const r = run(['projects', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /甲项目（测试领域）/);
  assert.match(r.stdout, /验证一件事/);
});

test('projects：没有 project.json 的显示「未登记」——不编造', async () => {
  const ws = await workspace({ beta: null });
  const r = run(['projects', ws]);
  assert.match(r.stdout, /（未登记）/);
});

test('projects：只认含 entries/ 的子目录，普通目录不算项目', async () => {
  const ws = await workspace({ alpha: { name: '甲', domain: '', purpose: '' } });
  await mkdir(join(ws, 'not-a-project', 'raw'), { recursive: true });
  const r = run(['projects', ws]);
  const lines = r.stdout.split('\n').filter((l) => l.includes('not-a-project'));
  assert.equal(lines.length, 0);
});

test('projects：空工作区不报错，说清楚没有项目', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'pl-empty-'));
  const r = run(['projects', ws]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有找到项目/);
});
