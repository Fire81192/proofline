import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rulesFromEntries } from '../src/checks.js';
import { joinFrontmatter } from '../src/core/frontmatter.js';
import { KEY_ORDER } from '../src/core/schema.js';

const entryText = (data) =>
  joinFrontmatter({ schema: 1, id: '2026-11-21-x', source_extraction: '原文', ...data }, '', KEY_ORDER);

const check = (over = {}) => ({
  type: 'pattern',
  present: 'lfilter',
  level: '偏离惯例',
  cost: 'high',
  reversible: true,
  action: '换成 filtfilt',
  ...over,
});

test('条目里的 checks 会变成规则，并带出主张与引文', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'e1',
    text: entryText({
      claim: 'lfilter 会造成相位时移',
      quotes: ['零相位滤波'],
      checks: [check()],
    }),
  }]);
  assert.equal(broken.length, 0);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].entry, 'e1');
  assert.equal(rules[0].claim, 'lfilter 会造成相位时移');
  assert.equal(rules[0].quote, '零相位滤波');
  assert.equal(rules[0].id, 'entry:e1#1');
});

test('present 命中才触发；absent 出现则整条不触发', () => {
  const { rules } = rulesFromEntries([{ id: 'e', text: entryText({ claim: '主张', checks: [check({ absent: 'filtfilt' })] }) }]);
  assert.equal(rules[0].detect('y = lfilter(b, a, x)').length, 1);
  assert.equal(rules[0].detect('y = filtfilt(b, a, x)').length, 0, 'absent 出现就该闭嘴');
  assert.equal(rules[0].detect('print(1)').length, 0);
});

test('注释里的示例不算命中', () => {
  const { rules } = rulesFromEntries([{ id: 'e', text: entryText({ claim: '主张', checks: [check()] }) }]);
  assert.equal(rules[0].detect('# y = lfilter(b, a, x)').length, 0);
});

test('正则写坏 -> 记进 broken，不让整个扫描崩', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'bad',
    text: entryText({ claim: '主张', checks: [check({ present: '(未闭合' })] }),
  }]);
  assert.equal(rules.length, 0);
  assert.equal(broken.length, 1);
  assert.match(broken[0].reason, /不是合法正则/);
});

test('type 不是 pattern -> 跳过并记账', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ type: 'ast' })] }),
  }]);
  assert.equal(rules.length, 0);
  assert.match(broken[0].reason, /类型不是 pattern/);
});

test('没有 checks 的条目不会产生规则', () => {
  const { rules } = rulesFromEntries([{ id: 'e', text: entryText({ claim: '主张' }) }]);
  assert.equal(rules.length, 0);
});

test('frontmatter 坏掉的条目跳过，不拖累别的', () => {
  const { rules, broken } = rulesFromEntries([
    { id: 'bad', text: '---\n坏行\n---\n' },
    { id: 'good', text: entryText({ claim: '主张', checks: [check()] }) },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].entry, 'bad');
});

test('多条 checks 编号递增，能追到具体哪一条', () => {
  const { rules } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check(), check({ present: 'butter' })] }),
  }]);
  assert.deepEqual(rules.map((r) => r.id), ['entry:e#1', 'entry:e#2']);
});

// ---------------------------------------------------------------- term 型

test('term：普通字符串当子串查，不按正则解释', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'e',
    text: entryText({
      claim: 'MinMaxScaler 对离群点敏感',
      checks: [check({ type: 'term', present: 'MinMaxScaler()', absent: undefined })],
    }),
  }]);
  assert.equal(broken.length, 0);
  // 如果是正则，「()」会被当空分组，'MinMaxScalerX' 也会命中。
  assert.equal(rules[0].detect('x = MinMaxScaler()').length, 1);
  assert.equal(rules[0].detect('x = MinMaxScalerX').length, 0);
  assert.equal(rules[0].detect('x = MinMaxScaler').length, 0);
});

test('term：absent 也按子串算，且 absent 一出现整条不触发', () => {
  const { rules } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ type: 'term', present: 'minmax', absent: 'quantile' })] }),
  }]);
  assert.equal(rules[0].detect('x = minmax(a)').length, 1);
  assert.equal(rules[0].detect('x = minmax(quantile(a))').length, 0);
});

test('term：非法类型仍被记进 broken，不会静默跳过', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ type: 'regexp' })] }),
  }]);
  assert.equal(rules.length, 0);
  assert.equal(broken.length, 1);
});

// ---------------------------------------------------------------- scope

test('scope：只在该扫的文件上命中', () => {
  const { rules } = rulesFromEntries([{
    id: 'e',
    text: entryText({
      claim: '预处理要用 filtfilt',
      checks: [check({ type: 'term', present: 'lfilter', absent: 'filtfilt', scope: 'preprocess|filter' })],
    }),
  }]);
  assert.equal(rules[0].detect('y = lfilter(b,a,x)', 'src/preprocess.py').length, 1);
  assert.equal(rules[0].detect('y = lfilter(b,a,x)', 'src/plot_figures.py').length, 0);
});

test('scope：拿不到文件路径时一律不命中——范围未知不能假定生效', () => {
  const { rules } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ type: 'term', present: 'lfilter', scope: 'preprocess' })] }),
  }]);
  assert.equal(rules[0].detect('y = lfilter(b,a,x)').length, 0);
});

test('scope：按正则解释，不受 type=term 的转义影响', () => {
  const { rules } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ type: 'term', present: 'a.b', scope: '^src/.*\\.py$' })] }),
  }]);
  assert.equal(rules[0].detect('x = a.b', 'src/main.py').length, 1);
  assert.equal(rules[0].detect('x = a.b', 'src/main.md').length, 0);
});

test('scope：写坏了记进 broken，不静默放过', () => {
  const { rules, broken } = rulesFromEntries([{
    id: 'e',
    text: entryText({ claim: '主张', checks: [check({ scope: '[' })] }),
  }]);
  assert.equal(rules.length, 0);
  assert.equal(broken.length, 1);
  assert.match(broken[0].reason, /scope 不是合法正则/);
});
