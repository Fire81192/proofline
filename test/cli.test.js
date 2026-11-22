import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendTrace } from '../src/core/trace.js';
import { contentHash } from '../src/core/store.js';
import { joinFrontmatter } from '../src/core/frontmatter.js';
import { KEY_ORDER } from '../src/core/schema.js';

/**
 * CLI 层测试。
 *
 * 存在的理由：cli.js 有 698 行、11 个命令，是 agent 接触这个工具的唯一接口。
 * 之前只有 4 条用例，结果「set 崩溃」「撞 id 覆盖快照」「log --json 退化成文本」
 * 这类跑一次就露的问题，全在模块测试全绿的情况下活着。
 *
 * 接口层的 bug 只能靠接口层的测试抓。
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pl-cli-'));
  const root = join(dir, 'entries');
  await mkdir(root, { recursive: true });
  return { dir, root };
}

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** 造一条合法条目。overrides 里给 undefined 表示删掉该字段。 */
async function addEntry(root, id, { snapshot = 'hello world', ...overrides } = {}) {
  const dir = join(root, id);
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'raw', 'source.txt'), snapshot, 'utf8');

  const data = {
    schema: 1,
    id,
    claim: '这是一条测试用的主张，够长了',
    kind: '方法',
    layer: '线索',
    basis: '条目',
    source_kind: '文章',
    source_extraction: '原文',
    source_sha256: sha256(snapshot),
    evidence_status: 'supported',
    world_status: 'unresolved',
    quotes: ['hello world'],
    added_at: '2026-11-21',
    ...overrides,
  };

  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  // 用正式写入器生成，保证字段顺序与引号规则和工具一致；
  // 手写 JSON.stringify 会让 kind 变成 "方法"，被判成格式不规范。
  const text = joinFrontmatter(data, '', KEY_ORDER);
  await writeFile(join(dir, 'entry.md'), text, 'utf8');
  // 夹具也要留痕：status 把「没有入库记录」当未受控，未受控一律不给引用。
  // 手造条目却不造记录，测的就不是「status 的判断」，而是「status 对无留痕条目的态度」。
  await appendTrace(root, { op: 'create', id, after: contentHash(text) });
  return dir;
}

async function paperDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pl-paper-'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({
    id: '1706.03762',
    title: 'Attention Is All You Need',
    authors: ['A'],
    body_source: 'latex',
    body_quality: 'high',
  }), 'utf8');
  await mkdir(join(dir, 'source'), { recursive: true });
  await writeFile(
    join(dir, 'source', 'introduction.tex'),
    'In this work we propose the Transformer, a model architecture eschewing recurrence.\n',
    'utf8',
  );
  return dir;
}

// ---------------------------------------------------------------- 用法与退出码

test('无参数 -> 用法，exit 2', () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /用法/);
});

test('未知命令 -> exit 2', () => {
  assert.equal(run(['whatever']).code, 2);
});

test('未知参数 -> exit 2（不是 1）', () => {
  assert.equal(run(['check', '--nope']).code, 2);
});

test('缺参数 -> exit 2', () => {
  assert.equal(run(['status']).code, 2);
});

test('fields / rules 能列出内容且 exit 0', () => {
  assert.match(run(['fields']).stdout, /source_sha256/);
  assert.match(run(['rules']).stdout, /destructive-cleanup/);
});

// ---------------------------------------------------------------- check

test('check：全合规 exit 0', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pass=1/);
});

test('check：脏条目 exit 1 并列出修复项', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { added_at: '2026-1-5' });
  const r = run(['check', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /dirty/);
});

test('check --fix：写回后复验通过，第二次 exit 0', async () => {
  const { root } = await workspace();
  const dir = await addEntry(root, '2026-11-21-a', { added_at: '2026-1-5' });
  assert.equal(run(['check', root, '--fix']).code, 0);
  assert.match(await readFile(join(dir, 'entry.md'), 'utf8'), /2026-01-05/);
  assert.equal(run(['check', root]).code, 0);
});

test('check：hard_fail exit 1 并给出原因', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { claim: '太短' });
  const r = run(['check', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /hard/);
});

test('check：目录不存在 exit 2（不是「0 条、干净」）', () => {
  assert.equal(run(['check', 'no-such-dir']).code, 2);
});

// ---------------------------------------------------------------- status

test('status：找不到条目 exit 2', async () => {
  const { root } = await workspace();
  assert.equal(run(['status', '2026-11-21-none', root]).code, 2);
});

test('status：合规条目输出可引用，并带版本号', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['status', '2026-11-21-a', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /能引用\s+是/);
  assert.match(r.stdout, /版本\s+[0-9a-f]{16}/);
});

