import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../src/views/curriculum.js';

const k = (over = {}) => ({
  goal: '测试目标',
  blocks: [{ id: 'b1', name: '块一', needs: ['d1'], basis: '判断' }],
  domains: [{ id: 'd1', name: '域一', kind: '学科', prereq: [], why: '因为它' }],
  points: [],
  ...over,
});

test('没有结构数据 -> 明确说画不出来，不是画一张空图', () => {
  const r = analyze({ knowledge: null, progress: null });
  assert.equal(r.ok, false);
  assert.ok(r.problems[0].includes('knowledge-map.json'));
});

test('只有结构、没有进度 -> 照样出报告（这就是结构独立的证明）', () => {
  const r = analyze({ knowledge: k(), progress: null });
  assert.equal(r.ok, true);
  assert.equal(r.hasProgress, false);
  assert.equal(r.blocks.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('没有 progress.json')));
});

test('背景域不参与出口检查', () => {
  const r = analyze({
    knowledge: k({
      blocks: [],
      domains: [
        { id: 'd1', name: '背景课', kind: '学科', prereq: [], role: '背景' },
        { id: 'd2', name: '主线课', kind: '学科', prereq: [], role: '主线' },
      ],
    }),
    progress: null,
  });
  assert.deepEqual(r.deadEnd.map((d) => d.id), ['d2'], '背景不该被当成死路');
});

test('前置链能传递到能力块，就不算死路', () => {
  const r = analyze({
    knowledge: k({
      blocks: [{ id: 'b1', name: '块', needs: ['d2'], basis: '判断' }],
      domains: [
        { id: 'd1', name: '基础', prereq: [], role: '主线' },
        { id: 'd2', name: '下游', prereq: ['d1'], role: '主线' },
      ],
    }),
    progress: null,
  });
  assert.deepEqual(r.deadEnd, [], '基础通过下游连到能力块，有出口');
});

