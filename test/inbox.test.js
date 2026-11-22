import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 收件箱。
 *
 * 它是「多一道门」，不是物理隔离——工具和 AI 用同一套文件权限。
 * 所以这里的测试只验两件事：门开着的库真的拦得住直接新建；草稿搬进来会留下记录。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const SPEC = {
  claim: '这是一条从收件箱搬进来的测试主张，够长了',
  kind: '方法',
  layer: '线索',
  basis: '条目',
  source_kind: '文章',
  source_extraction: '原文',
  snapshot_text: 'hello world',
  quotes: ['hello world'],
  source_uri: '测试来源',
};

async function project() {
  const base = await mkdtemp(join(tmpdir(), 'pl-inbox-'));
  const root = join(base, 'lib', 'entries');
  await mkdir(root, { recursive: true });
  await writeFile(join(base, 'lib', 'project.json'), JSON.stringify({ name: '测试库', domain: '测试' }, null, 2), 'utf8');
  return { base, root, inbox: join(base, 'lib', '_inbox') };
}

test('inbox 状态：只给目录时也能查（第一个参数是路径，不是动作）', async () => {
  const { root } = await project();
  const r = run(['inbox', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /收件箱：未启用/);
});

test('inbox on：new 被拦住，并且指了路', async () => {
  const { base, root } = await project();
  await writeFile(join(base, 'x.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');
  assert.equal(run(['inbox', 'on', root]).code, 0);

  const r = run(['new', '2026-11-22-a', '--spec', join(base, 'x.json'), root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /启用了收件箱：不能直接新建/);
  assert.match(r.stdout, /_inbox/);
});

test('ingest：搬进正式区、留痕、原件移到 _done', async () => {
  const { root, inbox } = await project();
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'a.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');

  const r = run(['ingest', inbox, '--into', root, '--confirm']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ 2026-11-22-a/);

  const ids = (await readdir(root)).filter((n) => n.startsWith('2026'));
  assert.deepEqual(ids, ['2026-11-22-a']);
  assert.ok((await readdir(join(inbox, '_done'))).includes('a.json'));

  const t = run(['trace', root]);
  assert.match(t.stdout, /受控 1\/1/);
});

test('ingest：坏草稿不打断其他——一个失败不影响另一个', async () => {
  const { root, inbox } = await project();
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'good.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');
  await writeFile(join(inbox, 'bad.json'), '不是 JSON', 'utf8');

  const r = run(['ingest', inbox, '--into', root, '--confirm']);
  assert.equal(r.code, 1, '有失败就返回 1');
  assert.match(r.stdout, /✓ 2026-11-22-a/);
  assert.match(r.stdout, /✗ bad\.json/);
  assert.match(r.stdout, /失败的草稿留在收件箱里/);
});

test('ingest：没有 confirm 只预览，不动任何东西', async () => {
  const { root, inbox } = await project();
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'a.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');

  const r = run(['ingest', inbox, '--into', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /能搬 1 个/);
  assert.equal((await readdir(root)).filter((n) => n.startsWith('2026')).length, 0);
  assert.ok((await readdir(inbox)).includes('a.json'));
});

test('check：启过又关掉的库会被点一句，从没启用的不吵', async () => {
  const { base, root } = await project();
  await writeFile(join(base, 'x.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');
  assert.equal(run(['new', '2026-11-22-a', '--spec', join(base, 'x.json'), root]).code, 0);

  // 从没启用过：不说话
  let r = run(['check', root]);
  assert.doesNotMatch(r.stdout, /收件箱/);

  // 开过又关：要说
  await run(['inbox', 'on', root]);
  await run(['inbox', 'off', root]);
  r = run(['check', root]);
  assert.match(r.stdout, /启用过，现在关着/);
  assert.doesNotMatch(r.stdout, /内部错误/);
});

test('doctor：说清楚物理隔离到底生效没有', async () => {
  const { base, root } = await project();
  await writeFile(join(base, 'x.json'), JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');
  await run(['new', '2026-11-22-a', '--spec', join(base, 'x.json'), root]);

  const r = run(['doctor', root]);
  assert.match(r.stdout, /正式区可写/);
  assert.match(r.stdout, /收件箱/);
  // 探针必须被清掉，不能留垃圾
  const left = (await readdir(root)).filter((n) => n.includes('probe'));
  assert.deepEqual(left, []);
  assert.ok(r.code === 0 || r.code === 1);
});

test('project.json 只加 inbox，其他字段原样保留', async () => {
  const { base, root } = await project();
  await run(['inbox', 'on', root]);
  const p = JSON.parse(await readFile(join(base, 'lib', 'project.json'), 'utf8'));
  assert.equal(p.name, '测试库');
  assert.equal(p.domain, '测试');
  assert.equal(p.inbox, true);
});

test('收件箱里的草稿格式和 new --spec 相同：同一份能两处用', async () => {
  const { base, root, inbox } = await project();
  const specPath = join(base, 'same.json');
  await writeFile(specPath, JSON.stringify({ id: '2026-11-22-a', ...SPEC }), 'utf8');

  // 关着的时候用 new 建
  assert.equal(run(['new', '2026-11-22-a', '--spec', specPath, root]).code, 0);
  assert.ok((await readdir(root)).includes('2026-11-22-a'));

  // 同一份 spec 放进收件箱，换一个 id 也能搬进来
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'b.json'), JSON.stringify({ id: '2026-11-22-b', ...SPEC }), 'utf8');
  assert.equal(run(['ingest', inbox, '--into', root, '--confirm']).code, 0);
  assert.ok((await readdir(root)).includes('2026-11-22-b'));
});