test('status：形状不合规时明说「结论都不算数」', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { layer: undefined });
  const r = run(['status', '2026-11-21-a', root]);
  assert.match(r.stdout, /形状\s+不合规/);
});

test('status：frontmatter 坏掉时不崩，exit 1 并说清原因', async () => {
  const { root } = await workspace();
  const dir = await addEntry(root, '2026-11-21-a');
  await writeFile(join(dir, 'entry.md'), '---\n坏行没有冒号\n---\n', 'utf8');
  const r = run(['status', '2026-11-21-a', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /解析失败/);
  assert.ok(!/内部错误/.test(r.stderr));
});

// ---------------------------------------------------------------- index

test('index：生成 INDEX.md 并标出可判定', async () => {
  const { root } = await workspace();
  const snap = '另一份独立来源写的同一件事';
  await addEntry(root, '2026-11-21-a', {
    layer: '标准',
    world_status: 'supported',
    // 声明上能下判断，按规则必须写 not_for——这是夹具，给一句就行。
    not_for: ['不能说这件事已经没有争议了——只有一份佐证'],
    corroborations: [{ uri: 'https://x', sha256: sha256(snap), snapshot: 'raw/verify-1.txt', quote: snap }],
  });
  const dir = join(root, '2026-11-21-a');
  await writeFile(join(dir, 'raw', 'verify-1.txt'), snap, 'utf8');

  assert.equal(run(['index', root]).code, 0);
  assert.match(await readFile(join(root, 'INDEX.md'), 'utf8'), /可判定/);
});

test('index：形状废的条目不标「可引用」', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { kind: undefined });
  assert.equal(run(['index', root]).code, 0);
  assert.match(await readFile(join(root, 'INDEX.md'), 'utf8'), /形状废/);
});

test('index：坏 frontmatter 只坏一条，不拖垮整个索引', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-good');
  const bad = await addEntry(root, '2026-11-21-bad');
  await writeFile(join(bad, 'entry.md'), '---\n坏行\n---\n', 'utf8');
  const r = run(['index', root]);
  assert.equal(r.code, 0);
  const md = await readFile(join(root, 'INDEX.md'), 'utf8');
  assert.match(md, /解析失败/);
  assert.match(md, /2026-11-21-good/);
});

test('index：目录不存在 exit 2，且不创建目录', async () => {
  const { dir } = await workspace();
  const missing = join(dir, 'typo');
  assert.equal(run(['index', missing]).code, 2);
  assert.equal(await exists(missing), false);
});

// ---------------------------------------------------------------- new

test('new：正常建条目 exit 0', async () => {
  const { dir, root } = await workspace();
  const src = join(dir, 'src.txt');
  await writeFile(src, '原文一段话内容', 'utf8');
  const spec = join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    claim: '这是一条测试主张，长度足够',
    kind: '方法',
    layer: '线索',
    basis: '条目',
    source_kind: '文章',
    source_extraction: '原文',
    evidence_status: 'supported',
    world_status: 'unresolved',
    quotes: ['原文一段话内容'],
    snapshot_from: src,
  }), 'utf8');

  const r = run(['new', '2026-11-21-new', '--spec', spec, root]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(await exists(join(root, '2026-11-21-new', 'entry.md')), true);
});

