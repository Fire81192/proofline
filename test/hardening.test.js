import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEntry, SNAPSHOT } from './helpers.js';
import { auditDir } from '../src/audit.js';

/**
 * 一次外部审核抓到的八个洞，每个都先复现过才修。
 *
 * 它们有一个共同形状：**检查看起来在工作，实际对某类输入是瞎的**。
 * 所以这里的测试都按「反例」写，不按「功能」写。
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

async function fixture(files) {
  const base = await mkdtemp(join(tmpdir(), 'pl-hard-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(base, ...rel.split('/'));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, 'utf8');
  }
  return base;
}

async function lib(extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pl-hard-lib-'));
  const root = join(base, 'lib', 'entries');
  const dir = join(root, id('a'));
  await mkdir(join(dir, 'raw'), { recursive: true });
  await writeFile(join(dir, 'entry.md'), buildEntry({ id: id('a') }), 'utf8');
  await writeFile(join(dir, 'raw', 'source.txt'), SNAPSHOT, 'utf8');
  if (extra.map) {
    await writeFile(join(base, 'lib', 'knowledge-map.json'), JSON.stringify(extra.map), 'utf8');
  }
  return { base, root };
}

const mapWith = (block) => ({ version: 1, goal: 't', domains: [], points: [], blocks: [block] });

// ── 1. 字符串里的 audit-ignore 不能豁免整行

test('审计：引号里的 # audit-ignore 不是注释，不该豁免邮箱', async () => {
  const dir = await fixture({ 'x.md': 'const s = "# audit-ignore"; 联系 zhang@example.com\n' });
  const r = await auditDir(dir);
  assert.equal(r.findings.length, 1, '邮箱必须报出来');
  assert.equal(r.stats.ignoredLines, 0, '这不是一条豁免，别计数');
});

test('审计：真正的注释豁免仍然有效', async () => {
  const dir = await fixture({ 'x.py': "ZIP = 'D:/data/x.zip'  # audit-ignore 这台机器写死才能跑\n" });
  const r = await auditDir(dir);
  assert.equal(r.findings.length, 0);
  assert.equal(r.stats.ignoredLines, 1);
});

// ── 2. 没扫完不能算通过

test('审计：有文件太大没扫，--strict 必须失败', async () => {
  const dir = await fixture({ 'big.txt': 'A'.repeat(4 * 1024 * 1024 + 1) });
  const r = run(['audit', dir, '--strict', '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.stats.complete, false);
  assert.equal(r.code, 1, '「没打开」不等于「干净」');
});

// ── 3. 这个库自己的产物是 .html，必须被扫

test('审计：.html 也在扫描范围——证据册就是要发出去的东西', async () => {
  const dir = await fixture({ 'report.html': '<p>联系 zhang@example.com</p>' });
  const r = await auditDir(dir);
  assert.equal(r.findings.length, 1);
});

// ── 4. sk-proj- 这类带中缀的密钥

test('审计：sk-proj- / sk-ant- 这类带中缀的密钥要查得到', async () => {
  const dir = await fixture({
    'a.env': [
      'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYZ0123',
      'ANTHROPIC=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
    ].join('\n'),
  });
  const r = await auditDir(dir);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('secret'), 'README 承诺查密钥，就不能漏最常见的两种');

  const dir2 = await fixture({ 'b.md': '安装 sk-learn 之后就能用了' });
  const r2 = await auditDir(dir2);
  assert.equal(r2.findings.length, 0, '普通包名不该被当成密钥');
});

// ── 5. 地图里的 entries 写成数字/字符串，不能把命令搞崩

test('结构：entries 是数字时报形状错，不是内部错误', async () => {
  const { base, root } = await lib({ map: mapWith({ id: 'b', name: 'b', needs: [], entries: 42, basis: '条目', gap: '' }) });
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /entries 必须是数组/);
  assert.doesNotMatch(r.stdout, /内部错误/);
  assert.ok(base);
});

test('结构：entries 是字符串时不能逐字符迭代', async () => {
  const { root } = await lib({ map: mapWith({ id: 'b', name: 'b', needs: [], entries: id('a'), basis: '条目', gap: '' }) });
  const r = run(['check', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /entries 必须是数组/);
  assert.doesNotMatch(r.stdout, /不存在的条目：2/, '以前的 bug 是把 id 拆成一个个字符报悬空');
});

// ── 6. 地图放在 entries/ 下，check 和 map 必须认同一份

test('结构：地图放在 entries/ 下，check 不能说不存在', async () => {
  const { base, root } = await lib();
  await writeFile(join(root, 'knowledge-map.json'), JSON.stringify(mapWith({
    id: 'b', name: 'b', needs: [], entries: [id('a')], basis: '条目', gap: '',
  })), 'utf8');

  const c = run(['check', root]);
  assert.doesNotMatch(c.stdout, /没有 knowledge-map\.json/);

  const m = run(['map', root, '--out', join(base, 'lib', 'm.html')]);
  assert.equal(m.code, 0);
  assert.match(m.stdout, /已生成/);
});

// ── 7. blocks 不是数组：不能当成空数组照样写图

test('map：blocks 不是数组时不写文件', async () => {
  const { base, root } = await lib();
  await writeFile(join(base, 'lib', 'knowledge-map.json'), JSON.stringify({
    version: 1, blocks: 'oops', domains: [], points: [],
  }), 'utf8');

  const r = run(['map', root]);
  assert.equal(r.code, 1);
  await assert.rejects(stat(join(base, 'lib', '课程地图.html')));
});

// ── 8. levels: [] 不能通过

test('map：技术域 levels 是空数组要报错，别让它「先占位」', async () => {
  const { base, root } = await lib();
  await writeFile(join(base, 'lib', 'knowledge-map.json'), JSON.stringify({
    version: 1, goal: 't', points: [],
    domains: [{ id: 't', name: '技术', kind: '技术', levels: [] }],
    blocks: [{ id: 'b', name: 'b', needs: ['t'], entries: [id('a')], basis: '条目', gap: '' }],
  }), 'utf8');

  const r = run(['map', root]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /levels 是空的/);
});
