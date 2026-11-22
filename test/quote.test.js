import { test } from 'node:test';
import assert from 'node:assert/strict';

import { locateQuote, locateAll, normalize, containsValue } from '../src/core/quote.js';

test('逐字命中，偏移正确', () => {
  const hay = '前面一句。目标句子在后面。';
  const hit = locateQuote(hay, '目标句子');
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.end), '目标句子');
});

test('引文里的换行写成空格，也能定位到原文区间', () => {
  const hay = 'AA\nBB\nCC';
  const hit = locateQuote(hay, 'AA BB');
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.end), 'AA\nBB');
});

test('原文是空格、引文是换行，反过来也成立', () => {
  const hay = '第一段 第二段';
  const hit = locateQuote(hay, '第一段\n第二段');
  assert.ok(hit);
  assert.equal(hit.start, 0);
});

test('全角空格与普通空格等价', () => {
  const hay = '中文\u3000分隔';
  const hit = locateQuote(hay, '中文 分隔');
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.end), '中文\u3000分隔');
});

test('引文首尾空白被忽略', () => {
  const hay = 'abc def';
  const hit = locateQuote(hay, '  def  ');
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.end), 'def');
});

test('emoji 之后的偏移仍然能正确切片', () => {
  const hay = '🎯 打中了没有';
  const hit = locateQuote(hay, '打中了');
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.end), '打中了');
});

test('定位不到就返回 null，不抛异常', () => {
  assert.equal(locateQuote('原文里没有这句', '另一句'), null);
});

test('空引文返回 null', () => {
  assert.equal(locateQuote('随便什么', ''), null);
  assert.equal(locateQuote('随便什么', '   '), null);
});

test('多处出现时取第一处', () => {
  const hay = '重复 重复 重复';
  const hit = locateQuote(hay, '重复');
  assert.equal(hit.start, 0);
});

test('locateAll 报告每一条的结果，部分失败不算全过', () => {
  const hay = '第一句在。第二句也在。';
  const { ok, results } = locateAll(hay, ['第一句', '根本不存在的句子', '第二句']);
  assert.equal(ok, false);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[2].ok, true);
});

test('normalize 把连续空白折成一个空格并去首尾', () => {
  assert.equal(normalize('  a \n\t b  '), 'a b');
});

test('跨行引文在长文里定位（模拟真实快照）', () => {
  const hay = `Claude 对 XML 标签很敏感。
你把 prompt 分成几段，每段用不同的标签包起来，
它就不容易漏掉后面的部分。`;
  const hit = locateQuote(hay, '每段用不同的标签包起来， 它就不容易漏掉后面的部分。');
  assert.ok(hit, '跨行引文应当能定位');
  assert.ok(hay.slice(hit.start, hit.end).includes('它就不容易漏掉'));
});

test('OCR 在中文词间塞了空格，仍能定位（降级到 space-insensitive）', () => {
  const hay = '是诊断组织器官健康状态的重要参考 数据。由于传统方法存在局限';
  const hit = locateQuote(hay, '是诊断组织器官健康状态的重要参考数据');
  assert.ok(hit, '自然书写的引文不该被 OCR 空格挡住');
  assert.equal(hit.mode, 'space-insensitive');
  assert.ok(hay.slice(hit.start, hit.end).includes('重要参考'));
});

test('全角英文字母与半角等价（OCR 常见）', () => {
  const hay = 'Ｒesearch Progress of ＰＰＧ';
  const strict = locateQuote(hay, 'Ｒesearch Progress');
  assert.ok(strict);
  // 引文和原文都是全角：这是逐字命中，不该被说成「归一化后才找到」
  assert.equal(strict.mode, 'exact');

  const half = locateQuote(hay, 'Research Progress');
  assert.ok(half, '全角写成半角也应当命中');
});

test('正常命中时 mode 是 exact：不改任何字符就找到了', () => {
  const hit = locateQuote('前面一句。目标句子在后面。', '目标句子');
  assert.equal(hit.mode, 'exact');
});

test('三级从严到宽：exact → normalized → space-insensitive', () => {
  const hay = '重要参考 数据 与结论';
  assert.equal(locateQuote(hay, '重要参考').mode, 'exact');
  assert.equal(locateQuote(hay, '重要参考  数据').mode, 'normalized', '双空格靠折叠');
  assert.equal(locateQuote(hay, '重要参考数 据').mode, 'space-insensitive', '插了空格靠去空白');
  assert.equal(locateQuote(hay, '不存在的句子'), null);
});

test('去掉空白后仍找不到，才算真的没有', () => {
  assert.equal(locateQuote('完全不相干的一段话', '目标句子'), null);
});

// ---------------------------------------------------------------- 完整 token

test('containsValue：子串不算数，必须是完整 token', () => {
  const t = '{ "mae": 18.92532733578351, "neg": -1.5 }';
  assert.equal(containsValue(t, '18.92532733578351'), true);
  assert.equal(containsValue(t, '8.92532733578351'), false);
  assert.equal(containsValue(t, '.92532733578351'), false);
  assert.equal(containsValue(t, '18.9'), false);
  assert.equal(containsValue(t, '1.5'), false);
  assert.equal(containsValue(t, '-1.5'), true);
});

test('containsValue：空值一律不匹配（空串在任何文本里都「出现」）', () => {
  assert.equal(containsValue('abc', ''), false);
});

test('containsValue：版本号前缀不算匹配（两侧边界必须同一套字符）', () => {
  // 回归测试：第一版后向排除 5 个字符（含 . 和 -），前向只排除 3 个，
  // 于是 1.5.0 里找 1.5 判为匹配。而 1.5 和 1.5.0 不是同一个值。
  assert.equal(containsValue('tensorflow-gpu==1.5.0', '1.5'), false);
  assert.equal(containsValue('tensorflow-gpu==1.5.0', '1.5.0'), true);
  assert.equal(containsValue('version 2.10.1', '2.1'), false);
  assert.equal(containsValue('version 2.10.1', '2.10.1'), true);
});