test('new：撞已有 id 返回 exists，且不碰原快照', async () => {
  const { dir, root } = await workspace();
  const before = await addEntry(root, '2026-11-21-dup', { snapshot: '原始证据' });
  const src = join(dir, 'new.txt');
  await writeFile(src, '新证据', 'utf8');
  const spec = join(dir, 'spec.json');
  await writeFile(spec, JSON.stringify({
    claim: '另一条主张，长度也够',
    kind: '方法',
    layer: '线索',
    basis: '条目',
    source_kind: '文章',
    source_extraction: '原文',
    quotes: ['新证据'],
    snapshot_from: src,
  }), 'utf8');

  const r = run(['new', '2026-11-21-dup', '--spec', spec, root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /exists/);
  assert.equal(await readFile(join(before, 'raw', 'source.txt'), 'utf8'), '原始证据');
});

test('new：spec 读不到 exit 2', async () => {
  const { root } = await workspace();
  assert.equal(run(['new', '2026-11-21-x', '--spec', '/no/such.json', root]).code, 2);
});

// ---------------------------------------------------------------- import

test('import：能导入，并警告没用 --evidence / --kind / --layer', async () => {
  const { root } = await workspace();
  const paper = await paperDir();
  const r = run([
    'import', '2026-11-21-imp', '--paper', paper,
    '--claim', 'Transformer 只靠注意力建立全局依赖',
    '--quote', 'In this work we propose the Transformer, a model architecture eschewing recurrence.',
    root,
  ]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /unresolved/);
  assert.match(r.stdout, /--kind/);
  assert.match(r.stdout, /--layer/);
});

test('import：论文目录缺 metadata.json -> exit 2', async () => {
  const { dir, root } = await workspace();
  assert.equal(run(['import', '2026-11-21-z', '--paper', dir, '--claim', '一句话主张够长了', '--quote', 'x', root]).code, 2);
});

// ---------------------------------------------------------------- corroborate / set

test('corroborate + set：加佐证后可以把世界维度改成 supported', async () => {
  const { dir, root } = await workspace();
  await addEntry(root, '2026-11-21-c');
  const src = join(dir, 'corr.txt');
  await writeFile(src, '另一份独立实现也这么说', 'utf8');

  const c = run(['corroborate', '2026-11-21-c', '--source', src, '--uri', 'https://x', '--quote', '另一份独立实现也这么说', root]);
  assert.equal(c.code, 0, c.stdout);

  const s = run(['set', '2026-11-21-c', 'world_status', 'supported', root]);
  assert.equal(s.code, 0, s.stdout);

  // 两类依据分开报：独立来源 / 实测。这里只有佐证，所以不出现「实测」。
  assert.match(run(['status', '2026-11-21-c', root]).stdout, /世界佐证\s+独立来源 1\/1/);
});

test('set：没佐证就写 supported 会被拒，且不崩', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-c');
  const r = run(['set', '2026-11-21-c', 'world_status', 'supported', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /拒绝写入/);
  assert.ok(!/ReferenceError/.test(r.stderr));
});

test('set：找不到条目 exit 2', async () => {
  const { root } = await workspace();
  assert.equal(run(['set', '2026-11-21-none', 'layer', '标准', root]).code, 2);
});

// ---------------------------------------------------------------- advise / scan

test('advise：输出决策并区分正文与不说', async () => {
  const { dir, root } = await workspace();
  const cand = join(dir, 'cand.json');
  await writeFile(cand, JSON.stringify([
    { key: 'a', level: '失真', cost: 'high', reversible: true, action: '改成按时间切' },
    { key: 'b', level: '偏好', cost: 'low', reversible: true, action: '改命名' },
  ]), 'utf8');

  const r = run(['advise', '--project', 'p', '--candidates', cand, root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[正文\]/);
  assert.match(r.stdout, /\[不说\]/);
});

test('advise：--json 是单个合法数组', async () => {
  const { dir, root } = await workspace();
  const cand = join(dir, 'cand.json');
  await writeFile(cand, JSON.stringify([{ key: 'a', level: '失真', cost: 'high', reversible: true, action: 'x' }]), 'utf8');
  const r = run(['advise', '--project', 'p', '--candidates', cand, '--json', root]);
  assert.ok(Array.isArray(JSON.parse(r.stdout)));
});

test('advise：candidates 不是数组 -> exit 2', async () => {
  const { dir, root } = await workspace();
  const cand = join(dir, 'cand.json');
  await writeFile(cand, JSON.stringify({ not: 'array' }), 'utf8');
  assert.equal(run(['advise', '--project', 'p', '--candidates', cand, root]).code, 2);
});

test('scan：命中规则，并在 --advise 下给出决策', async () => {
  const { dir, root } = await workspace();
  const proj = join(dir, 'proj');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'a.py'), 'b, a = butter(2, 0.1)\ny = lfilter(b, a, x)\n', 'utf8');

  const r = run(['scan', proj, '--project', 'p', '--advise', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /filter-phase-shift/);
  assert.match(r.stdout, /该不该说/);
});

test('scan --json --advise：单个合法 JSON（不是两段拼接）', async () => {
  const { dir, root } = await workspace();
  const proj = join(dir, 'proj');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'a.py'), 'rm -rf ./build\n', 'utf8');

  const parsed = JSON.parse(run(['scan', proj, '--project', 'p', '--advise', '--json', root]).stdout);
  assert.ok(Array.isArray(parsed.candidates));
  assert.ok(Array.isArray(parsed.decisions));
});

test('scan：--commit 不带 --advise 也会记账（隐含关系）', async () => {
  const { dir, root } = await workspace();
  const proj = join(dir, 'proj');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'a.py'), 'rm -rf ./build\n', 'utf8');

  const r = run(['scan', proj, '--project', 'p', '--commit', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /已记账/);
});

