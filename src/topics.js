/**
 * 话题分组。
 *
 * 工具读不懂语义，所以它不做「谁对谁错」的判断。
 * 它能做而且必须做的只有一件事：**同一个话题下的主张，不许互相不知道对方存在。**
 *
 * 三面旗子都只描述「事实上的不一致」，不下结论：
 *   结论不一   —— 世界维度一个是 supported，一个是 unresolved
 *   可用性不一 —— 一条能引用，一条不能
 *   层级混用   —— 一条标准、一条线索（线索层永远不能当依据）
 *
 * 有旗子不代表有错，只代表「这里需要人看一眼」。
 *
 * ## 判断档不参与比较
 *
 * `basis: 判断` 的条目「不可引用」「世界维度无结论」是它的定义，
 * 不是跟谁不一致。拿它去比，每个含推理的话题都会挂旗——
 * 那种旗子只会训练人忽略旗子。
 */

/**
 * @typedef {{id:string, claim:string, topic:string|null, layer:string, kind:string,
 *            evidence:string, world:string, citable:boolean, decisive:boolean, source:string}} Item
 */

/**
 * @param {Item[]} items
 * @returns {{groups: {topic:string, items:Item[], flags:string[]}[], untagged:Item[]}}
 */
export function groupByTopic(items) {
  const byTopic = new Map();
  const untagged = [];

  for (const it of items) {
    if (typeof it.topic !== 'string' || it.topic.trim() === '') {
      untagged.push(it);
      continue;
    }
    const key = it.topic.trim();
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(it);
  }

  const groups = [];
  for (const [topic, list] of [...byTopic.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // 组内按 id 排，输出稳定，便于 diff
    list.sort((a, b) => a.id.localeCompare(b.id));
    groups.push({ topic, items: list, flags: flagsOf(list) });
  }

  return { groups, untagged };
}

/** 组内出现哪些不一致。没有语义判断，只比字段。 */
function flagsOf(list) {
  const flags = [];

  // 「组里还有没有能用的东西」——这个问题和「组里说法一致吗」是两件事。
  //
  // 判据是「曾经有、现在没了」，不是「现在没有」：
  //   全组判断档   → 从一开始就没有可引用的，是预期状态，不报
  //   全组退役     → 曾经有，现在没了，报「全组已退役」
  //   退役 + 判断档 → 曾经有（那条退役的是），现在没了，报「无可用依据」
  //
  // 只报字面退役会漏掉第三种——一组里只要还有一条没退役的判断档，
  // 就既不报退役也不报别的，静静显示成一组无旗的条目。
  const hadUsable = list.some((x) => x.basis !== '判断');
  const activeUsable = list.filter((x) => !x.retired && x.basis !== '判断');
  if (list.length > 0 && hadUsable && activeUsable.length === 0) {
    return [list.every((x) => x.retired) ? '全组已退役' : '无可用依据'];
  }

  // 「不可引用」有两种来路，都是设计如此，拿它们跟别人比只会制造噪音：
  //   判断档 —— 它是推的，本来就不能当依据
  //   已退役 —— 我们决定不再用它
  // 噪音的代价是真实的：一面总在响的旗，等于没有旗。
  //
  // 注意顺序：先剔除退役的，再剔除判断档。反过来会让「全组判断档」
  // 落到 comparable=0 那一支，被误说成「全组已退役」。
  const active = list.filter((x) => !x.retired);
  const comparable = active.filter((x) => x.basis !== '判断');
  if (comparable.length < 2) return flags;

  const worlds = new Set(comparable.map((x) => x.world));
  if (worlds.size > 1 && worlds.has('supported')) flags.push('结论不一');

  const usability = new Set(comparable.map((x) => (x.citable ? 'yes' : 'no')));
  if (usability.size > 1) flags.push('可用性不一');

  const layers = new Set(comparable.map((x) => x.layer));
  if (layers.size > 1) flags.push('层级混用');

  return flags;
}

/** 有旗子的组，给 check 用。 */
export function flagged(groups) {
  return groups.filter((g) => g.flags.length > 0);
}

/**
 * 同一个指标的数值，排成一张对照表。
 *
 * ## 为什么要这个
 *
 * `review` 原来只把主张一句一句列出来。遇到「八条主张说的都是 PM2.5 年均限值、
 * 数值分别是 35 / 9 / 25 / 10 / 5」这种情况，它一句旗都不挂——因为旗子比的是
 * 元数据（world / 可用性 / 层级），而八条全是 unresolved、全可引用、全「标准」层。
 *
 * 人读那八行，只会记住「哦，都是 35」。
 *
 * 这里做的不是判断对错，是**排版成可比的形态**：
 * 「中国 35」和「美国 9」不是矛盾，是两个辖区各自的规定，工具无权说谁错。
 * 但它有权让这两个数并排站着，让人看见它们不一样。
 *
 * ## 按什么分组
 *
 * `metric + unit`。同 metric 不同 unit 硬凑一张表只会更乱。
 * 一行都不足两条时不出表——一条数值没有对照的意义。
 *
 * @param {Array} list 同一话题下的条目
 * @returns {Array<{metric, unit, rows, distinct}>}
 */
export function valueTables(list) {
  const buckets = new Map();
  for (const x of list) {
    const v = x.value;
    if (!v || typeof v !== 'object') continue;
    if (typeof v.metric !== 'string' || typeof v.number !== 'number') continue;
    const key = `${v.metric}\u0000${v.unit ?? ''}`;
    if (!buckets.has(key)) {
      buckets.set(key, { metric: v.metric, unit: v.unit ?? '', rows: [] });
    }
    buckets.get(key).rows.push({
      id: x.id,
      number: v.number,
      subject: typeof v.subject === 'string' && v.subject.trim() !== '' ? v.subject.trim() : '（未指定主体）',
      scope: v.scope ?? '（没写口径）',
      effective_from: v.effective_from ?? null,
      claim: x.claim,
      citable: Boolean(x.citable),
      retired: Boolean(x.retired),
      basis: x.basis ?? null,
    });
  }

  const tables = [];
  for (const t of buckets.values()) {
    if (t.rows.length < 2) continue;
    // 降序：大的在前。这个领域里「限值越大越宽松」，读起来顺。
    t.rows.sort((a, b) => b.number - a.number || String(a.scope).localeCompare(String(b.scope)));
    t.distinct = new Set(t.rows.map((r) => r.number)).size;

    // 按主体分组。
    //
    // 平铺一排数字看不出「谁是同一个人说的」。分组之后，
    // 「欧盟有两个数（现行 25 / 2030 年 10）」「WHO 有四个数（两级台阶 + 两个终点）」
    // 这些事一眼就能看见——而它们恰恰是最容易被当成一个数的。
    //
    // 组的顺序按组内最大值降序：最大那个数排最前，读起来和未分组时一致。
    const bySubject = new Map();
    for (const r of t.rows) {
      if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
      bySubject.get(r.subject).push(r);
    }
    t.groups = [...bySubject.entries()]
      .map(([subject, rows]) => ({ subject, rows, max: Math.max(...rows.map((r) => r.number)) }))
      .sort((a, b) => b.max - a.max || a.subject.localeCompare(b.subject));

    tables.push(t);
  }
  // 值越多越靠前——那才是需要看的那张表
  tables.sort((a, b) => b.distinct - a.distinct || a.metric.localeCompare(b.metric));
  return tables;
}

/**
 * 同一口径下数值打架的，单独挑出来。
 *
 * 「同口径」= 同 metric + 同 unit + 同 scope。
 * 这是唯一一种工具能说「这两个数不可能同时成立」的情况——
 * 因为 scope 说自己说的是同一件事。
 *
 * 其余的都只是「不同口径下的不同数」，摆出来让人看，不判对错。
 */
export function valueConflicts(tables) {
  const out = [];
  for (const t of tables) {
    const byScope = new Map();
    for (const r of t.rows) {
      const key = `${r.scope}\u0000${r.effective_from ?? ''}`;
      if (!byScope.has(key)) byScope.set(key, []);
      byScope.get(key).push(r);
    }
    for (const rows of byScope.values()) {
      const nums = new Set(rows.map((r) => r.number));
      if (nums.size > 1) {
        out.push({ metric: t.metric, unit: t.unit, scope: rows[0].scope, rows });
      }
    }
  }
  return out;
}
