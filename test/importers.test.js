import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromAgentero, fromCodeDir } from '../src/importers.js';

async function makePaper(meta, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-paper-'));
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(meta), 'utf8');
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  return dir;
}

test('OCR 来源：映射成 OCR，补 source_original，质量为 low 时加一条不阻塞的缺口', async () => {
  const dir = await makePaper(
    { id: 'p1', title: '某论文', body_source: 'ocr', body_quality: 'low' },
    { 'PAPER.md': '正文 数据 被 OCR 断开了。' },
  );
  const spec = await fromAgentero(dir);

  assert.equal(spec.source_extraction, 'OCR');
  assert.ok(spec.source_original, 'OCR 是二手，必须给原件位置');
  assert.equal(spec.snapshot_text, '正文 数据 被 OCR 断开了。');
  assert.equal(spec.gaps.length, 1, 'low 质量应当留一条待核');
  assert.equal(spec.gaps[0].blocking, false, '这是提醒，不是阻塞');
  assert.equal(spec.gaps[0].action, 'fetch');
});

test('LaTeX 来源：没有 PAPER.md 时拼 source/*.tex，且算「原文」', async () => {
  const dir = await makePaper(
    { id: '1706', title: 'Attention', body_source: 'latex', body_quality: 'high' },
    {
      'source/introduction.tex': 'We propose the Transformer model.\n',
      'source/background.tex': 'Recurrent models are sequential.\n',
    },
  );
  const spec = await fromAgentero(dir);

  assert.equal(spec.source_extraction, '原文');
  assert.equal(spec.source_original, undefined, '原文不需要再给原件');
  assert.match(spec.snapshot_text, /%% file: background\.tex/);
  assert.match(spec.snapshot_text, /%% file: introduction\.tex/);
  assert.ok(
    spec.snapshot_text.indexOf('background.tex') < spec.snapshot_text.indexOf('introduction.tex'),
    '文件应当按名字排序拼接，保证可复现',
  );
  assert.ok(spec.gaps.some((g) => g.question.includes('cite')), '要提醒 LaTeX 命令会打断引文');
});

test('metadata 缺失时给出明确错误，而不是抛底层异常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-empty-'));
  await assert.rejects(() => fromAgentero(dir), /metadata\.json/);
});

test('既没有 PAPER.md 也没有 tex，明确说不出来', async () => {
  const dir = await makePaper({ id: 'p2', body_source: 'pdf' }, {});
  await assert.rejects(() => fromAgentero(dir), /PAPER\.md/);
});

test('source_uri 用正斜杠，换平台也能读', async () => {
  const dir = await makePaper(
    { id: 'p3', body_source: 'ocr' },
    { 'PAPER.md': '随便一句正文内容。' },
  );
  const spec = await fromAgentero(dir);
  assert.ok(!spec.source_uri.includes('\\'), `不该有反斜杠：${spec.source_uri}`);
});

test('body_source 是数组时不再被 String() 强转蒙混', async () => {
  const dir = await makePaper(
    { id: 'p9', body_source: ['pdf'], body_quality: 'high' },
    { 'PAPER.md': '正文内容。' },
  );
  const spec = await fromAgentero(dir);
  assert.equal(spec.source_extraction, undefined, '类型不符就不该映射');
  assert.ok(spec._meta.issues.some((i) => i.includes('body_source')));
});

test('metadata.id 带路径分隔符时退回目录名，不能穿出论文目录', async () => {
  const dir = await makePaper(
    { id: '../../outside', body_source: 'ocr' },
    { 'PAPER.md': '正文内容。' },
  );
  const spec = await fromAgentero(dir);
  assert.ok(!spec.source_uri.includes('..'), `不该含 ..：${spec.source_uri}`);
  assert.ok(spec._meta.issues.some((i) => i.includes('不能用作文件名')));
});

test('_meta 不可枚举：展开和序列化都不会带进 frontmatter', async () => {
  const dir = await makePaper({ id: 'p10', body_source: 'ocr' }, { 'PAPER.md': '正文。' });
  const spec = await fromAgentero(dir);
  assert.deepEqual(Object.keys(spec).includes('_meta'), false);
  assert.equal(JSON.stringify(spec).includes('_meta'), false);
});

test('tex 排序是数字感知的（1,2,10 而不是 1,10,2）', async () => {
  const dir = await makePaper(
    { id: 'p11', body_source: 'latex' },
    { 'source/1.tex': 'A', 'source/2.tex': 'B', 'source/10.tex': 'C' },
  );
  const spec = await fromAgentero(dir);
  const first = spec.snapshot_text.indexOf('%% file: 2.tex');
  const second = spec.snapshot_text.indexOf('%% file: 10.tex');
  assert.ok(first < second, '2.tex 应排在 10.tex 前面');
});

