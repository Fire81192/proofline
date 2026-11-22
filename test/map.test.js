import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildForest } from '../src/map.js';

/**
 * 依赖森林。
 *
 * prereq 本质是偏序，所以画成树而不是网：缩进树直接回答「该先学哪个」。
 * 图的价值在于**诚实地暴露残缺**——孤点、断链、环，三种都要报出来。
 * 一个漂亮但漏掉断链的图，比不画还糟。
 */

const e = (id, prereq = []) => ({ id, claim: `主张 ${id}`, prereq });

test('空库：没有根、没有孤点', () => {
  const f = buildForest([]);
  assert.equal(f.roots.length, 0);
  assert.equal(f.orphans.length, 0);
  assert.equal(f.edges, 0);
});

test('一条没有前置：它就是根，也是孤点', () => {
  const f = buildForest([e('a')]);
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].id, 'a');
  // 没有前置、也没人依赖它 —— 孤点正是这个意思
  assert.deepEqual(f.orphans, ['a']);
});

test('两条成链：根是 a，b 挂在 a 下面', () => {
  const f = buildForest([e('a'), e('b', ['a'])]);
  assert.equal(f.roots.length, 1);
  assert.equal(f.roots[0].id, 'a');
  assert.equal(f.roots[0].children.length, 1);
  assert.equal(f.roots[0].children[0].id, 'b');
  assert.equal(f.edges, 1);
  // b 依赖 a，所以 a 不是孤点；b 有前置，也不是孤点
  assert.deepEqual(f.orphans, []);
});

test('断链：前置指向不存在的条目，要报出来但不画进树', () => {
  const f = buildForest([e('a', ['ghost'])]);
  assert.deepEqual(f.broken, [{ from: 'a', to: 'ghost' }]);
  // 断掉的前置不算有效前置，所以 a 仍是根
  assert.equal(f.roots.length, 1);
  assert.deepEqual(f.roots[0].prereq, []);
  assert.equal(f.edges, 0);
});

test('成环：互相依赖要报，而且不能死循环', () => {
  const f = buildForest([e('a', ['b']), e('b', ['a'])]);
  assert.equal(f.cycles.length, 1);
  // 环的记法是「起点在末尾再出现一次」，所以去重后再比成员
  assert.deepEqual([...new Set(f.cycles[0])].sort(), ['a', 'b']);
  // 两个都有前置，所以没有根；也不能卡住
  assert.equal(f.roots.length, 0);
});

test('自己依赖自己也算环', () => {
  const f = buildForest([e('a', ['a'])]);
  assert.equal(f.cycles.length, 1);
  assert.deepEqual(f.cycles[0], ['a', 'a']);
});

test('孤点：没前置也没人依赖，和「根」不是一回事', () => {
  // a 是根（下面挂着 b）；c 谁都不要、也没人要 → 孤点
  const f = buildForest([e('a'), e('b', ['a']), e('c')]);
  assert.equal(f.roots.length, 2);
  assert.deepEqual(f.orphans, ['c']);
});

test('prereq 里的非字符串项被忽略，不报断链', () => {
  const f = buildForest([{ id: 'a', claim: 'x', prereq: [null, 42, 'b'] }, e('b')]);
  assert.deepEqual(f.broken, []);
  assert.equal(f.edges, 1);
});