test('scan：目录不存在 exit 2', async () => {
  const { root } = await workspace();
  assert.equal(run(['scan', 'no-such-dir', '--project', 'p', root]).code, 2);
});

// ---------------------------------------------------------------- log

test('log：空项目 --json 也是 JSON', async () => {
  const { root } = await workspace();
  const r = run(['log', 'nothing', '--json', root]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).records, 0);
});

test('log：有记录时重放出状态', async () => {
  const { dir, root } = await workspace();
  const cand = join(dir, 'cand.json');
  await writeFile(cand, JSON.stringify([{ key: 'a', level: '失真', cost: 'high', reversible: true, action: 'x' }]), 'utf8');
  run(['advise', '--project', 'p', '--candidates', cand, '--commit', root]);

  const r = run(['log', 'p', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /项目 p/);
});

// ---------------------------------------------------------------- audit

test('audit：干净目录无命中，--strict exit 0', async () => {
  const { dir } = await workspace();
  await writeFile(join(dir, 'clean.md'), '普通笔记，没有敏感内容。', 'utf8');
  const r = run(['audit', dir, '--strict']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有发现/);
});

test('audit：命中邮箱时 --strict exit 1', async () => {
  const { dir } = await workspace();
  await writeFile(join(dir, 'a.md'), '联系 someone@example.com', 'utf8');  // audit-ignore 夹具
  const r = run(['audit', dir, '--strict']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /邮箱/);
});

test('audit：--json 输出可解析且带 complete 标记', async () => {
  const { dir } = await workspace();
  await writeFile(join(dir, 'a.md'), '干净', 'utf8');
  const parsed = JSON.parse(run(['audit', dir, '--json']).stdout);
  assert.ok(Array.isArray(parsed.findings));
  assert.equal(parsed.stats.complete, true);
});

test('audit：目录不存在 exit 2', () => {
  assert.equal(run(['audit', 'no-such-dir']).code, 2);
});

test('corroborate：提交失败时不留孤儿快照', async () => {
  const { dir, root } = await workspace();
  await addEntry(root, '2026-11-21-o');
  const src = join(dir, 'bad.txt');
  await writeFile(src, '这份文件里没有那句话', 'utf8');

  // 引文在佐证快照里定位不到 -> 校验失败 -> 刚写的 verify-1.txt 必须被清掉
  const r = run(['corroborate', '2026-11-21-o', '--source', src, '--uri', 'https://x', '--quote', '根本不存在的一句', root]);
  assert.equal(r.code, 1);
  assert.equal(await exists(join(root, '2026-11-21-o', 'raw', 'verify-1.txt')), false, '孤儿快照会污染审计');
});

test('status：有 boxes.json 时显示原件定位', async () => {
  const { root } = await workspace();
  const dir = await addEntry(root, '2026-11-21-b');
  await writeFile(join(dir, 'raw', 'boxes.json'), JSON.stringify({
    pdf: 'x.pdf',
    boxes: [{ quote: 'hello world', found: { page: 3, page_count: 9, bbox: { x0: 1, top: 2, x1: 3, bottom: 4 }, lines_spanned: 1 } }],
  }), 'utf8');

  const r = run(['status', '2026-11-21-b', root]);
  assert.match(r.stdout, /原件定位\s+全部命中/);
  assert.match(r.stdout, /p3\/9/);
});

test('scan：非 --advise 的 --json 只含 candidates', async () => {
  const { dir, root } = await workspace();
  const proj = join(dir, 'proj');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'a.py'), 'rm -rf ./build\n', 'utf8');

  const parsed = JSON.parse(run(['scan', proj, '--project', 'p', '--json', root]).stdout);
  assert.ok(Array.isArray(parsed.candidates));
  assert.equal(parsed.decisions, undefined, '没要判定就不该塞判定');
});

// ---------------------------------------------------------------- 来源与证据册

test('sources：按来源汇总，标出各自支撑几条', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  await addEntry(root, '2026-11-21-b', { source_uri: '论文甲' });
  const r = run(['sources', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /2 个来源|1 个来源/);
  assert.match(r.stdout, /论文甲/);
  // 文案从「支撑 N 条」改成「条目 N 条」：退役的条目不支撑任何东西，
  // 用「支撑」会高估这个来源的分量。
  assert.match(r.stdout, /条目 2 条/);
});

test('deprecate 不带 --confirm：只算后果，一个字都不改', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  const r = run(['deprecate', '论文甲', '--reason', '测试', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有改动任何东西/);
  assert.equal(await exists(join(root, '.sources.json')), false);
});

test('deprecate --confirm 缺理由 -> 拒绝', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  const r = run(['deprecate', '论文甲', '--confirm', root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /必须给理由/);
});

