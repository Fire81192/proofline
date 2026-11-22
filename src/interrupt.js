/**
 * 该不该打断。
 *
 * 这是「主动插话」的判定层，不产生内容，只做决定。
 * 它回答一个问题：手上这堆候选提醒，哪几条现在说、用多大强度说、走哪个通道。
 *
 * ## 为什么要有这一层
 *
 * 没有它，接进任何平台的结果都一样：模型看到问题就顺口提一句，或者干脆不提。
 * 前者是噪音，后者是沉默。两个都不叫「主动」。
 *
 * ## 判定依据（来自设计讨论第四条的收敛）
 *
 *   1. 不可逆 -> 一律硬停。没有例外。
 *      数据删了、板子烧了、论文投出去了，没有第二次。
 *   2. 代价大 -> 必须打断。不猜「他自己能不能发现」——
 *      报错不等于他理解那是个大问题，这个猜测不可靠。
 *   3. 落不到动作 -> 不说。「注意数据泄漏」没有下一步，
 *      「划分代码里 shuffle=True，改成按时间切」有下一步。
 *   4. 同一条不重复。说过且风险没变，就退到清单里，不再进正文。
 *
 * ## 强度与通道是两件事
 *
 * 强度 = 要不要他停下来（hardstop / inline / log / silent）
 * 通道 = 出现在哪儿（body 正文 / list 风险清单 / none）
 *
 * 分开的理由：已问未解的风险每次都要「在场」，但每次都在正文里念一遍
 * 就会被整段跳过。让它待在清单里，正文只在新证据出现时提。
 *
 * ## 配额只在能降级的地方生效
 *
 * 每天最多说几次、冷却多久，只作用于非不可逆的提醒。
 * 不可逆的永远不被配额压掉——那是唯一不能省的一类。
 */

import { RISK_LEVELS } from './core/schema.js';

export const LEVELS = RISK_LEVELS;

export const DEFAULT_POLICY = {
  maxPerDay: 2,        // 每天最多主动开口几次（不含清单）
  cooldownHours: 4,    // 同一条两次开口之间至少隔多久
  maxInlinePerTurn: 1, // 一轮里正文最多提几件事，多了只留最重的
  escalateAfter: 3,    // 同一个问题攒够几次「记账」才值得说
};

/** 优先级：数字越小越重。用于 maxInlinePerTurn 截断。 */
const LEVEL_WEIGHT = { 致命: 0, 失真: 1, 偏离惯例: 2, 偏好: 3 };

/**
 * 把日志重放成当前状态。状态不存，每次算。
 *
 * @param {Array<object>} records  append-only 的事件
 * @returns {Map<string, {lastSaid:number|null, lastResolved:number|null, status:string, saidCount:number}>}
 */
export function replay(records) {
  const state = new Map();
  const get = (key) => {
    if (!state.has(key)) {
      state.set(key, {
        lastSaid: null, lastListed: null, lastResolved: null, status: 'never',
        saidCount: 0, listedCount: 0, notedCount: 0,
      });
    }
    return state.get(key);
  };

  for (const r of records) {
    if (!r || typeof r.key !== 'string') continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    const s = get(r.key);
    if (r.type === 'resolved') {
      s.lastResolved = t;
      s.status = 'resolved';
      continue;
    }
    if (r.type === 'said') {
      s.lastSaid = t;
      s.saidCount += 1;
      s.status = 'open';
    } else if (r.type === 'listed') {
      // 只在清单里出现过，正文还没说过。下一轮仍有机会升级。
      s.lastListed = t;
      s.listedCount += 1;
      if (s.status === 'never') s.status = 'listed';
    } else if (r.type === 'noted') {
      // 记账不算说过：攒着，够数才升级
      s.notedCount += 1;
    }
  }
  return state;
}

/** 当天已经开口几次（不含 list 通道）。 */
function countSaidToday(records, now) {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const from = dayStart.getTime();
  let n = 0;
  for (const r of records) {
    if (!r || r.type !== 'said') continue;
    if (r.channel === 'list') continue;
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t) && t >= from) n += 1;
  }
  return n;
}

/**
 * 决定每一候选该怎么处理。
 *
 * @param {object} args
 * @param {Array<object>} args.candidates  候选提醒
 * @param {Array<object>} args.records     历史事件（append-only）
 * @param {object} [args.policy]
 * @param {string|number|Date} [args.now]
 * @returns {Array<{key:string,strength:string,channel:string,reasons:string[]}>}
 */
