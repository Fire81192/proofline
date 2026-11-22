import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditDir } from '../src/audit.js';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'proofline-audit-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, text, 'utf8');
  }
  return dir;
}

const kinds = (r) => r.findings.map((f) => f.kind);

test('干净文本不报任何东西', async () => {
  const dir = await fixture({ 'a.md': '这是一段普通笔记，没有敏感内容。' });
  const r = await auditDir(dir);
  assert.deepEqual(r.findings, []);
});

test('Windows 盘符路径能查到', async () => {
  const dir = await fixture({ 'a.md': '原件在 D:/data/ppg.csv 这里' });  // audit-ignore 测试夹具
  const r = await auditDir(dir);
  assert.ok(kinds(r).includes('abs-path'));
  assert.match(r.findings[0].samples[0], /D:\/data\/ppg\.csv/);  // audit-ignore 正则字面量
});

test('网址不能被当成盘符（https:// 里的 s:/）', async () => {
  const dir = await fixture({ 'a.md': '见 https://github.com/x/y 和 http://a.b/c' });
  const r = await auditDir(dir);
  assert.deepEqual(r.findings, [], 'URL 不是本机路径');
});

test('Linux 家目录路径也算', async () => {
  const dir = await fixture({ 'a.md': 'path: /home/alice/data' });  // audit-ignore 测试夹具
  const r = await auditDir(dir);
  assert.ok(kinds(r).includes('abs-path'));
});

test('邮箱能查到，且能给出样本', async () => {
  const dir = await fixture({ 'notes/s.txt': '联系 someone@example.com 或 other@example.org' });  // audit-ignore 测试夹具
  const r = await auditDir(dir);
  const f = r.findings.find((x) => x.kind === 'email');
  assert.ok(f);
  assert.equal(f.count, 2);
  assert.equal(f.samples.length, 2);
});

test('原文快照默认不扫：对着一份不能改的东西报邮箱，只会训练人忽略报告', async () => {
  const dir = await fixture({ 'raw/s.txt': '联系 someone@example.com' });  // audit-ignore 测试夹具
  let r = await auditDir(dir);
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.skippedRaw, 1);

  // 要查还是能查，但要显式要求
  r = await auditDir(dir, { includeRaw: true });
  assert.ok(r.findings.some((x) => x.kind === 'email'));
});

test('占位符路径不算泄漏：C:\\Users\\<用户名> 是模板，不是本机路径', async () => {
  const dir = await fixture({
    'doc.md': '把 C:\\Users\\<用户名>\\out 换成你自己的路径；示例 D:/... 也一样',
  });  // audit-ignore 测试夹具
  const r = await auditDir(dir);
  assert.deepEqual(r.findings, [], '带 < > { } 或 ... 的是模板');
});

test('豁免要报数：0 命中如果来自豁免，那个 0 是假的', async () => {
  const dir = await fixture({
    'a.md': '本机路径 D:/real/data.csv  # audit-ignore 故意豁免\n另一行没有敏感内容',
  });  // audit-ignore 测试夹具
  const r = await auditDir(dir);
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.ignoredLines, 1);
});

test('手机号能查到', async () => {
  const dir = await fixture({ 'a.md': '电话 13812345678' });  // audit-ignore 测试用假号
  const r = await auditDir(dir);
  assert.ok(kinds(r).includes('phone'));
});

test('身份证号能查到，且排在手机号前面', async () => {
  const dir = await fixture({
    'a.md': '手机 13812345678',  // audit-ignore 测试用假号
    'b.md': '证件 11010519491231002X',  // audit-ignore 测试用假号
  });
  const r = await auditDir(dir);
  assert.equal(r.findings[0].kind, 'id-number', '最敏感的排最前');
});

test('只扫文本类文件，跳过 node_modules', async () => {
  const dir = await fixture({
    'node_modules/x/a.md': 'D:/secret/path',  // audit-ignore 夹具
    'ok.md': '干净',
  });
  const r = await auditDir(dir);
  assert.equal(r.stats.files, 1);
  assert.deepEqual(r.findings, []);
});
