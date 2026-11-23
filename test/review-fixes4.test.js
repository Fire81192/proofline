/**
 * 第四轮审查（DeepSeek 跑命令 / ChatGPT 读新代码 / Kimi 读文档）抓到的。
 *
 * 这一批的共同点：**前三轮全盯着 core 的判定逻辑，没人管「周边命令」和「性能边界」**。
 *   - audit 的邮箱正则没有上界 → 单行 512KB 挂 15 秒
 *   - audit / scan 先整读再判上限（判断在读取之后，保护的是已经发生的事）
 *   - 新库第一次写入必失败（withinReal 把「目录还不存在」当成越界）
 *   - stats 把 null 当依据分类，形状废的条目算了不显示
 *   - map 在 blocks: [] 上出空图退 0，而 check 说「还没有骨架」
 *   - 删掉 trace 记录能把手改洗成受控（trace_shrunk）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditDir } from '../src/audit.js';
import { withinReal } from '../src/core/store.js';
import { mkdtemp as _mk } from 'node:fs/promises';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const SNAP = `沸点小记（虚构材料，仅供演示）

标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。
气压降低时沸点随之降低：海拔每升高约 300 米，沸点下降约 1 ℃。`;

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

async function seed(id = '2026-01-01-demo') {
  const base = await mkdtemp(join(tmpdir(), 'pl-r4-'));
  const root = join(base, 'entries');
  await mkdir(root, { recursive: true });
  const { createEntry } = await import('../src/create.js');
  const r = await createEntry({ root, id, spec: SPEC });
  assert.equal(r.ok, true, `seed 失败：${r.code}`);
  return { base, root, file: join(root, id, 'entry.md') };
}

// ── 1. 删记录不能解封

test('留痕被删：写入被拒（trace_shrunk），不是「没有记录就不判」', async () => {
  const { root, file } = await seed();
  await writeFile(file, (await readFile(file, 'utf8')).replace('沸点是 100', '沸点是 120'), 'utf8');

  // 手改之后单独被拒，这条以前就有
  assert.equal(cli(['set', '2026-01-01-demo', 'topic', 'a', root]).code, 1);

  // 把记录抹掉、链头留着——以前这一手能让 set 通过，而且连 drift 都不留
  await writeFile(join(root, '.trace.jsonl'), '', 'utf8');

  const r = cli(['set', '2026-01-01-demo', 'topic', 'b', root]);
  assert.equal(r.code, 1, '删记录之后不能放行');
  assert.match(r.out, /trace_shrunk/);
  assert.match(r.out, /被删过/);

  // 但要给出路：reseal 清掉过期链头之后能继续（这一步就是承认删过）
  assert.match(cli(['trace', root, '--reseal']).out, /链头已清掉/);
  assert.equal(cli(['set', '2026-01-01-demo', 'topic', 'c', root]).code, 0);
});

// ── 2. 新库能自举

test('新库第一次写入：目录不存在不是越界', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pl-boot-'));
  // 库目录都还没建
  assert.equal(await withinReal(join(base, 'entries'), join(base, 'entries', '2026-01-01-a')), true,
    '「目录还不存在」不等于「越界」');

  // 符号链接照样要拦住
  await mkdir(join(base, 'entries'), { recursive: true });
  await mkdir(join(base, 'outside'), { recursive: true });
  try {
    await symlink(join(base, 'outside'), join(base, 'entries', 'evil'), 'junction');
    assert.equal(await withinReal(join(base, 'entries'), join(base, 'entries', 'evil', 'x')), false,
      '符号链接指向库外必须拒绝');
  } catch (err) {
    if (err.code === 'EPERM') return;   // Windows 没开开发者模式
    throw err;
  }
});

// ── 3. audit 不能挂死

test('audit：512KB 单行要秒回，且正常邮箱仍能抓到', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pl-audit-'));
  // 一段没有 @ 的长字符串：邮箱正则没有上界时，每个起始位置都吃到底再回退 → O(n²)
  await writeFile(join(dir, 'big.txt'), 'y'.repeat(512 * 1024), 'utf8');
  await writeFile(join(dir, 'ok.txt'), '联系 zhang@example.com 就行\n', 'utf8');

  const t0 = Date.now();
  const r = await auditDir(dir);
  const ms = Date.now() - t0;

  assert.ok(ms < 5000, `512KB 单行不该卡住，实际 ${ms}ms`);
  assert.ok(r.findings.some((f) => f.kind === 'email'), '邮箱仍然要抓到');
});

// ── 4. stats 不把坏条目当分类

test('stats：坏条目进「形状废」，不变成依据分布里的 null', async () => {
  const { root, file } = await seed();
  // 删掉 frontmatter 的开头，让这条读不出 basis
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/^---\n/, ''), 'utf8');

  const r = cli(['stats', root]);
  assert.doesNotMatch(r.out, /null 1/, 'null 不是一种依据');
  assert.match(r.out, /形状废\s+1 条/, '读不出来的条目要报数');
});

// ── 5. 空地图不是成果

test('map：blocks 为空且库里有条目时，不出图、退 1', async () => {
  const { base, root } = await seed();
  await writeFile(join(base, 'knowledge-map.json'), JSON.stringify({
    schema: 1, project: '空地图', blocks: [], domains: [],
  }), 'utf8');

  const r = cli(['map', root]);
  assert.equal(r.code, 1, 'check 说「还没有骨架」，map 不能出空图退 0');
  assert.match(r.out, /还没有骨架/);
});
