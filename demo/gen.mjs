// 生成 demo 数据。跑一次就够，生成的文件随仓库提交。
// 材料是虚构的——开源仓库里不能放有版权的原文。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createEntry } from '../src/create.js';

const ROOT = 'demo/entries';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const A = `沸点小记（虚构材料，仅供演示）

标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。
气压降低时沸点随之降低：海拔每升高约 300  米，沸点下降约 1 ℃。
所以高原上煮不熟饭，不是因为水不够热，是因为水到不了 100 ℃。`;

const B = `压力与沸腾（虚构材料，仅供演示）

液体沸腾的条件是饱和蒸气压等于外界压力。
外界压力越低，达到这个条件所需的温度就越低。
这就是高原沸点低的原因。`;

const specs = [
  {
    id: '2026-01-01-demo-boiling-100',
    spec: {
      claim: '标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃',
      kind: '原理',
      layer: '标准',
      basis: '条目',
      topic: 'demo.boiling',
      source_kind: '其他',
      source_extraction: '原文',
      source_uri: 'demo://沸点小记',
      snapshot_text: A,
      quotes: ['标准大气压（101.325 kPa）下，纯水的沸点是 100 ℃。'],
      evidence_status: 'supported',
      world_status: 'unresolved',
      value: { metric: 'boiling.point', number: 100, unit: '℃', scope: '纯水 / 标准大气压', subject: '水' },
      added_at: '2026-01-01',
    },
  },
  {
    id: '2026-01-01-demo-altitude',
    spec: {
      claim: '海拔每升高约 300 米，水的沸点下降约 1 ℃',
      kind: '原理',
      layer: '线索',
      basis: '条目',
      topic: 'demo.boiling',
      source_kind: '其他',
      source_extraction: '原文',
      source_uri: 'demo://沸点小记',
      snapshot_text: A,
      // 引文里多了一个空格：演示「宽松命中」会被明确说出来，不静默通过
      quotes: ['海拔每升高约 300 米，沸点下降约 1 ℃'],
      evidence_status: 'supported',
      world_status: 'unresolved',
      added_at: '2026-01-01',
    },
  },
  {
    id: '2026-01-01-demo-inference',
    spec: {
      claim: '高原上需要压力锅，是为了把沸点抬回 100 ℃ 附近',
      kind: '观点',
      layer: '线索',
      basis: '判断',
      topic: 'demo.boiling',
      source_kind: '其他',
      source_extraction: '原文',
      source_uri: 'demo://压力与沸腾',
      snapshot_text: B,
      quotes: ['外界压力越低，达到这个条件所需的温度就越低。'],
      evidence_status: 'not_checked',
      world_status: 'unresolved',
      gaps: [
        {
          question: '压力锅实际能达到多少 kPa',
          action: 'fetch',
          locator: '产品参数',
          blocking: false,
          dimension: 'world',
        },
      ],
      added_at: '2026-01-01',
    },
  },
];

for (const { id, spec } of specs) {
  const r = await createEntry({ root: ROOT, id, spec });
  if (r.ok) {
    console.log(`✓ ${id}`);
  } else {
    console.log(`✗ ${id}：${r.code} ${(r.hardFails ?? []).join('; ')} ${(r.autofixes ?? []).join('; ')}`);
  }
  for (const w of r.warnings ?? []) console.log(`  注意：${w}`);
}

writeFileSync(
  'demo/project.json',
  `${JSON.stringify({
    name: '演示库',
    domain: '演示 / 物理',
    purpose: '给第一次运行的人看：三条主张，一条逐字命中，一条宽松命中，一条是推理。',
  }, null, 2)}\n`,
  'utf8',
);