export function decide({ candidates, records = [], policy = {}, now = new Date() }) {
  const cfg = { ...DEFAULT_POLICY, ...policy };
  const nowMs = new Date(now).getTime();
  const state = replay(records);
  let usedToday = countSaidToday(records, nowMs);

  const out = [];
  const seenKeys = new Set();

  for (const c of candidates) {
    const reasons = [];
    const key = String(c?.key ?? '');
    if (!key) {
      out.push({ key: '', strength: 'silent', channel: 'none', reasons: ['no_key'] });
      continue;
    }
    // 同一批里同一个 key 出现两次，是候选生成层的重复。
    // 只认第一次，否则两条会各自按「历史没说过」通过，重复打扰。
    if (seenKeys.has(key)) {
      out.push({ key, strength: 'silent', channel: 'none', reasons: ['duplicate_in_batch'] });
      continue;
    }
    seenKeys.add(key);

    const level = LEVELS.includes(c.level) ? c.level : '失真';
    // 不写就当不可逆。一个以「不可逆风险不能漏」为核心的判定层，
    // 缺省必须是保守方向：宁可他多按一次确认，不能因为少写一个字段就悄悄放过。
    const reversible = c.reversible === true;
    const reversibleUnspecified = typeof c.reversible !== 'boolean';
    const cost = c.cost === 'low' ? 'low' : 'high';
    const actionable = c.actionable !== false;
    const hasAction = typeof c.action === 'string' && c.action.trim().length > 0;

    // ---- 先过「不说」的四道门 ----
    if (!hasAction) {
      out.push({ key, strength: 'silent', channel: 'none', reasons: ['no_action'] });
      continue;
    }
    if (!actionable) {
      out.push({ key, strength: 'silent', channel: 'none', reasons: ['cannot_change'] });
      continue;
    }
    if (level === '偏好') {
      out.push({ key, strength: 'silent', channel: 'none', reasons: ['preference_only'] });
      continue;
    }

    // ---- 累计升级：小事攒够次数才值得开口 ----
    const st0 = state.get(key);
    let escalated = false;
    if (st0 && st0.notedCount >= cfg.escalateAfter && level === '偏离惯例') {
      escalated = true;
      reasons.push(`escalated_after_${st0.notedCount}_notes`);
    }

    // ---- 定基础强度 ----
    let strength;
    if (!reversible) {
      strength = 'hardstop';
      reasons.push(reversibleUnspecified ? 'irreversible_assumed' : 'irreversible');
    } else if (cost === 'high' || escalated) {
      strength = 'inline';
      reasons.push(escalated ? 'high_cost_by_accumulation' : 'high_cost');
    } else {
      strength = 'log';
      reasons.push('low_cost');
    }

    // ---- 去重：正文说过的不再进正文 ----
    // 只在清单里出现过的不算说过：那只是「在场」，不是「已经告诉过他」。
    const st = state.get(key);
    if (st && st.status === 'open') {
      if (!reversible) {
        // 不可逆且已问未解：不再硬停第二次（否则会一直卡住），
        // 但要留在正文里说一句——只放清单等于把他看不见。
        out.push({ key, strength: 'inline', channel: 'body', reasons: [...reasons, 'already_open', 'kept_in_body'] });
        continue;
      }
      out.push({ key, strength: 'silent', channel: 'none', reasons: [...reasons, 'already_open'] });
      continue;
    }

    // 说过 -> 解决 -> 又出现：这才叫 reopened（解决晚于最后一次说）
    if (st && st.status === 'resolved' && st.lastSaid !== null && st.lastResolved !== null
        && st.lastResolved > st.lastSaid) {
      reasons.push('reopened');
    }

    // ---- 冷却：同一条太频繁就退到清单 ----
    // 只作用于本来要进正文的（inline）。log 是「完全不打扰」，
    // 把它推成清单反而是增加噪音。
    if (st && st.lastSaid !== null && strength === 'inline') {
      const hours = (nowMs - st.lastSaid) / 3_600_000;
      if (hours < cfg.cooldownHours) {
        out.push({ key, strength: 'inline', channel: 'list', reasons: [...reasons, 'cooldown'] });
        continue;
      }
    }

    // ---- 日配额：只压本来要进正文的 ----
    // hardstop 不受限（不可逆不能因为配额被压掉）；
    // log 也不该被推成清单——那是把「不打扰」变成「打扰」。
    if (strength === 'inline' && usedToday >= cfg.maxPerDay) {
      out.push({ key, strength: 'inline', channel: 'list', reasons: [...reasons, 'daily_cap'] });
      continue;
    }

    const channel = strength === 'log' ? 'none' : 'body';
    if (channel === 'body') usedToday += 1; // 本批已经说出去的，也要占配额
    out.push({ key, strength, channel, reasons });
  }

  // ---- 一轮里正文最多留几件，按严重度取前几个 ----
  const inBody = out
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.channel === 'body' && d.strength !== 'log');

  if (inBody.length > cfg.maxInlinePerTurn) {
    const ranked = [...inBody].sort((a, b) => {
      const la = LEVEL_WEIGHT[candidates[a.i]?.level] ?? 1;
      const lb = LEVEL_WEIGHT[candidates[b.i]?.level] ?? 1;
      return la - lb;
    });
    for (const { d } of ranked.slice(cfg.maxInlinePerTurn)) {
      if (d.strength === 'hardstop') continue; // 不可逆的不降级
      d.strength = 'inline';
      d.channel = 'list';
      d.reasons.push('turn_limit');
    }
  }

  return out;
}

/** 把决策里需要记的那些，变成可以追加进日志的事件。 */
export function toRecords(decisions, { project, now = new Date() } = {}) {
  const ts = new Date(now).toISOString();
  return decisions
    .filter((d) => d.strength !== 'silent')
    .map((d) => {
      let type = 'noted';
      if (d.strength === 'hardstop' || d.channel === 'body') type = 'said';
      else if (d.channel === 'list') type = 'listed';
      return { ts, project, key: d.key, type, strength: d.strength, channel: d.channel };
    });
}
