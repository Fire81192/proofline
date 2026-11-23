/**
 * 从四库抽考卷题。
 *
 * ## 两类题
 *
 * 正题：每个**已经通过校验**的引文 + 它的快照。期望「能定位到」。
 *   —— 这些是真实数据，不是我编的。它们能过，是因为当初真定位到了。
 *
 * 负题：把正题引文的中间一个字换掉，期望「定位不到」。
 *   —— 换成最常见的「的」，这样最容易碰巧命中原文别处。
 *      生成后会实测一次：如果改完还能定位到，说明原文别处真有这句，
 *      那不是负题，丢弃。
 *
 * ## 为什么负题比正题重要
 *
 * 正题不中，是「该收的被拒了」——用户会抱怨，能发现。
 * 负题中了，是「不该收的收了」——**没人会抱怨，错误就这么进了库**。
 *
 * 所以门设在负题上：误报必须为 0。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../../src/core/frontmatter.js';
import { locateQuote } from '../../src/core/quote.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, '..', '..', '..', 'workspace');
const LIBS = ['ppg2abp', 'aqi', 'longzongzhi', 'self'];
const MIN_NEG_LEN = 15;

/** 把引文中间的一个汉字换成「的」，返回 null 表示找不到可换的位置。 */
function mutate(quote) {
  const chars = [...quote];
  const mid = Math.floor(chars.length / 2);
  for (let i = mid; i < chars.length; i += 1) {
    if (/[\u4e00-\u9fa5]/.test(chars[i]) && chars[i] !== '的') {
      const copy = [...chars];
      copy[i] = '的';
      return copy.join('');
    }
  }
  return null;
}

const rows = [];
let dupSkipped = 0;

for (const lib of LIBS) {
  const root = join(WS, lib, 'entries');
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root).sort()) {
    const entryPath = join(root, dir, 'entry.md');
    const snapPath = join(root, dir, 'raw', 'source.txt');
    if (!existsSync(entryPath) || !existsSync(snapPath)) continue;

    let data;
    try {
      ({ data } = parseFrontmatter(readFileSync(entryPath, 'utf8')));
    } catch { continue; }

    const snapshot = readFileSync(snapPath, 'utf8');
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];

    quotes.forEach((quote, qi) => {
      if (typeof quote !== 'string' || !quote) return;

      // 正题：只收「现在真能定位到」的。定位不到的说明库里有脏数据，
      // 那是另一件事，不该混进考卷。
      const hit = locateQuote(snapshot, quote);
      if (!hit) {
        console.warn(`跳过（定位不到）：${lib}/${dir} 引文 #${qi + 1}`);
        return;
      }
      rows.push({
        id: `pos-${lib}-${dir}-${qi + 1}`,
        kind: 'positive',
        lib,
        entry: dir,
        quote,
        snapshot,
        mode: hit.mode,          // 生成时的级别 —— 跑分时不许比它更松
        expectMode: hit.mode,
        note: '',
      });

      // 负题
      if ([...quote].length < MIN_NEG_LEN) return;
      const bad = mutate(quote);
      if (!bad) return;
      if (locateQuote(snapshot, bad)) {
        dupSkipped += 1;   // 改完还能中 —— 原文别处真有这句，不是负题
        return;
      }
      rows.push({
        id: `neg-${lib}-${dir}-${qi + 1}`,
        kind: 'negative',
        lib,
        entry: dir,
        quote: bad,
        snapshot,
        mode: null,
        note: '中间一个汉字换成「的」，必须定位不到',
      });
    });
  }
}

/**
 * 合成题：真实材料覆盖不到的边界。
 *
 * 真实题的价值是「回归」——它们都曾经定位成功过，改坏 quote.js 会挂。
 * 但真实题 recall 必然是 100%，那不是「证明它准」，是「证明它没退」。
 *
 * 要测「绝对边界」，得手工造「不该中但容易误中」的题。
 *
 * ## 这里不测数值边界（1.5 vs 1.5-2.0）
 *
 * 试过，造错了——`1.5` 在 `1.5-2.0` 里**确实命中**，因为它是连续子串。
 *
 * 两套规则不一样：
 *   locateQuote（引文定位）  纯子串匹配。1.5 在 1.5-2.0 里是连续片段，该中。
 *   containsValue（run 的 expect）  带字符边界（数字/字母/下划线/点/负号）。
 *                            1.5 和 1.52 不是同一个数，不该中。
 *
 * 引文定位管「原文有没有这段连续的字」，数值匹配管「这个数是不是独立的」。
 * 混在一起考，测出来的不是任何一个。
 */
const SYNTHETIC = [
  {
    id: 'syn-order',
    kind: 'negative',
    snapshot: '气压降低时沸点随之降低。',
    quote: '沸点随之降低气压降低时',
    note: '顺序颠倒：词都在，但原文里不是这个顺序',
  },
  {
    id: 'syn-split',
    kind: 'negative',
    snapshot: '第一句话讲完了。第二句说的是另一件事。',
    quote: '第二句讲完了',
    note: '跨句拼凑：两个词组隔着句号，不是连续片段',
  },
  {
    id: 'syn-longer',
    kind: 'negative',
    snapshot: '标准大气压下纯水的沸点是 100 ℃。',
    quote: '标准大气压下纯水的沸点是一百 ℃',
    note: '多加一个字：不是原文的连续片段',
  },
  {
    id: 'syn-shorter-word',
    kind: 'negative',
    snapshot: '饱和蒸气压等于外界压力时液体沸腾。',
    quote: '饱和气压等于外界压力',
    note: '少一个字：原文是「饱和蒸气压」，不是「饱和气压」',
  },
  {
    id: 'syn-fullwidth',
    kind: 'positive',
    snapshot: '限值为 ３５ μｇ／ｍ³（全角数字）。',
    quote: '限值为 35 μg/m³',
    note: '全角转半角：应该判 normalized，不是 exact',
  },
  {
    id: 'syn-spans-newline',
    kind: 'positive',
    snapshot: '第一行写在这里。\n第二行接着写。',
    quote: '第一行写在这里。第二行接着写',
    note: '原文中间有换行：应该判 space-insensitive',
  },
];

for (const s of SYNTHETIC) {
  const hit = locateQuote(s.snapshot, s.quote);
  // 自检：负题必须不中，正题必须中。造错的题不该进题库。
  if (s.kind === 'negative' && hit) {
    console.warn(`合成负题造错了（竟然命中）：${s.id}`);
    continue;
  }
  if (s.kind === 'positive' && !hit) {
    console.warn(`合成正题造错了（竟然不中）：${s.id}`);
    continue;
  }
  rows.push({
    ...s,
    lib: 'synthetic',
    entry: s.id,
    mode: hit ? hit.mode : null,
    expectMode: hit ? hit.mode : null,
    source: 'synthetic',
  });
}

for (const r of rows) if (!r.source) r.source = 'real';

mkdirSync(HERE, { recursive: true });
const out = join(HERE, 'questions.jsonl');
writeFileSync(out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');

const pos = rows.filter((r) => r.kind === 'positive');
const neg = rows.filter((r) => r.kind === 'negative');
const byMode = {};
for (const p of pos) byMode[p.mode] = (byMode[p.mode] ?? 0) + 1;

console.log(`题库：${rows.length} 题（正 ${pos.length} / 负 ${neg.length}）`);
console.log(`正题命中级别分布：${Object.entries(byMode).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
if (dupSkipped > 0) console.log(`改了还能中的负题（原文别处真有这句）已丢弃：${dupSkipped} 条`);
console.log(`写入 ${out}`);