test('deprecate --confirm：来源下面所有条目降级，restore 能撤回', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });

  assert.equal(run(['deprecate', '论文甲', '--reason', '勘误过', '--confirm', root]).code, 0);
  assert.match(run(['status', '2026-11-21-a', root]).stdout, /能引用\s+否/);

  assert.equal(run(['restore', '论文甲', root]).code, 0);
  assert.match(run(['status', '2026-11-21-a', root]).stdout, /能引用\s+是/);
});

test('deprecate 找不到来源 -> exit 2 并列出可选项', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  const r = run(['deprecate', '不存在的来源', root]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /现有来源/);
});

test('view：生成只读证据册，含主张与来源，且没有脚本', async () => {
  const { dir, root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  const out = join(dir, 'view.html');
  const r = run(['view', root, '--out', out]);
  assert.equal(r.code, 0, r.stdout);

  const html = await readFile(out, 'utf8');
  assert.match(html, /证据册/);
  assert.match(html, /论文甲/);
  assert.match(html, /这是一条测试用的主张/);
  assert.ok(!/<script/i.test(html), '页面不该有脚本——展开靠 details');
});

test('view：有条目前置关系时，页面里能看到「前置」', async () => {
  const { dir, root } = await workspace();
  await addEntry(root, '2026-11-21-base', { source_uri: '论文甲' });
  await addEntry(root, '2026-11-21-next', { source_uri: '论文甲', prereq: ['2026-11-21-base'] });

  const out = join(dir, 'v2.html');
  assert.equal(run(['view', root, '--out', out]).code, 0);
  assert.match(await readFile(out, 'utf8'), /前置/);
});

test('view：知识地图按前置关系展开，孤点单独成区', async () => {
  const { dir, root } = await workspace();
  await addEntry(root, '2026-11-21-a', { source_uri: '论文甲' });
  await addEntry(root, '2026-11-21-b', { source_uri: '论文甲', prereq: ['2026-11-21-a'] });
  await addEntry(root, '2026-11-21-c', { source_uri: '论文甲' });

  const out = join(dir, 'map.html');
  assert.equal(run(['view', root, '--out', out]).code, 0);
  const html = await readFile(out, 'utf8');
  assert.match(html, /知识地图/);
  assert.match(html, /还没接线/, 'c 没有前置也没人依赖，必须单列出来');
  assert.ok(!/<script/i.test(html));
});

// ---------------------------------------------------------------- 同话题并排

test('review：同 topic 的条目并排出现', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { topic: 'ppg.preprocess', claim: '预处理要滤波' });
  await addEntry(root, '2026-11-21-b', { topic: 'ppg.preprocess', claim: '端到端不需要切拍' });

  const r = run(['review', root]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /ppg\.preprocess\s+2 条/);
  assert.match(r.stdout, /预处理要滤波/);
  assert.match(r.stdout, /端到端不需要切拍/);
});

test('review：层级混用时挂旗子', async () => {
  const { root } = await workspace();
  // 注意：world_status: supported 会被「必须给佐证」的规则降级成 unresolved，
  // 所以这里用层级差异来触发旗子；结论不一在 topics.test.js 里单独覆盖。
  await addEntry(root, '2026-11-21-a', { topic: 'ppg.x', layer: '标准' });
  await addEntry(root, '2026-11-21-b', { topic: 'ppg.x', layer: '线索' });

  const r = run(['review', root]);
  assert.match(r.stdout, /层级混用/);
});

test('review：指定话题过滤；不存在的话题 exit 2 并列出可选项', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { topic: 'ppg.x' });

  assert.match(run(['review', 'ppg.x', root]).stdout, /ppg\.x/);
  const miss = run(['review', '--topic', 'nope.y', root]);
  assert.equal(miss.code, 2);
  assert.match(miss.stdout, /现有话题/);
});

test('review：一个 topic 都没写时，说明白而不是空输出', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a');
  const r = run(['review', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /还没有条目写 topic/);
});

test('check：同话题不一致会提示，但不改退出码', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { topic: 'ppg.x', layer: '标准' });
  await addEntry(root, '2026-11-21-b', { topic: 'ppg.x', layer: '线索' });

  const r = run(['check', root]);
  assert.equal(r.code, 0, '数据本身没错，不该判失败');
  assert.match(r.stdout, /同话题提示/);
  assert.match(r.stdout, /层级混用/);
});

test('topic 不合规（带空格）-> hard_fail', async () => {
  const { root } = await workspace();
  await addEntry(root, '2026-11-21-a', { topic: 'ppg preprocess' });
  const r = run(['check', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /topic/);
});
