/**
 * 课程系统地图：**两份数据，两个问题**。
 *
 *   knowledge-map.json  做这件事需要什么知识  —— 客观、通用、跟谁做无关
 *   progress.json       我现在到哪了          —— 个人、会过期
 *
 * 一开始我把它们合成一份，结果图变成了「我这学期的快照」：
 * 课名是本校的叫法，状态是本学期的状态，下学期一来整张图就过时。
 *
 * 分开之后有一条可验证的标准：**把 progress.json 删掉，图还得画得出来。**
 * 画不出来，说明结构里掺了私货。
 *
 * 依据（basis）只标在结构上，因为结构才有"这句话有出处吗"的问题：
 *   条目  库里有可定位的原文
 *   判断  我的推断，未核
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAP_FILE = 'knowledge-map.json';
export const PROGRESS_FILE = 'progress.json';
/**
 * 依据分三种，强弱不同：
 *   条目  库里有能定位的原文（可以逐字查）
 *   实测  自己跑出来的（有脚本、有输出，别人能重跑）
 *   判断  我按项目推的（没有原文，也没跑过）
 *
 * 「实测」是这一轮才加的：代码里读到的事实（比如输入被截断到 1024 点），
 * 光靠引文证明不了它「真的会发生」，得跑到它发生。
 */
export const BASES = ['条目', '判断', '实测'];
export const COURSE_STATUSES = ['在修', '已修', '未修', '缺口', '自学'];

/**
 * 知识的性质，和「重不重要」（tier）是两件事。
 *
 * 一开始只有一个 kind 字段，装的是「基础/核心/工具」——那说的是重要性。
 * 结果课程地图只画得出学科：数学、电路、信号。而真正动手要用的
 * Python、C、命令行、英语，一条都进不来，因为它们不是「课程」。
 *
 * 拆开之后：kind 说这是什么，tier 说有多要紧。
 */
export const KINDS = ['学科', '技术', '语言'];
export const ROLES = ['主线', '背景', '备选'];
export const MAX_LEVEL = 4;
export const SEVERITY = { 缺口: 3, 未修: 2, 在修: 1, 自学: 1, 已修: 0 };

/**
 * 读一个 JSON，两个位置都试（库目录、库的上一级）。
 *
 * 不抛异常——返回 `{data, error, path}`。
 *
 * 原来坏 JSON 直接 throw，于是 `map` 变成「内部错误 exit 3」，
 * 而同一个文件 `check` 说「读不了」、`brief` 说「没有地图」——三张嘴三个说法。
 * 读文件这件事只有一种真相：读到了什么、错在哪。怎么措辞由调用方决定。
 */
async function readJson(root, name) {
  for (const p of [join(root, name), join(root, '..', name)]) {
    let text;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { data: null, error: `${name} 读不了：${err.message}`, path: p };
    }
    try {
      return { data: JSON.parse(text), error: null, path: p };
    } catch (err) {
      return { data: null, error: `${name} 不是合法 JSON：${err.message}`, path: p };
    }
  }
  return { data: null, error: null, path: null };
}

/**
 * @returns {Promise<{knowledge:object|null, progress:object|null,
 *   knowledgeError:string|null, knowledgePath:string|null, knowledgeShape:string|null}>}
 *
 * `knowledgeShape` 专门说「文件在、也解析成功，但不是一个对象」——
 * 内容为 `null` 或 `[]` 时，`knowledge` 也是 null，但那是坏了，不是没写。
 */
export async function readMap(root) {
  const k = await readJson(root, MAP_FILE);
  const p = await readJson(root, PROGRESS_FILE);

  let knowledgeShape = null;
  if (!k.error && k.path && (k.data === null || typeof k.data !== 'object' || Array.isArray(k.data))) {
    knowledgeShape = `${MAP_FILE} 的内容不是对象（读到 ${Array.isArray(k.data) ? '数组' : typeof k.data}）`;
  }

  return {
    knowledge: knowledgeShape ? null : k.data,
    knowledgeError: k.error,
    knowledgeShape,
    knowledgePath: k.path,
    progress: p.data,
    progressError: p.error,
  };
}

/**
 * 校验 + 建图。progress 允许多缺省——缺了就只画结构。
 */
