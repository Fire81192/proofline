/**
 * 知识地图：把 prereq 关系变成一棵能走的树。
 *
 * ## 为什么是树，不是网
 *
 * prereq 是"学这条之前要先懂什么"，本质是**偏序**，不是任意连接。
 * 力导向图好看，但 20 个点以上就成一团毛线，而且不告诉你"该先学哪个"。
 * 缩进树直接回答顺序问题。
 *
 * ## 图必须诚实地暴露自己的残缺
 *
 * 三种残缺都要报出来，不许藏：
 *   orphans  没有任何前置、也没人依赖它 —— 孤点
 *   broken   前置指向一个不存在的条目 —— 断链
 *   cycles   互相依赖成环 —— 环
 *
 * 一个漂亮但漏掉断链的图，比不画还糟。
 */

/**
 * @param {Array<{id:string, claim:string}>} entries
 * @returns {{roots:Array, orphans:Array, broken:Array, cycles:Array, edges:number}}
 */
export function buildForest(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const prereqs = new Map();
  const dependents = new Map();

  for (const e of entries) {
    const list = Array.isArray(e.prereq) ? e.prereq.filter((x) => typeof x === 'string') : [];
    prereqs.set(e.id, list);
    for (const p of list) {
      if (!dependents.has(p)) dependents.set(p, []);
      dependents.get(p).push(e.id);
    }
  }

  const broken = [];
  for (const [id, list] of prereqs) {
    for (const p of list) {
      if (!byId.has(p)) broken.push({ from: id, to: p });
    }
  }

  // 只保留真实存在的前置，避免把断链画进树里
  const live = (id) => (prereqs.get(id) ?? []).filter((p) => byId.has(p));

  // 环检测：沿前置往上走，走回自己就是环
  const cycles = [];
  const state = new Map(); // undefined=未访问 1=在栈上 2=完成
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
    for (const p of live(id)) visit(p);
    stack.pop();
    state.set(id, 2);
  };
  for (const e of entries) visit(e.id);

  // 树的走向是"学完这个，接着能学哪些"。
  // 一开始我把 children 设成了自己，结果链子全断开——根节点下面什么都没有。
  const nodes = new Map();
  const build = (id, seen) => {
    if (nodes.has(id)) return nodes.get(id);
    const node = {
      id,
      claim: byId.get(id)?.claim ?? id,
      raw: byId.get(id) ?? null,
      prereq: live(id),
      children: [],
    };
    nodes.set(id, node);
    if (seen.has(id)) return node; // 防环
    seen.add(id);
    for (const d of dependents.get(id) ?? []) {
      if (byId.has(d)) node.children.push(build(d, seen));
    }
    return node;
  };

  // 根：自己没有任何有效前置
  const roots = entries.filter((e) => live(e.id).length === 0).map((e) => build(e.id, new Set()));

  // 孤点：没前置、也没人依赖，而且不是任何树的内部节点
  const referenced = new Set();
  for (const list of prereqs.values()) for (const p of list) referenced.add(p);
  const orphans = entries
    .filter((e) => live(e.id).length === 0 && !referenced.has(e.id))
    .map((e) => e.id);

  let edges = 0;
  for (const [, list] of prereqs) edges += list.filter((p) => byId.has(p)).length;

  return { roots, orphans, broken, cycles, edges };
}
