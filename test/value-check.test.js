import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkValue } from '../src/core/value-check.js';

/**
 * 数值校验：value 里写的那个数，必须能在引文里找到。
 *
 * 只对 basis=条目 生效——实测的数来自 runs 输出，判断的数是算的，
 * 对它们要求「原文有」等于要求推算结果凭空出现。
 */

const base = {
  claim: '欧盟修订指令把 PM2.5 年均限值定到 10 μg/m³，2030 年起才需达标',
  value: { metric: 'pm25.annual', number: 10, unit: 'μg/m³' },
  basis: '条目',
  quotes: ['限值定为 10 μg/m³，2030-01-01 起适用'],
  snapshotText: '限值定为 10 μg/m³，2030-01-01 起适用',
};

test('数值在引文里：通过', () => {
  assert.equal(checkValue(base).ok, true);
});

test('引文没包含、但原文有：引文选窄了', () => {
  const r = checkValue({
    ...base,
    quotes: ['Limit values to be attained by 1 January 2030.'],
    snapshotText: 'Annex: PM2.5 annual limit value 10 μg/m³. Limit values to be attained by 1 January 2030.',
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'quote_too_narrow');
});

test('引文和原文都没有：数字来源不明', () => {
  const r = checkValue({
    ...base,
    value: { number: 1250 },
    quotes: ['样本数由脚本参数决定'],
    snapshotText: '样本数由脚本参数决定',
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'number_without_source');
});

test('判断档不查：推出来的数本来就不在原文里', () => {
  const r = checkValue({
    ...base,
    basis: '判断',
    value: { number: 19.5893 },
    quotes: ['原文里没有这个数'],
    snapshotText: '原文里没有这个数',
  });
  assert.equal(r.checked, false);
  assert.equal(r.ok, true);
});

test('实测档不查：数字在 runs 的输出里，不在这里', () => {
  const r = checkValue({ ...base, basis: '实测', value: { number: 18.9253 } });
  assert.equal(r.checked, false);
});

test('短数字不能假命中：10 不该匹配 1049', () => {
  const r = checkValue({
    ...base,
    quotes: ['B - 1049 Brussels'],
    snapshotText: 'B - 1049 Brussels',
  });
  assert.equal(r.ok, false, '1049 里的 10 不算');
});

test('35 不该匹配 350', () => {
  const r = checkValue({
    ...base,
    value: { number: 35 },
    quotes: ['350 个样本'],
    snapshotText: '350 个样本',
  });
  assert.equal(r.ok, false);
});

test('35 和 35.0 是同一个数', () => {
  const r = checkValue({
    ...base,
    value: { number: 35 },
    quotes: ['限值 35.0 μg/m³'],
    snapshotText: '限值 35.0 μg/m³',
  });
  assert.equal(r.ok, true);
});

test('没有 value 就不查', () => {
  assert.equal(checkValue({ ...base, value: undefined }).checked, false);
});

test('没有引文的条目不重复报（形状检查会拦）', () => {
  const r = checkValue({ ...base, quotes: [] });
  assert.equal(r.checked, false);
});
