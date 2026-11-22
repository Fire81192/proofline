/**
 * 证据册的 Markdown 版。
 *
 * HTML 版适合自己看和发给别人浏览；Markdown 版是为了**能被批注**——
 * 导师要 review 你的引用时，发一个 .html 过去没法改，发 .md 可以直接标行。
 *
 * 两种输出共用同一份数据，区别只在模板。任何一条在 HTML 里怎么判，
 * 在这里必须是同一个结论——不一致就是「同一事实两处算」。
 */

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// 表格里的来源只放域名：完整 URL 会把整行撑爆，Markdown 表格不会自动折行。
// 完整地址在「逐条」里给，那里想复制多少都行。
const shortSource = (s) => {
  if (!s) return '';
  try {
    return new URL(s).hostname;
  } catch {
    return String(s).slice(0, 24);
  }
};

export function renderViewMd({ entries, sources, stats, generatedAt }) {
  const L = [];
  L.push('# 证据册');
  L.push('');
  L.push(`> 生成于 ${generatedAt}。每条主张都能在原文里定位到；定位不到的不进这个册子。`);
  L.push('');
  L.push(`${stats.entries} 条主张 · ${stats.sources} 个来源 · ${stats.citable} 条可引用 · ${stats.decisive} 条可判定`);
  if (stats.uncontrolled > 0) {
    L.push('');
    L.push(`**有 ${stats.uncontrolled} 条未受控**：内容没经过入库闸门，不计入「可引用」。`);
  }
  L.push('');

  // 总表：一行一条。想快速扫一遍，看这张就够。
  L.push('| # | 主张 | 类型 | 来源 | 可引用 | 可判定 |');
  L.push('|---|---|---|---|---|---|');
  entries.forEach((e, i) => {
    L.push(`| ${i + 1} | ${esc(e.claim)} | ${e.kind} | ${esc(shortSource(e.source))} | ${e.citable ? '是' : '否'} | ${e.decisive ? '是' : '否'} |`);
  });
  L.push('');

  L.push('## 逐条');
  L.push('');
  entries.forEach((e, i) => {
    L.push(`### ${i + 1}. ${esc(e.claim)}`);
    L.push('');
    L.push(`\`${e.id}\``);
    L.push('');
    L.push(`- **类型 / 层级**：${e.kind} / ${e.layer} / 依据：${e.basis}`);
    L.push(`- **来源**：${esc(e.source)}`);
    if (Array.isArray(e.quotes) && e.quotes.length > 0) {
      for (const q of e.quotes) L.push(`- **原文**：「${esc(q)}」`);
    }
    L.push(`- **来源维度**：${e.evidence}`);
    L.push(`- **世界维度**：${e.world}`);
    L.push(`- **能引用**：${e.citable ? '是' : '否'}　**能下判断**：${e.decisive ? '是' : '否'}`);
    if (e.controlled === false) L.push(`- **受控**：否（${esc(e.uncontrolledWhy)}）`);
    if (Array.isArray(e.notFor) && e.notFor.length > 0) {
      L.push(`- **不能用来**：`);
      for (const x of e.notFor) L.push(`  - ${esc(x)}`);
    }
    if (e.retired) L.push(`- **已退役**：${esc(e.retiredNote)}`);
    L.push('');
  });

  if (sources.length > 0) {
    L.push('## 来源');
    L.push('');
    L.push('| 来源 | 条目数 | 状态 |');
    L.push('|---|---|---|');
    for (const s of sources) {
      L.push(`| ${esc(s.uri)} | ${s.count} | ${s.blocking ? '可疑 / 弃用' : '在用'} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('这份册子只说明「谁在什么时候说过什么」，不说明「这件事是真的」。');
  L.push('要判断真假，看每条的世界维度，以及它的佐证和实测。');
  return `${L.join('\n')}\n`;
}