test('前置指向不存在的域 -> problem', () => {
  const r = analyze({
    knowledge: k({ domains: [{ id: 'd1', name: '域', prereq: ['ghost'], role: '主线' }] }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('ghost')));
});

test('先修成环 -> problem', () => {
  const r = analyze({
    knowledge: k({
      domains: [
        { id: 'a', name: 'A', prereq: ['b'], role: '主线' },
        { id: 'b', name: 'B', prereq: ['a'], role: '主线' },
      ],
    }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('成环')));
});

test('能力块指向不存在的域 -> problem', () => {
  const r = analyze({
    knowledge: k({ blocks: [{ id: 'b', name: '块', needs: ['nope'], basis: '判断' }] }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('nope')));
});

test('进度里的课挂在不存在的域 -> problem', () => {
  const r = analyze({
    knowledge: k(),
    progress: { courses: [{ domain: 'ghost', localName: '某课', status: '在修' }] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('ghost')));
});

test('进度里的状态不认识 -> problem', () => {
  const r = analyze({
    knowledge: k(),
    progress: { courses: [{ domain: 'd1', localName: '某课', status: '学了一半' }] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('学了一半')));
});

test('缺口挂在不存在的知识点 -> problem', () => {
  const r = analyze({
    knowledge: k(),
    progress: { gaps: [{ point: 'ghost.point', note: 'x' }] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('ghost.point')));
});

test('缺口能对上知识点', () => {
  const r = analyze({
    knowledge: k({ points: [{ id: 'd1.p', domain: 'd1', name: '某点' }] }),
    progress: { gaps: [{ point: 'd1.p', note: '没学过' }] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.byPoint.get('d1.p').note, '没学过');
});

// ---------------------------------------------------------------- 技术 / 语言层
const tech = (over = {}) => ({
  goal: '测试目标',
  blocks: [{
    id: 'b1', name: '块一', needs: ['py'], basis: '判断', needLevels: { py: 3 },
  }],
  domains: [{
    id: 'py', name: 'Python', kind: '技术', prereq: [], role: '主线', basis: '判断',
    levels: [{ n: 1, text: '跑得起来' }, { n: 2, text: '会用' }, { n: 3, text: '会调' }, { n: 4, text: '会选' }],
  }],
  points: [],
  ...over,
});

test('kind 只认 学科 / 技术 / 语言', () => {
  const r = analyze({
    knowledge: tech({ domains: [{ id: 'py', name: 'Python', kind: '课程', levels: [] }] }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('kind')));
});

test('技术域必须有 levels（没有刻度就说不出「要几级」）', () => {
  const r = analyze({
    knowledge: tech({ domains: [{ id: 'py', name: 'Python', kind: '技术' }] }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('levels')));
});

test('能力块要的等级取各块最大值', () => {
  const r = analyze({
    knowledge: tech({
      blocks: [
        { id: 'b1', name: '块一', needs: ['py'], basis: '判断', needLevels: { py: 2 } },
        { id: 'b2', name: '块二', needs: ['py'], basis: '判断', needLevels: { py: 4 } },
      ],
    }),
    progress: null,
  });
  assert.equal(r.requiredLevels.get('py'), 4);
});

test('等级越界要报（L5 不存在）', () => {
  const r = analyze({
    knowledge: tech({ blocks: [{ id: 'b1', name: '块一', needs: ['py'], basis: '判断', needLevels: { py: 5 } }] }),
    progress: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('越界')));
});

test('我现在 L2、项目要 L3 -> 是一个缺口，且算出差几级', () => {
  const r = analyze({
    knowledge: tech(),
    progress: { skills: [{ domain: 'py', level: 2, note: '跑过脚本' }] },
  });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.techGaps.length, 1);
  assert.equal(r.techGaps[0].delta, 1);
  assert.equal(r.techGaps[0].need, 3);
});

test('够了就不算缺口', () => {
  const r = analyze({ knowledge: tech(), progress: { skills: [{ domain: 'py', level: 3 }] } });
  assert.equal(r.techGaps.length, 0);
});

test('没填等级是「未评」，不是缺口也不是达标', () => {
  const r = analyze({ knowledge: tech(), progress: { skills: [] } });
  assert.equal(r.techGaps.length, 0);
  assert.equal(r.unrated.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('没填等级')));
});

test('没有 progress.json -> 一个技术缺口都没有（缺口是人的事）', () => {
  const r = analyze({ knowledge: tech(), progress: null });
  assert.equal(r.techGaps.length, 0);
  assert.equal(r.counts.techGaps, 0);
  assert.equal(r.counts.total, 0);
});

test('备选域不算死路（需要时再学，不是现在要补）', () => {
  const r = analyze({
    knowledge: tech({
      blocks: [],
      domains: [{
        id: 'cpp', name: 'C++', kind: '技术', role: '备选', prereq: [],
        levels: [{ n: 1, text: '看得懂' }],
      }],
    }),
    progress: null,
  });
  assert.deepEqual(r.deadEnd, []);
});

test('学科不允许出现在 skills 里（那属于 courses）', () => {
  const r = analyze({
    knowledge: k(),
    progress: { skills: [{ domain: 'd1', level: 2 }] },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('courses')));
});

test('计数只在 analyze 里算一次，页面和命令行读同一个对象', () => {
  const r = analyze({
    knowledge: tech({
      points: [{ id: 'p1', domain: 'py', name: '点一' }],
    }),
    progress: { skills: [{ domain: 'py', level: 1 }], gaps: [{ point: 'p1', note: '卡住了' }] },
  });
  assert.equal(r.counts.pointGaps, 1);
  assert.equal(r.counts.techGaps, 1);
  assert.equal(r.counts.domainGaps, 0);
  assert.equal(r.counts.total, 2);
  assert.equal(r.counts.subjects, 0);
  assert.equal(r.counts.techs, 1);
});

test('标了「实测」却没给复现脚本 -> 给警告（要求别人相信是不行的）', () => {
  const r = analyze({
    knowledge: tech({
      blocks: [{ id: 'b1', name: '块一', needs: [], basis: '实测' }],
      domains: [{ id: 'py', name: 'Python', kind: '技术', prereq: [], levels: [{ n: 1, text: 'x' }] }],
      points: [],
    }),
    progress: null,
  });
  assert.ok(r.warnings.some((w) => w.includes('复现脚本')));
});

test('三种依据都认，第四种不认', () => {
  for (const basis of ['条目', '判断', '实测']) {
    const r = analyze({
      knowledge: tech({
        blocks: [{ id: 'b1', name: '块一', needs: [], basis, run: 'x.py' }],
        domains: [{ id: 'py', name: 'P', kind: '技术', prereq: [], levels: [{ n: 1, text: 'x' }] }],
        points: [],
      }),
      progress: null,
    });
    assert.equal(r.ok, true, `${basis}: ${r.problems.join('; ')}`);
  }
  const bad = analyze({
    knowledge: tech({
      blocks: [{ id: 'b1', name: '块一', needs: [], basis: '听说' }],
      domains: [{ id: 'py', name: 'P', kind: '技术', prereq: [], levels: [{ n: 1, text: 'x' }] }],
      points: [],
    }),
    progress: null,
  });
  assert.equal(bad.ok, false);
});