test('写进条目的定位信息不含本机目录（原文是机器相关的，条目要能分享）', async () => {
  const dir = await makePaper(
    { id: 'p12', type: 'pdf', body_source: 'ocr', body_quality: 'low' },
    { 'PAPER.md': '正文。' },
  );
  const spec = await fromAgentero(dir);
  assert.ok(!spec.source_uri.includes('/'), `source_uri 不该是路径：${spec.source_uri}`);
  assert.ok(!String(spec.source_original).includes('/'), `source_original 不该是路径：${spec.source_original}`);
  for (const g of spec.gaps) {
    assert.ok(!String(g.locator ?? '').includes('/'), `gap.locator 不该是路径：${g.locator}`);
  }
});

test('arXiv 类型用公开地址当 source_uri', async () => {
  const dir = await makePaper({ id: '1706.03762', type: 'arxiv', body_source: 'latex' }, {
    'source/a.tex': 'x',
  });
  const spec = await fromAgentero(dir);
  assert.equal(spec.source_uri, 'https://arxiv.org/abs/1706.03762');
});

// ---------------------------------------------------------------- 从代码目录入库

async function makeCode(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-code-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  return dir;
}

test('代码目录：收源码与依赖清单，标成「项目 / 原文」', async () => {
  const dir = await makeCode({
    'train.py': 'import numpy as np\n',
    'requirements.txt': 'numpy==1.26.0\n',
    'README.md': '不该收的（不是依赖清单）',
  });
  const spec = await fromCodeDir(dir, { url: 'https://github.com/x/y' });

  assert.equal(spec.source_uri, 'https://github.com/x/y');
  assert.equal(spec.source_kind, '项目');
  assert.equal(spec.source_extraction, '原文');
  assert.match(spec.snapshot_text, /%% file: train\.py/);
  assert.match(spec.snapshot_text, /%% file: requirements\.txt/);
  assert.ok(!spec.snapshot_text.includes('README'), 'README 不是源码也不是依赖清单');
});

test('代码目录：跳过依赖与缓存目录，不进快照', async () => {
  const dir = await makeCode({
    'app/main.py': 'x = 1\n',
    'node_modules/lib/index.js': 'should not appear\n',
    '.git/config': 'should not appear\n',
    '__pycache__/x.pyc': 'binary-ish\n',
  });
  const spec = await fromCodeDir(dir);
  assert.match(spec.snapshot_text, /app\/main\.py/);
  for (const bad of ['node_modules', '.git', '__pycache__']) {
    assert.ok(!spec.snapshot_text.includes(bad), `${bad} 不该进快照`);
  }
});

test('代码目录：超大文件跳过并记下来（不许静默假装读过）', async () => {
  const big = 'x'.repeat(600 * 1024);
  const dir = await makeCode({ 'huge.py': big, 'small.py': 'y = 2\n' });
  const spec = await fromCodeDir(dir);

  assert.ok(!spec.snapshot_text.includes(big.slice(0, 100)), '超大文件不该收');
  assert.ok(spec._meta.skipped.some((s) => s.path === 'huge.py'), '跳过要记账');
  assert.ok(spec._meta.issues.some((i) => i.includes('huge.py')));
});

test('代码目录：按数字感知排序（2 在 10 前面）', async () => {
  const dir = await makeCode({ '1.py': 'A', '2.py': 'B', '10.py': 'C' });
  const spec = await fromCodeDir(dir);
  const a = spec.snapshot_text.indexOf('%% file: 2.py');
  const b = spec.snapshot_text.indexOf('%% file: 10.py');
  assert.ok(a > 0 && b > 0 && a < b, '2.py 应排在 10.py 之前');
});

test('代码目录：没有可收的文件 -> 明确报错，不是建个空条目', async () => {
  const dir = await makeCode({ 'notes.txt': '只有说明' });
  await assert.rejects(() => fromCodeDir(dir), /没有可收的源码/);
});

test('代码目录：没收 url 时用 code:<目录名> 兜底', async () => {
  const dir = await makeCode({ 'a.py': 'pass\n' });
  const spec = await fromCodeDir(dir);
  assert.match(spec.source_uri, /^code:/);
});

test('代码快照的 spec 里不留无用字段（否则 createEntry 会报「这些字段没被使用」）', async () => {
  const dir = await makeCode({ 'a.py': 'pass\n' });
  const spec = await fromCodeDir(dir);
  assert.equal('body_quality' in spec, false, 'body_quality 只该在 _meta 里');
});
