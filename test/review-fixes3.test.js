/**
 * 第三轮审查（DeepSeek / ChatGPT / GLM）抓到的漏网之鱼。
 *
 * 这一批的共同点：**「留痕」这个维度在几条路径上还没接完**。
 *   - `check --fix` 不走 commit，绕过了上一轮加的 untracked_change
 *   - 未受控只打印，不进 check 退出码（CI 里永远绿）
 *   - 留痕文件坏了 → buildControlledMap 返回 null → 全库都还能「引用」
 *   - commit 返回的 traceError 没人读（字段返回了等于没有）
 *   - 课程地图没接 controlledOf
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 建一个库，返回 { root, file }。root 是 entries 目录。 */
async function seed(id = '2026-01-01-demo', extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pl-r3-'));
  const root = join(base, 'entries');
  await mkdir(root, { recursive: true });
  const { createEntry } = await import('../src/create.js');
  const r = await createEntry({ root, id, spec: { ...SPEC, ...extra } });
  assert.equal(r.ok, true, `seed 失败：${r.code}`);
  return { root, file: join(root, id, 'entry.md') };
}

// ── 1. check --fix 不是洗白通道

test('check --fix：未受控的条目拒绝自动修复，手改内容不变受控', async () => {
  const { root, file } = await seed();

  // 手改正文，同时制造一个能自动修的小毛病（id 与目录名不符）
  let text = await readFile(file, 'utf8');
  text = text.replace('纯水的沸点是 100 ℃', '纯水的沸点是 100 ℃（手改过的内容）');
  text = text.replace(/^id: 2026-01-01-demo/m, 'id: 2026-01-01-TAMPERED');
  await writeFile(file, text, 'utf8');

  // 修之前：--fix 会把整份文件写回（含手改内容），再盖一个 fix 章。
  // trace 里那次洗白和一次正常格式修复完全一样，事后看不出来。
  const r = cli(['check', root, '--fix']);
  assert.equal(r.code, 1, '未受控要计入退出码');
  assert.match(r.out, /未修/);
  assert.match(r.out, /不自动修复/);
  assert.match(r.out, /trace --adopt/, '报错要说怎么接受现状');

  // 手改内容还在（没被悄悄改回），但它不受控
  assert.match(await readFile(file, 'utf8'), /手改过的内容/);
  assert.match(cli(['status', '2026-01-01-demo', root]).out, /受控\s+否/);
});

// ── 2. 未受控要进退出码

test('check：未受控的条目让退出码变 1（以前只打印一行）', async () => {
  const { root, file } = await seed();

  assert.equal(cli(['check', root]).code, 0, '干净的库应该通过');

  // 只改正文、不制造任何可修项：这条路径只有留痕能发现
  await writeFile(file, (await readFile(file, 'utf8')).replace('沸点是 100', '沸点是 120'), 'utf8');

  const r = cli(['check', root]);
  assert.equal(r.code, 1, '未受控在 CI 里必须能让 check 失败');
  assert.match(r.out, /未受控 1 条/);

  // 同一个事实在 set 上是致命错误——两边严重度一致了
  assert.equal(cli(['set', '2026-01-01-demo', 'topic', 'demo.x', root]).code, 1);
});

// ── 3. 留痕坏了要 fail-closed

test('留痕损坏：status / index 都按「不能引用」处理，不是「不判」', async () => {
  const { root } = await seed();

  assert.match(cli(['status', '2026-01-01-demo', root]).out, /能引用\s+是/);

  // 坏一行。readTrace 会返回「坏行之前的部分 + error」——
  // 以前 buildControlledMap 见到 error 就返回 null，而 null 让 assessEntry
  // 跳过留痕否决，于是整个库反而更宽松了。
  await writeFile(join(root, '.trace.jsonl'), `${await readFile(join(root, '.trace.jsonl'), 'utf8')}{broken json\n`, 'utf8');

  const st = cli(['status', '2026-01-01-demo', root]).out;
  assert.match(st, /受控\s+否/);
  assert.match(st, /能引用\s+否/);
  assert.match(st, /留痕读不了/);

  cli(['index', root]);
  const idx = await readFile(join(root, 'INDEX.md'), 'utf8');
  assert.doesNotMatch(idx, /可引用/, '留痕坏了不能把条目标成可引用');
});

// ── 4. 留痕写失败要说话

test('留痕写失败：set 照常改内容，但要明确说出来', async () => {
  const { root } = await seed();

  // 占住锁。appendTrace 会等 3 秒然后返回 {ok:false, error}——
  // 注意它**不抛异常**，所以 commit 仍然 ok:true，只有 traceError 带着原因。
  // 以前五个 commit 调用点一个都没读这个字段。
  await writeFile(join(root, '.trace.lock'), '99999', 'utf8');

  const r = cli(['set', '2026-01-01-demo', 'topic', 'demo.changed', root]);
  assert.equal(r.code, 0, '文件已经改了，不判失败');
  assert.match(r.out, /留痕没写进去/);
  assert.match(r.out, /下次 check 会判它未受控/);
  assert.match(r.out, /trace --adopt/);
});
