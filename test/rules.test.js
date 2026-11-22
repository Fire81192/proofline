import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RULES, ruleById } from '../src/rules.js';

const run = (id, text) => ruleById(id).detect(text);

test('规则表里每条都能给出下一步动作（否则等于白写）', () => {
  for (const r of RULES) {
    assert.ok(r.action && r.action.trim().length > 0, `${r.id} 缺 action`);
    assert.ok(r.key === undefined, 'key 由扫描层按规则 id 生成，规则本身不带 key');
  }
});

test('butter + lfilter -> 报相位失真', () => {
  const hits = run('filter-phase-shift', 'b, a = butter(4, 0.2)\ny = lfilter(b, a, x)');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('已经用了 filtfilt -> 不报（混用不算错）', () => {
  const hits = run('filter-phase-shift', 'b, a = butter(4, 0.2)\ny = filtfilt(b, a, x)\nz = lfilter(b, a, y)');
  assert.equal(hits.length, 0);
});

test('只有 lfilter 没有 IIR 设计 -> 不报（可能只是 FIR）', () => {
  assert.equal(run('filter-phase-shift', 'y = lfilter(b, a, x)').length, 0);
});

test('注释里的示例代码不算', () => {
  const hits = run('filter-phase-shift', '# 示例：y = lfilter(b, a, x)\nb = butter(2, 0.1)\ny = lfilter(b, a, x)');
  assert.equal(hits.length, 1, '只算真实调用的那一行');
  assert.equal(hits[0].line, 3);
});

test('np.random 没有 seed -> 报不可复现', () => {
  const hits = run('unseeded-random', 'x = np.random.rand(10)');
  assert.equal(hits.length, 1);
});

test('有 default_rng -> 不报', () => {
  assert.equal(run('unseeded-random', 'rng = np.random.default_rng(0)\nx = rng.random(10)').length, 0);
});

test('时序随机划分：三个条件齐了才报', () => {
  const base = 'df["timestamp"] = pd.to_datetime(df["t"])\nX_tr, X_te = train_test_split(X, y)';
  assert.equal(run('timeseries-random-split', base).length, 1);

  // 给了 shuffle=False 就不报
  assert.equal(run('timeseries-random-split', base.replace('train_test_split(X, y)', 'train_test_split(X, y, shuffle=False)')).length, 0);

  // 没有时间语义就不报（普通表格数据随机划分是对的）
  assert.equal(run('timeseries-random-split', 'X_tr, X_te = train_test_split(X, y)').length, 0);
});

test('硬编码绝对路径', () => {
  assert.equal(run('hardcoded-abs-path', 'p = "D:/data/x.csv"').length, 1);  // audit-ignore 测试夹具
  assert.equal(run('hardcoded-abs-path', 'p = "data/x.csv"').length, 0);
});

test('破坏性删除 -> 致命且不可逆', () => {
  const hits = run('destructive-cleanup', 'rm -rf ./build');
  assert.equal(hits.length, 1);
  const rule = ruleById('destructive-cleanup');
  assert.equal(rule.level, '致命');
  assert.equal(rule.reversible, false);
});

test('shutil.rmtree 也算', () => {
  assert.equal(run('destructive-cleanup', 'shutil.rmtree(out_dir)').length, 1);
});