export function analyze({ knowledge, progress, knownIds = null }) {
  const problems = [];
  const warnings = [];

  if (!knowledge) {
    return { ok: false, problems: ['没有 knowledge-map.json，画不出结构'], warnings, empty: true };
  }

  // 三个顶层数组：不是数组就是结构错，不能静默当成空。
  // 当成空之后 `analyze` 会返回 problems=[]，于是 `map` 照样写一张空图、退出 0——
  // 「有硬问题不落盘」那条纪律就被这一处 `?? []` 整个绕过去了。
  const topList = (key) => {
    const v = knowledge[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) { problems.push(`${key} 必须是数组，现在是 ${typeof v}`); return []; }
    return v;
  };
  const blocks = topList('blocks');
  const domains = topList('domains');
  const points = topList('points');

  const domainById = new Map();
  for (const d of domains) {
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.id !== 'string') {
      problems.push('有一个知识域没有 id');
      continue;
    }
    if (domainById.has(d.id)) problems.push(`知识域 id 重复：${d.id}`);
    domainById.set(d.id, d);
  }

  for (const d of domains) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') continue;
    if (d.prereq !== undefined) {
      if (!Array.isArray(d.prereq)) {
        problems.push(`${d.id} 的 prereq 必须是数组，现在是 ${typeof d.prereq}`);
      } else {
        for (const p of d.prereq) {
          if (typeof p !== 'string') problems.push(`${d.id} 的 prereq 里有非字符串项`);
          else if (!domainById.has(p)) problems.push(`${d.id} 的前置指向不存在的知识域：${p}`);
        }
      }
    }
    if (!KINDS.includes(d.kind)) problems.push(`${d.id} 的 kind「${d.kind}」不认识，只能是 ${KINDS.join(' / ')}`);
    if (d.role !== undefined && !ROLES.includes(d.role)) {
      problems.push(`${d.id} 的 role「${d.role}」不认识，只能是 ${ROLES.join(' / ')}`);
    }
    // 全是空格的名字也是没名字
    if (typeof d.name !== 'string' || d.name.trim() === '') problems.push(`${d.id} 没有名字`);
  }

  // 技术 / 语言域必须给出能力刻度：没有刻度就说不清「要几级」和「到几级」。
  //
  // 空数组要单独拦：`levels: []` 能通过 `Array.isArray`，又能绕开下面那条
  // 「被用到却没给等级」的警告（那条要求 levels.length > 0）。
  // 结果是「先占个位」的空刻度既不报错也不警告——最容易被 AI 写成这样的形状。
  for (const d of domains) {
    if (!d || typeof d !== 'object' || d.kind === '学科') continue;
    if (!Array.isArray(d.levels)) { problems.push(`${d.id} 是${d.kind}域，但没有 levels（能力刻度）`); continue; }
    if (d.levels.length === 0) { problems.push(`${d.id} 是${d.kind}域，但 levels 是空的——至少要有 1 级`); continue; }
    const ns = d.levels.map((x) => x?.n);
    for (const n of ns) {
      if (!Number.isInteger(n) || n < 1 || n > MAX_LEVEL) problems.push(`${d.id} 的刻度编号 ${n} 越界（1–${MAX_LEVEL}）`);
    }
    if (new Set(ns).size !== ns.length) problems.push(`${d.id} 的刻度编号有重复`);
    for (const lv of d.levels) {
      if (!lv?.text) problems.push(`${d.id} 的第 ${lv?.n} 级没有描述`);
    }
  }

  // 环
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const at = stack.indexOf(id);
      cycles.push(stack.slice(at).concat(id));
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const p of domainById.get(id)?.prereq ?? []) if (domainById.has(p)) visit(p);
    stack.pop();
    state.set(id, 2);
  };
  for (const d of domains) visit(d.id);
  for (const cy of cycles) problems.push(`先修成环：${cy.join(' → ')}`);

  // 能力块引用的知识域必须存在
  const usedDomains = new Set();
  // 每个域被要求的最高等级：能力块要几级，就取各块里的最大值
  const requiredLevels = new Map();
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      problems.push('blocks 里有一项不是对象');
      continue;
    }
    const label = b.name ?? b.id ?? '(无名)';

    if (b.needs !== undefined && !Array.isArray(b.needs)) {
      problems.push(`能力块「${label}」的 needs 必须是数组，现在是 ${typeof b.needs}`);
    } else {
      for (const dId of b.needs ?? []) {
        if (typeof dId !== 'string') { problems.push(`能力块「${label}」的 needs 里有非字符串项`); continue; }
        if (!domainById.has(dId)) problems.push(`能力块「${label}」指向不存在的知识域：${dId}`);
        else usedDomains.add(dId);
      }
    }

    // entries：任务书对 AI 承诺「只能引用材料表里的 id，硬错」。
    // 承诺兑现不了就等于骗人——原来 analyze 根本不读 b.entries，
    // `map` 给的 problems 永远是 0，AI 自检一路绿灯。
    // 只有传了 knownIds 才查（analyze 单独用时不知道库里有啥）。
    if (b.entries !== undefined) {
      if (!Array.isArray(b.entries)) {
        problems.push(`能力块「${label}」的 entries 必须是数组，现在是 ${typeof b.entries}`);
      } else if (knownIds) {
        const missing = b.entries.filter((x) => typeof x !== 'string' || !knownIds.has(x));
        if (missing.length > 0) {
          problems.push(`能力块「${label}」引用了库里不存在的条目：${missing.join('、')}`);
        }
      }
    }

    if (b.needLevels !== undefined && (typeof b.needLevels !== 'object' || b.needLevels === null || Array.isArray(b.needLevels))) {
      problems.push(`能力块「${label}」的 needLevels 必须是对象`);
    } else {
      for (const [dId, lv] of Object.entries(b.needLevels ?? {})) {
        if (!domainById.has(dId)) {
          problems.push(`能力块「${label}」给的等级指向不存在的知识域：${dId}`);
          continue;
        }
        if (!Number.isInteger(lv) || lv < 1 || lv > MAX_LEVEL) {
          problems.push(`能力块「${label}」对 ${domainById.get(dId)?.name ?? dId} 要求的等级 ${lv} 越界（1–${MAX_LEVEL}）`);
          continue;
        }
        requiredLevels.set(dId, Math.max(requiredLevels.get(dId) ?? 0, lv));
      }
    }

    if (!BASES.includes(b.basis)) problems.push(`能力块「${label}」的依据「${b.basis}」不认识`);
    // 标了实测却不说脚本在哪，等于要求别人相信
    if (b.basis === '实测' && (typeof b.run !== 'string' || !b.run.trim())) {
      warnings.push(`能力块「${label}」标了「实测」，但没给 run（复现脚本路径），别人没法重跑。`);
    }
  }

  // 技术域被能力块用到，就必须说清要几级——否则「学没学到」无从判断
  for (const dId of usedDomains) {
    const d = domainById.get(dId);
    if (d && d.kind !== '学科' && !requiredLevels.has(dId) && (d.levels ?? []).length > 0) {
      warnings.push(`能力块用到了 ${d.name}，但没说需要几级（needLevels）。等级不写，就没法判断够不够。`);
    }
  }

  for (const p of points) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { problems.push('points 里有一项不是对象'); continue; }
    if (!domainById.has(p.domain)) { problems.push(`知识点「${p.name}」挂在不存在的知识域：${p.domain}`); continue; }
    if (p.level === undefined) continue;
    // 等级只对技术/语言有意义：学科是按课程走的，不分级
    const d = domainById.get(p.domain);
    if (d.kind === '学科') { problems.push(`知识点「${p.name}」标了等级，但它属于学科域 ${p.domain}`); continue; }
    if (!Number.isInteger(p.level) || p.level < 1 || p.level > MAX_LEVEL) {
      problems.push(`知识点「${p.name}」的等级 ${p.level} 越界（1–${MAX_LEVEL}）`);
    }
  }

  // 出口：顺着「谁依赖我」一路走，能不能走到某个能力块
  const dependents = new Map();
  for (const d of domains) {
    for (const p of d.prereq ?? []) {
      if (!dependents.has(p)) dependents.set(p, []);
      dependents.get(p).push(d.id);
    }
  }
  const hasOutlet = (id, seen = new Set()) => {
    if (usedDomains.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (dependents.get(id) ?? []).some((x) => hasOutlet(x, seen));
  };

  // 「这个项目用不上」是结构判断，不该放在个人进度里。
  // 所以 domain 自带 role：主线 走出口检查，背景 不参与。
  // 主线才查出口。背景＝知道有用但不是这条主线；备选＝需要时再学，不是现在要补的。
  const deadEnd = domains
    .filter((d) => (d.role ?? '主线') === '主线' && !hasOutlet(d.id))
    .map((d) => ({ id: d.id, name: d.name }));

  if (deadEnd.length) {
    warnings.push(
      `有 ${deadEnd.length} 个知识域在这个项目里没有出口（学了用不上）：${deadEnd.map((d) => d.name).join('、')}。`
      + '要么它不是主线（在结构里标 role: 背景），要么这张图缺了对应它的能力块。',
    );
  }

  const byDomain = new Map();
  const byPoint = new Map();
  const bySkill = new Map();
  if (progress) {
    for (const c of progress.courses ?? []) {
      if (!c || typeof c.domain !== 'string') continue;
      if (!domainById.has(c.domain)) { problems.push(`progress 里有一门课对应不存在的知识域：${c.domain}`); continue; }
      if (!COURSE_STATUSES.includes(c.status)) problems.push(`${c.domain} 的状态「${c.status}」不认识`);
      byDomain.set(c.domain, c);
    }
    for (const s of progress.skills ?? []) {
      if (!s || typeof s.domain !== 'string') continue;
      const d = domainById.get(s.domain);
      if (!d) { problems.push(`progress 里的技术等级指向不存在的知识域：${s.domain}`); continue; }
      if (d.kind === '学科') { problems.push(`${s.domain} 是学科，等级请写在 courses 里`); continue; }
      if (!Number.isInteger(s.level) || s.level < 0 || s.level > MAX_LEVEL) {
        problems.push(`${s.domain} 的等级 ${s.level} 越界（0–${MAX_LEVEL}，0 = 没碰过）`);
        continue;
      }
      bySkill.set(s.domain, s);
    }
    for (const g of progress.gaps ?? []) {
      if (!g || typeof g.point !== 'string') continue;
      if (!points.some((p) => p.id === g.point)) { problems.push(`progress 里有个缺口指向不存在的知识点：${g.point}`); continue; }
      byPoint.set(g.point, g);
    }
  } else {
    warnings.push('没有 progress.json：只有结构，没有颜色。删掉它也该能画——这正是结构独立的证明。');
  }

  // 技术缺口：要求的等级 > 现在的等级。没填等级的是「未评」，不算达标也不算缺口。
  const techGaps = [];
  const unrated = [];
  for (const d of domains) {
    if (d.kind === '学科') continue;
    const need = requiredLevels.get(d.id) ?? 0;
    if (need === 0) continue;
    const mine = bySkill.get(d.id);
    if (!mine) { unrated.push({ id: d.id, name: d.name, need }); continue; }
    if (mine.level < need) {
      techGaps.push({
        id: d.id, name: d.name, need, mine: mine.level,
        delta: need - mine.level, estimated: Boolean(mine.estimated), note: mine.note ?? '',
      });
    }
  }
  if (unrated.length) {
    warnings.push(`这 ${unrated.length} 项技术没填等级，判断不了够不够：${unrated.map((x) => `${x.name}（需要 L${x.need}）`).join('、')}。`);
  }

  // 计数在这里算一次。页面和命令行都读这个对象——
  // 「缺几处」以前在两边各算一遍，结果 CLI 说 4 处、页面说 7 处。
  const counts = {
    subjects: domains.filter((d) => d.kind === '学科').length,
    techs: domains.filter((d) => d.kind === '技术').length,
    langs: domains.filter((d) => d.kind === '语言').length,
    pointGaps: byPoint.size,
    domainGaps: domains.filter((d) => byDomain.get(d.id)?.status === '缺口').length,
    techGaps: techGaps.length,
  };
  counts.total = counts.pointGaps + counts.domainGaps + counts.techGaps;

  return {
    ok: problems.length === 0,
    counts,
    problems,
    warnings,
    goal: knowledge.goal ?? '',
    blocks,
    domains,
    points,
    domainById,
    byDomain,
    byPoint,
    bySkill,
    requiredLevels,
    techGaps,
    unrated,
    deadEnd,
    cycles,
    hasProgress: Boolean(progress),
  };
}
