/**
 * 四态校验。
 *
 *   pass       干净
 *   fixed      有机械问题，能修，修好了
 *   dirty      有机械问题，能修，但没让修（没给 --fix）
 *   hard_fail  语义或证据层面废了，拒绝写入
 *
 * 分界线只有一条：**这个检查能不能写成代码**。
 * 空白、大小写、日期格式、id 与目录名不一致 —— 能写成代码，算机械问题。
 * 引文在不在原文里 —— 也能写成代码，所以它也是机械检查。但它一旦不过，
 * 就不是「修一下」能好的：引文对不上原文，这条证据就是假的，只能作废。
 * 「这条主张对不对」—— 写不成代码，这里根本不检查，交给两个 verdict 字段。
 *
 * 一条硬规则：**verdict 字段永不自动修**。
 * `证据状态: 支持` 这种写法不会被猜成 `supported`，直接 hard_fail。
 * 猜一次，这条判定就变成了我们替作者下的结论。
 */

import { FrontmatterError, parseFrontmatter, joinFrontmatter } from './frontmatter.js';
import { locateAll, containsValue } from './quote.js';
import { sha256 } from './snapshot.js';
import {
  CHECK_TYPES, DATE_RE, GAP_ACTIONS, GAP_DIMENSIONS, ID_RE, KINDS, LAYERS, LIMITS, KEY_ORDER,
  BASIS, PUBLISHED_RE, REQUIRED, RISK_COSTS, RISK_LEVELS, RUN_REQUIRED, SHA256_RE, TOPIC_RE,
  SOURCE_EXTRACTIONS, SOURCE_KINDS, VERDICTS,
} from './schema.js';

/** 路径不合规时统一加这句：说清怎么改，不让人对着报错猜。 */
const PATH_HINT = '\n  用正斜杠写，例如 raw/verify-1.txt。反斜杠和盘符路径都不接受——'
  + '它们在不同平台上含义不同，路径必须是可移植的。';

const PARTIAL_DATE = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/;

/** 日期范围自洽：2026-13-45 形状对但不存在。 */
function isRealDate(value) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = m[2] === undefined ? 1 : Number(m[2]);
  const d = m[3] === undefined ? 1 : Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function normalizeDate(value) {
  if (typeof value !== 'string') return value;
  const m = PARTIAL_DATE.exec(value.trim());
  if (!m) return value;
  const [, y, mo, d] = m;
  if (!mo) return y;
  if (!d) return `${y}-${mo.padStart(2, '0')}`;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function trimStrings(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && k !== 'claim' && k !== 'source_sha256') out[k] = v.trim();
    else out[k] = v;
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} args.dirName   条目目录名（真相）
 * @param {string} args.text      entry.md 全文
 * @param {string|null} args.snapshotText  快照内容，缺失传 null
 * @param {((rel:string)=>string|null)|null} [args.readSnapshot] 读条目目录内其他快照（佐证用）
 * @param {boolean} args.fix      是否允许写回机械修复
 * @returns {{status:string,data:object|null,body:string,autofixes:string[],hardFails:string[],text:string|null}}
 */
export function validateEntry({ dirName, text, snapshotText, readSnapshot = null, fix = false }) {
  const autofixes = [];
  const hardFails = [];
  const fail = (msg) => { hardFails.push(msg); };

  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    if (err instanceof FrontmatterError) {
      return { status: 'hard_fail', data: null, body: '', autofixes, hardFails: [`frontmatter 解析失败：${err.message}`], text: null };
    }
    throw err;
  }

  if (Object.keys(parsed.data).length === 0) {
    return { status: 'hard_fail', data: null, body: parsed.body, autofixes, hardFails: ['没有 frontmatter'], text: null };
  }

  // ---- 机械修复：只动形状，不动意思 ----
  let data = trimStrings(parsed.data);

  if (!('schema' in data)) {
    data.schema = 1;
    autofixes.push('补 schema: 1');
  }

  if (typeof data.id === 'string' && data.id !== dirName) {
    autofixes.push(`id ${JSON.stringify(data.id)} -> ${JSON.stringify(dirName)}（以目录名为准）`);
    data.id = dirName;
  }

  for (const key of ['evidence_status', 'world_status']) {
    if (typeof data[key] === 'string' && data[key] !== data[key].toLowerCase()) {
      const lowered = data[key].toLowerCase();
      autofixes.push(`${key} ${JSON.stringify(data[key])} -> ${JSON.stringify(lowered)}（只改大小写）`);
      data[key] = lowered;
    }
  }

  if (Array.isArray(data.quotes)) {
    const seen = new Set();
    const kept = [];
    for (const q of data.quotes) {
      if (typeof q !== 'string') { kept.push(q); continue; }
      const collapsed = q.replace(/\s+/g, ' ').trim();
      if (!collapsed) { autofixes.push('丢掉一条空引文'); continue; }
      if (seen.has(collapsed)) { autofixes.push(`丢掉重复引文：${JSON.stringify(collapsed.slice(0, 30))}`); continue; }
      seen.add(collapsed);
      if (collapsed !== q) autofixes.push(`引文空白归一：${JSON.stringify(q.slice(0, 30))}`);
      // 存归一化后的值。存原值等于「报了要修却不动手」，下次校验还会报同一条。
      kept.push(collapsed);
    }
    data.quotes = kept;
  }

  for (const key of ['source_published_at', 'added_at']) {
    if (typeof data[key] === 'string') {
      const fixed = normalizeDate(data[key]);
      if (fixed !== data[key]) {
        autofixes.push(`${key} ${JSON.stringify(data[key])} -> ${JSON.stringify(fixed)}`);
        data[key] = fixed;
      }
    }
  }

  if (Array.isArray(data.gaps)) {
    data.gaps = data.gaps.map((g) => {
      if (g && typeof g.action === 'string' && g.action !== g.action.toLowerCase()) {
        const lowered = g.action.toLowerCase();
        autofixes.push(`gap.action ${JSON.stringify(g.action)} -> ${JSON.stringify(lowered)}`);
        return { ...g, action: lowered };
      }
      return g;
    });
  }

  // ---- 硬失败：形状废了，或者证据对不上 ----
  //
  // 判断档豁免来源形态两项：推理没有来源，要求它申报
  // 「这是论文还是视频」「快照是 OCR 还是原文」是没有意义的填空。
  // 其余字段照样必填——「想出来的」不是「什么都免」。
  const judged = data.basis === '判断';
  const required = judged
    ? REQUIRED.filter((k) => k !== 'source_kind' && k !== 'source_extraction')
    : REQUIRED;
  for (const key of required) {
    if (!(key in data) || data[key] === null || data[key] === '') {
      fail(`缺必填字段 ${key}`);
    }
  }

  // 格式版本必须认识。不认识的版本被当 v1 读，等于把未来的字段当噪声吞掉。
  if (data.schema !== undefined && data.schema !== 1) {
    fail(`schema 必须是 1，现在是 ${JSON.stringify(data.schema)}——不认识的格式版本不能当 v1 读`);
  }

  // 必填只查了「在不在」，没查「是不是字符串」。
  // YAML 会把 `claim: {a: 1}` 解析成对象、`id: 123` 解析成数字，
  // 两者都能过 pass——最核心的两个字段，形状闸门对它们失效。
  if (data.claim !== undefined && typeof data.claim !== 'string') {
    fail(`claim 必须是字符串，现在是 ${Array.isArray(data.claim) ? 'array' : typeof data.claim}`);
  }
  if (data.id !== undefined && typeof data.id !== 'string') {
    fail(`id 必须是字符串，现在是 ${typeof data.id}`);
  }

  if (typeof data.claim === 'string') {
    const len = data.claim.length;
    if (len < LIMITS.claimMinChars) fail(`claim 太短（${len} < ${LIMITS.claimMinChars}）`);
    if (len > LIMITS.claimMaxChars) fail(`claim 太长（${len} > ${LIMITS.claimMaxChars}）`);
  }

  const enumChecks = [
    ['kind', KINDS],
    ['layer', LAYERS],
    ['basis', BASIS],
    ['source_kind', SOURCE_KINDS],
    ['source_extraction', SOURCE_EXTRACTIONS],
    ['evidence_status', VERDICTS],
    ['world_status', VERDICTS],
  ];
  for (const [key, allowed] of enumChecks) {
    if (data[key] !== undefined && data[key] !== null && !allowed.includes(data[key])) {
      fail(`${key} 的取值 ${JSON.stringify(data[key])} 不在允许集合里：${allowed.join(' / ')}`);
    }
  }

  // 快照是二手的时候，必须说清原件在哪
  if (typeof data.source_extraction === 'string' && data.source_extraction !== '原文'
      && !(typeof data.source_original === 'string' && data.source_original.trim())) {
    fail(`快照来源是「${data.source_extraction}」，必须填 source_original（原件在哪）`);
  }

  if (typeof data.id === 'string' && !ID_RE.test(data.id)) {
    fail(`id ${JSON.stringify(data.id)} 不符合 日期-短名 格式`);
  }

  if (data.source_published_at !== undefined && !PUBLISHED_RE.test(String(data.source_published_at))) {
    fail('source_published_at 只支持 2024 / 2024-05 / 2024-05-17 三种精度');
  } else if (data.source_published_at !== undefined && !isRealDate(String(data.source_published_at))) {
    fail(`source_published_at ${JSON.stringify(data.source_published_at)} 不是真实存在的日期`);
  }
  if (typeof data.source_published_at === 'string' && !data.source_available_basis) {
    fail('填了 source_published_at 就必须填 source_available_basis（凭什么认为那天可公开获得）');
  }
  if (data.topic !== undefined) {
    if (typeof data.topic !== 'string' || data.topic.trim() === '') {
      fail('topic 必须是非空字符串');
    } else if (!TOPIC_RE.test(data.topic)) {
      fail(`topic 「${data.topic}」不合规：小写、点分、不含空格，如 ppg.preprocess`);
    }
  }

  // 两层缺一不可：DATE_RE 管「必须是完整日期」，isRealDate 管「那天真的存在」。
  // 只留 isRealDate 会放过 '2024'（它是合法的部分日期），而那正是
  // source_published_at 允许、added_at 不允许的事。
  if (data.added_at !== undefined && !DATE_RE.test(String(data.added_at))) {
    fail('added_at 必须是完整日期 YYYY-MM-DD');
  } else if (data.added_at !== undefined && !isRealDate(String(data.added_at))) {
    fail(`added_at ${JSON.stringify(data.added_at)} 不是真实存在的日期`);
  }

  // 引文：数量、长度
  const quotes = Array.isArray(data.quotes) ? data.quotes : null;
  if ('quotes' in data && quotes === null) {
    fail('quotes 必须是数组');
  } else if (quotes) {
    if (quotes.length > LIMITS.maxQuotes) fail(`引文超过 ${LIMITS.maxQuotes} 条`);
    for (const [i, q] of quotes.entries()) {
      if (typeof q !== 'string') { fail(`第 ${i + 1} 条引文不是字符串`); continue; }
      if (q.length > LIMITS.quoteMaxChars) fail(`第 ${i + 1} 条引文超过 ${LIMITS.quoteMaxChars} 字符`);
    }
  }

  // 缺口：动作与定位必须配套
  if (data.gaps !== undefined) {
    if (!Array.isArray(data.gaps)) fail('gaps 必须是数组');
    else {
      if (data.gaps.length > LIMITS.maxGaps) fail(`缺口超过 ${LIMITS.maxGaps} 条`);
      data.gaps.forEach((g, i) => {
        const at = `缺口 #${i + 1}`;
        if (!g || typeof g !== 'object' || Array.isArray(g)) { fail(`${at} 不是对象`); return; }
        if (typeof g.question !== 'string' || !g.question.trim()) fail(`${at} 缺 question`);
        if (!GAP_ACTIONS.includes(g.action)) fail(`${at} 的 action ${JSON.stringify(g.action)} 不在 ${GAP_ACTIONS.join(' / ')}`);
        if (g.action !== 'search' && !(typeof g.locator === 'string' && g.locator.trim())) {
          fail(`${at} 的 action 是 ${g.action}，必须给 locator（去哪儿补）`);
        }
        if (g.blocking !== undefined && typeof g.blocking !== 'boolean') fail(`${at} 的 blocking 必须是 true/false`);
        // dimension 以前完全不查：拼成 `evidenc` 也能过，然后在 status 里
        // 两个维度都分不到桶，一个 blocking 缺口凭空消失。
        if (g.dimension !== undefined && !GAP_DIMENSIONS.includes(g.dimension)) {
          fail(`${at} 的 dimension ${JSON.stringify(g.dimension)} 不认识，只能是 ${GAP_DIMENSIONS.join(' / ')}`);
        }
        if (g.blocking === true && g.dimension === undefined) {
          fail(`${at} 标了 blocking，必须说清是哪一维（dimension: ${GAP_DIMENSIONS.join(' / ')}）——不说清，它谁的账都不进`);
        }
      });
    }
  }

  // 退役是可逆的「不再当依据」，不是删除。所以它必须留下三样东西：
  // 什么时候、为什么、有没有后继者。少一样，三个月后没人说得清这条为什么躺在库里。
  if ('deprecated' in data && data.deprecated !== null) {
    const d = data.deprecated;
    if (typeof d !== 'object' || Array.isArray(d)) {
      fail('deprecated 必须是 {at, reason, superseded_by?} 这样的对象');
    } else {
      const extra = Object.keys(d).filter((k) => !['at', 'reason', 'superseded_by'].includes(k));
      if (extra.length) {
        fail(`deprecated 有来路不明的键：${extra.join(', ')}——结构不是注释位`);
      }
      if (typeof d.at !== 'string' || !DATE_RE.test(d.at)) {
        fail(`deprecated.at 必须是完整日期 YYYY-MM-DD，现在是 ${JSON.stringify(d.at)}`);
      } else if (!isRealDate(d.at)) {
        fail(`deprecated.at ${JSON.stringify(d.at)} 那天不存在`);
      }
      if (typeof d.reason !== 'string' || d.reason.trim().length < 8) {
        fail('deprecated.reason 不能空——退役必须给理由，否则三个月后没人记得为什么');
      }
      if (d.superseded_by !== undefined) {
        if (typeof d.superseded_by !== 'string' || !ID_RE.test(d.superseded_by)) {
          fail(`deprecated.superseded_by 必须是条目 id，现在是 ${JSON.stringify(d.superseded_by)}`);
        } else if (d.superseded_by === data.id) {
          fail('deprecated.superseded_by 指向自己——被谁取代了这一栏要填别人');
        }
      }
    }
  }

  /**
   * 数值字段。
   *
   * 存在的理由：「35 μg/m³」在 claim 里只是一句话的一部分，工具既不能比较
   * 也不能排序。于是「同一个指标五个不同数值」这种事，只能靠人一句一句读出来。
   *
   * 四个字段都必须填。尤其 `scope`——**不写清「这个数适用于谁」，这个数就没法比**。
   * 而「写 scope」这个动作会逼人想一件事：我说的是中国的限值，还是 WHO 的过渡目标？
   * 想清楚之后，很多「矛盾」自己就消失了。
   */
  if ('value' in data && data.value !== null) {
    const v = data.value;
    if (typeof v !== 'object' || Array.isArray(v)) {
      fail('value 必须是 {metric, number, unit, scope} 这样的对象');
    } else {
      const extra = Object.keys(v).filter((k) => !['metric', 'number', 'unit', 'scope', 'subject', 'effective_from', 'note'].includes(k));
      if (extra.length) fail(`value 有来路不明的键：${extra.join(', ')}——结构不是注释位`);

      if (typeof v.metric !== 'string' || !TOPIC_RE.test(v.metric)) {
        fail(`value.metric 必须是小写点分名（如 pm25.annual），现在是 ${JSON.stringify(v.metric)}`);
      }
      if (typeof v.number !== 'number' || !Number.isFinite(v.number)) {
        fail(`value.number 必须是有限数字，现在是 ${JSON.stringify(v.number)}`);
      }
      if (typeof v.unit !== 'string' || v.unit.trim() === '') {
        fail('value.unit 不能空——没有单位的数不是数值，是符号');
      } else if (v.unit.length > LIMITS.maxValueUnitChars) {
        fail(`value.unit 太长（上限 ${LIMITS.maxValueUnitChars} 字符）`);
      }
      if (typeof v.scope !== 'string' || v.scope.trim() === '') {
        fail('value.scope 不能空——不写清「这个数适用于谁」，它就没法跟别的数比');
      } else if (v.scope.length > LIMITS.maxValueScopeChars) {
        fail(`value.scope 太长（上限 ${LIMITS.maxValueScopeChars} 字符）`);
      }
      // subject 是 scope 的粗粒度版本：scope 说「哪个规定的数」，subject 说「谁规定的」。
      // 分开是因为「中国」和「中国 GB 3095-2012 二级」用途不同：
      //   前者用来把表按主体分组（一眼看到「这个主体有几个数」）
      //   后者用来判断两个值是不是同口径（能不能说「不可能同时成立」）
      if (typeof v.subject !== 'string' || v.subject.trim() === '') {
        fail('value.subject 不能空——写清这个数是谁的（中国 / WHO / 欧盟 / 美国），表要靠它分组');
      } else if (v.subject.length > LIMITS.maxValueSubjectChars) {
        fail(`value.subject 太长（上限 ${LIMITS.maxValueSubjectChars} 字符）`);
      }
      if (v.effective_from !== undefined) {
        if (typeof v.effective_from !== 'string' || !DATE_RE.test(v.effective_from)) {
          fail(`value.effective_from 必须是完整日期 YYYY-MM-DD，现在是 ${JSON.stringify(v.effective_from)}`);
        } else if (!isRealDate(v.effective_from)) {
          fail(`value.effective_from ${JSON.stringify(v.effective_from)} 那天不存在`);
        }
      }
    }
  }

  /**
   * 这条主张不能被用来干什么。
   *
   * 门槛跟着杀伤力走：**声明上像「能下判断」的条目必须填，其余可选。**
   *
   * 理由是杀伤半径不同。一条能当依据去否定别人的主张，被推过头会伤人；
   * 一条本来就不可引用的主张，推过头最多是自娱自乐，不值得加一道卡。
   *
   * 它和 gaps 的区别：gaps 是「还缺什么才能成立」，not_for 是「已经成立，
   * 但别拿它干这些事」。一个往前看，一个往后看。
   */
  if ('not_for' in data && data.not_for !== null) {
    if (!Array.isArray(data.not_for)) {
      fail('not_for 必须是字符串数组');
    } else if (data.not_for.length === 0) {
      fail('not_for 是空数组——要么删掉这个字段，要么写出至少一条');
    } else if (data.not_for.length > LIMITS.maxNotFor) {
      fail(`not_for 最多 ${LIMITS.maxNotFor} 条——写得越多越像免责声明，反而没人读`);
    } else {
      const seen = new Set();
      data.not_for.forEach((x, i) => {
        if (typeof x !== 'string') {
          fail(`not_for #${i + 1} 不是字符串`);
          return;
        }
        const t = x.trim();
        if (t.length < LIMITS.notForMinChars) {
          fail(`not_for #${i + 1} 太短（至少 ${LIMITS.notForMinChars} 字）——「别乱用」不算说清`);
        } else if (t.length > LIMITS.maxNotForChars) {
          fail(`not_for #${i + 1} 太长（上限 ${LIMITS.maxNotForChars} 字）`);
        }
        if (seen.has(t)) fail(`not_for #${i + 1} 和前面重复了`);
        seen.add(t);
      });
    }
  }

  // 注意：缺 not_for **不是** hard_fail。
  //
  // 试过硬失败，结果撞上一个死锁：一条老条目同时缺 basis 和 not_for，
  // `set basis` 被 not_for 挡住、`set not_for` 被 basis 挡住，两个都补不上。
  //
  // 更根本的问题是：「能当依据却没说边界」不是数据错误，是质量缺陷。
  // 数据错误用报错挡（挡得住），质量缺陷用机制挡（挡得住以后每一次）——
  // 所以判在 deriveStatus 里：缺 not_for 的条目不判 decisive。
  // 这里只保留形状校验（上面那段）。

  // prereq 只放条目 id。填错类型以前会被静默丢掉，视图显示为空数组——
  // 「有前置依赖」和「没有前置依赖」看起来一样。
  if ('prereq' in data) {
    if (!Array.isArray(data.prereq)) {
      fail('prereq 必须是数组');
    } else {
      data.prereq.forEach((p, i) => {
        if (typeof p !== 'string' || !ID_RE.test(p)) {
          fail(`prereq #${i + 1} 不是合法的条目 id：${JSON.stringify(p)}`);
        }
      });
    }
  }

  /**
   * 推理链：这条判断是从哪几条推出来的。
   *
   * 只允许在 basis=判断 时出现。条目档说「原文这么讲」、实测档说「我跑出来这样」，
   * 都不需要「从哪几条推的」——写了反而说明这条分不清自己是读的还是想的。
   *
   * 有了它，判断档才不是一坨黑：3/3 可引用和 0/3 都是判断，
   * 但一种是把三条能引的事实摆在一起，一种是我自己想的。
   */
  if ('derived_from' in data && data.derived_from !== null) {
    if (!Array.isArray(data.derived_from)) {
      fail('derived_from 必须是条目 id 的数组');
    } else if (data.derived_from.length === 0) {
      fail('derived_from 是空数组——要么删掉这个字段，要么写出至少一条');
    } else if (data.basis !== '判断') {
      fail(`derived_from 只在 basis=判断 时有意义；这条是「${data.basis}」——它有原文或实测，不需要「从哪几条推的」`);
    } else {
      data.derived_from.forEach((p, i) => {
        if (typeof p !== 'string' || !ID_RE.test(p)) {
          fail(`derived_from #${i + 1} 不是合法的条目 id：${JSON.stringify(p)}`);
        } else if (p === data.id) {
          fail('derived_from 指向自己——推不出自己的');
        }
      });
      if (new Set(data.derived_from).size !== data.derived_from.length) {
        fail('derived_from 有重复的 id');
      }
    }
  }

  // ---- 证据地基：要么可核，要么明确标「没核」----
  // ---- 依据三档：这条是读来的、跑出来的，还是想出来的 ----
  //
  // 判断档存在的理由：纯推理的结论以前根本进不了库——要么必须找到一份出处
  // （于是它被写成「条目」，尽管原文并没说这个结论），要么塞进 kind: 观点
  // （而 kind 说的是「怎么用」，不是「凭什么知道」）。结果是这类结论只能
  // 留在报告里，下次谁都不记得它是怎么来的。
  //
  // 给它开口子，但要同时上三道锁：不许声称来源支持它、必须说明打算怎么验证、
  // 不许同时挂实测。少一道，这个口子就变成「随便写点什么都能入库」。
  if (data.basis === '判断') {
    if (data.evidence_status !== 'not_checked') {
      fail(`basis 是「判断」时 evidence_status 只能是 not_checked——原文并没有说这个结论，现在是 ${JSON.stringify(data.evidence_status)}`);
    }
    const gapList = Array.isArray(data.gaps) ? data.gaps : [];
    if (gapList.length === 0) {
      fail('basis 是「判断」就必须至少给一条 gaps——说不出「打算怎么验证」的推理只是猜测');
    }
    if (Array.isArray(data.runs) && data.runs.length > 0) {
      fail('basis 是「判断」却给了 runs——跑过了就算实测，请改成 basis: 实测');
    }
  }
  if (data.basis === '实测') {
    const runList = Array.isArray(data.runs) ? data.runs : [];
    if (runList.length === 0) {
      fail('basis 是「实测」就必须至少给一条 runs——没有实测记录的「实测」是空的');
    }
  }

  const hasSha = typeof data.source_sha256 === 'string' && data.source_sha256 !== '';

  if (!hasSha) {
    // 没有原文快照就等于没有证据。只允许明确标「没查过」。
    if (quotes && quotes.length > 0) {
      fail('没有 source_sha256 却给了引文——引文没法核，等于没有证据');
    }
    if (data.basis === '条目') {
      fail('basis 写「条目」就必须有 source_sha256 和能定位的引文——「读来的」不能没有原文');
    }
    if (data.evidence_status !== 'not_checked') {
      fail(`没有原文快照时 evidence_status 只能是 not_checked，现在是 ${JSON.stringify(data.evidence_status)}`);
    }
  } else if (!SHA256_RE.test(data.source_sha256)) {
    fail('source_sha256 不是 64 位小写十六进制');
  } else {
    if (!quotes || quotes.length === 0) {
      fail('有 source_sha256 就必须至少给一条引文');
    } else if (snapshotText === null) {
      fail('找不到原文快照 raw/source.txt');
    } else if (sha256(snapshotText) !== data.source_sha256) {
      fail('快照哈希对不上——原文被改过，或者 sha256 记错了');
    } else if (quotes.every((q) => typeof q === 'string')) {
      const located = locateAll(snapshotText, quotes);
      located.results.forEach((r) => {
        if (!r.ok) fail(`第 ${r.index + 1} 条引文在快照里定位不到：${JSON.stringify(r.quote.slice(0, 40))}`);
      });
    }
  }

  // ---- 可检查条件：能变成扫描规则的那种 ----
  if ('checks' in data && !Array.isArray(data.checks)) {
    fail('checks 必须是数组');
  } else if (Array.isArray(data.checks)) {
    const checks = data.checks;
    if (checks.length > LIMITS.maxChecks) fail(`checks 超过 ${LIMITS.maxChecks} 条`);
    checks.forEach((c, i) => {
      const at = `检查 #${i + 1}`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) { fail(`${at} 不是对象`); return; }
      if (!CHECK_TYPES.includes(c.type)) fail(`${at} 的 type 必须是 ${CHECK_TYPES.join(' / ')}`);

      for (const key of ['present', 'absent']) {
        if (c[key] === undefined) continue;
        if (typeof c[key] !== 'string' || c[key].trim() === '') {
          fail(`${at} 的 ${key} 必须是非空字符串`);
          continue;
        }
        if (c[key].length > LIMITS.checkPatternMaxChars) {
          fail(`${at} 的 ${key} 太长（上限 ${LIMITS.checkPatternMaxChars} 字符）`);
          continue;
        }
        // term 是普通子串，不按正则解释——「MinMax(A)」在 term 里合法，
        // 在 pattern 里是非法正则。这两条路不能混，混了就会因为一个括号
        // 拒掉一条本来能用的检查。
        if (c.type === 'term') continue;
        try {
          new RegExp(c[key]);
        } catch (err) {
          fail(`${at} 的 ${key} 不是合法正则：${err.message}`);
        }
      }
      if (typeof c.present !== 'string' || c.present.trim() === '') {
        fail(`${at} 缺 present（必须说清「代码里出现什么算踩坑」）`);
      }
      // scope 限定这条规则只在哪些文件上生效。不填就是全库生效——
      // 对「PPG 要先滤波」这类规则来说，全库生效等于全库误报。
      if (c.scope !== undefined) {
        if (typeof c.scope !== 'string' || c.scope.trim() === '') {
          fail(`${at} 的 scope 必须是非空字符串`);
        } else {
          try {
            new RegExp(c.scope);
          } catch (err) {
            fail(`${at} 的 scope 不是合法正则：${err.message}`);
          }
        }
      }
      if (!RISK_LEVELS.includes(c.level)) fail(`${at} 的 level 不在 ${RISK_LEVELS.join(' / ')} 里`);
      if (!RISK_COSTS.includes(c.cost)) fail(`${at} 的 cost 必须是 low 或 high`);
      if (typeof c.reversible !== 'boolean') {
        fail(`${at} 的 reversible 必须是显式的 true / false（不许缺省——缺省会被当成不可逆）`);
      }
      if (typeof c.action !== 'string' || c.action.trim() === '') {
        fail(`${at} 缺 action（指不出下一步的检查不该存在）`);
      }
    });
  }

  // ---- 佐证：声称「世界为真」就必须给出能定位的第二来源 ----
  const corrob = Array.isArray(data.corroborations) ? data.corroborations : null;
  if ('corroborations' in data && corrob === null) {
    fail('corroborations 必须是数组');
  } else if (corrob) {
    if (corrob.length > LIMITS.maxCorroborations) {
      fail(`佐证超过 ${LIMITS.maxCorroborations} 条`);
    }
    corrob.forEach((c, i) => {
      const at = `佐证 #${i + 1}`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) { fail(`${at} 不是对象`); return; }
      if (typeof c.uri !== 'string' || !c.uri.trim()) fail(`${at} 缺 uri`);
      if (typeof c.quote !== 'string' || !c.quote.trim()) fail(`${at} 缺 quote`);
      else if (c.quote.length > LIMITS.corroborationQuoteMaxChars) fail(`${at} 的 quote 太长`);
      if (typeof c.sha256 !== 'string' || !SHA256_RE.test(c.sha256)) fail(`${at} 的 sha256 不是 64 位小写十六进制`);
      if (typeof c.snapshot !== 'string' || !c.snapshot.trim()) { fail(`${at} 缺 snapshot`); return; }
      // 路径必须在条目目录内。
      // 这是字符串层的粗筛，真正的保证在 store.loadSnapshotMap 的解析后检查。
      // 两层都要有：字符串层负责给清楚的报错，解析层负责堵住绕过。
      const unsafePath =
        c.snapshot.startsWith('/') ||
        c.snapshot.startsWith('~') ||
        c.snapshot.includes('..') ||
        c.snapshot.includes('\\') ||
        /^[A-Za-z]:/.test(c.snapshot); // 盘符 + 正斜杠这种写法，原来漏了
      if (unsafePath) {
        fail(`${at} 的 snapshot 路径不安全（必须是条目目录内的相对路径）：${c.snapshot}${PATH_HINT}`);
        return;
      }
      // 有佐证却读不到佐证快照，等于没法核。不许静默放行。
      if (typeof readSnapshot !== 'function') {
        fail(`${at}：调用方没有提供快照读取器，佐证无法核验`);
        return;
      }
      const snap = readSnapshot(c.snapshot);
      if (snap === null || snap === undefined) { fail(`${at} 的快照找不到：${c.snapshot}`); return; }
      if (SHA256_RE.test(String(c.sha256)) && sha256(snap) !== c.sha256) {
        fail(`${at} 的快照哈希对不上`);
        return;
      }
      if (typeof c.quote === 'string' && locateAll(snap, [c.quote]).ok === false) {
        fail(`${at} 的引文在自己的快照里定位不到`);
      }
    });
  }

  // ---- 实测复跑：脚本 + 原始输出 + 期望值，三点成环 ----
  const runs = Array.isArray(data.runs) ? data.runs : null;
  if ('runs' in data && runs === null) {
    fail('runs 必须是数组');
  } else if (runs) {
    if (runs.length > LIMITS.maxRuns) fail(`runs 超过 ${LIMITS.maxRuns} 条`);
    runs.forEach((r, i) => {
      const at = `实测 #${i + 1}`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) { fail(`${at} 不是对象`); return; }
      for (const key of RUN_REQUIRED) {
        if (!(key in r)) fail(`${at} 缺 ${key}`);
      }

      // script 相对 workspace 根。字符串层只做粗筛，真正的边界保证在
      // store.resolveInside —— 两层都要，一层给清楚的报错，一层堵绕过。
      if (typeof r.script === 'string' && r.script.trim() !== '') {
        const unsafe =
          r.script.startsWith('/') ||
          r.script.startsWith('~') ||
          r.script.includes('..') ||
          r.script.includes('\\') ||
          /^[A-Za-z]:/.test(r.script);
        if (unsafe) {
          fail(`${at} 的 script 路径不安全（必须是 workspace 内的相对路径）：${r.script}${PATH_HINT}`);
        }
      } else if ('script' in r) {
        fail(`${at} 的 script 必须是非空字符串`);
      }

      // 非字符串不能跳过——「类型不对」和「格式不对」一样是坏数据，
      // 放过它等于让一条结构不合规的 run 入库。
      if (typeof r.script_sha256 !== 'string' || !SHA256_RE.test(r.script_sha256)) {
        fail(`${at} 的 script_sha256 必须是 64 位小写十六进制`);
      }

      // output 是条目目录内的快照，和 corroboration.snapshot 同一套边界规则。
      if (typeof r.output === 'string' && r.output.trim() !== '') {
        const unsafe =
          r.output.startsWith('/') ||
          r.output.startsWith('~') ||
          r.output.includes('..') ||
          r.output.includes('\\') ||
          /^[A-Za-z]:/.test(r.output);
        if (unsafe) {
          fail(`${at} 的 output 路径不安全（必须是条目目录内的相对路径）：${r.output}${PATH_HINT}`);
        }
      } else if ('output' in r) {
        fail(`${at} 的 output 必须是非空字符串`);
      }

      if (typeof r.output_sha256 !== 'string' || !SHA256_RE.test(r.output_sha256)) {
        fail(`${at} 的 output_sha256 必须是 64 位小写十六进制`);
      }

      if (typeof r.cmd === 'string' && r.cmd.length > LIMITS.maxRunCmdChars) {
        fail(`${at} 的 cmd 太长（上限 ${LIMITS.maxRunCmdChars} 字符）`);
      }
      if (typeof r.env === 'string' && r.env.length > LIMITS.maxRunEnvChars) {
        fail(`${at} 的 env 太长（上限 ${LIMITS.maxRunEnvChars} 字符）`);
      }

      // inputs：这次运行依赖的上游产物。可选——单步实验没有上游。
      // 有的话每一项都要能定位，否则「声明了依赖但对不上」比「没声明」更坏：
      // 它会让人以为链子是完整的。
      if ('inputs' in r) {
        if (!Array.isArray(r.inputs)) {
          fail(`${at} 的 inputs 必须是数组`);
        } else {
          if (r.inputs.length > LIMITS.maxRunInputs) fail(`${at} 的 inputs 超过 ${LIMITS.maxRunInputs} 条`);
          r.inputs.forEach((inp, j) => {
            const where = `${at} 的上游 #${j + 1}`;
            if (!inp || typeof inp !== 'object' || Array.isArray(inp)) { fail(`${where} 不是对象`); return; }
            if (typeof inp.path !== 'string' || inp.path.trim() === '') { fail(`${where} 缺 path`); return; }
            const unsafe =
              inp.path.startsWith('/') ||
              inp.path.startsWith('~') ||
              inp.path.includes('..') ||
              inp.path.includes('\\') ||
              /^[A-Za-z]:/.test(inp.path);
            if (unsafe) fail(`${where} 的 path 路径不安全（必须是 workspace 内的相对路径）：${inp.path}${PATH_HINT}`);
            if (typeof inp.sha256 !== 'string' || !SHA256_RE.test(inp.sha256)) {
              fail(`${where} 的 sha256 不是 64 位小写十六进制`);
            }
          });
        }
      }

      if ('at' in r) {
        if (!DATE_RE.test(String(r.at))) fail(`${at} 的 at 不是 YYYY-MM-DD`);
        else if (!isRealDate(String(r.at))) fail(`${at} 的 at ${JSON.stringify(r.at)} 不是真实存在的日期`);
      }

      // expect：键值对，值必须是字符串。
      // 数值不许直接写——JSON 里 4.02 和 4.020 序列化出来不一样，
      // 而「在输出里找得到」是子串匹配，差一个尾零就核不上。
      // 强制字符串，是为了让「怎么写的」和「怎么比的」是同一个东西。
      const expect = r.expect;
      if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) {
        fail(`${at} 的 expect 必须是对象`);
      } else {
        const keys = Object.keys(expect);
        if (keys.length === 0) fail(`${at} 的 expect 不能为空——没有期望值的实测没法核`);
        if (keys.length > LIMITS.maxRunExpectKeys) fail(`${at} 的 expect 键超过 ${LIMITS.maxRunExpectKeys} 个`);
        for (const k of keys) {
          if (typeof expect[k] !== 'string') {
            fail(`${at} 的 expect.${k} 必须是字符串（数字请带引号，保持字面一致）`);
          } else if (expect[k] === '') {
            fail(`${at} 的 expect.${k} 是空字符串`);
          } else if (expect[k].length > LIMITS.maxRunValueChars) {
            fail(`${at} 的 expect.${k} 太长`);
          }
        }
      }

      // 输出快照必须入库时就核得上——这是证据的一部分，不是状态问题。
      // 脚本哈希不在这里核（validate 拿不到 workspace 根），交给 status 读时重算。
      if (typeof r.output === 'string' && r.output.trim() !== '' && typeof readSnapshot === 'function') {
        const out = readSnapshot(r.output);
        if (out === null || out === undefined) {
          fail(`${at} 的输出快照找不到：${r.output}`);
        } else if (typeof r.output_sha256 === 'string' && SHA256_RE.test(r.output_sha256) && sha256(out) !== r.output_sha256) {
          fail(`${at} 的输出快照哈希对不上`);
        } else if (r.expect && typeof r.expect === 'object' && !Array.isArray(r.expect)) {
          // 期望值必须在原始输出里逐字出现。这一条是整个机制的核心：
          // 它把「我觉得跑出来是 4.02」变成「4.02 在那次输出里」。
          for (const [k, v] of Object.entries(r.expect)) {
            if (typeof v === 'string' && v !== '' && !containsValue(out, v)) {
              fail(`${at} 的 expect.${k}=${JSON.stringify(v)} 在输出快照里找不到——输出和期望对不上`);
            }
          }
        }
      }
    });
  }

  // 硬规则：关于世界的断言，两个方向都要佐证，或者自己跑出来过。
  // 说「这是真的」和说「这是假的」一样是断言，只约束一边等于留了后门。
  // runs 是另一条合法路径：没有第二份来源，但有可复跑的实测。
  if (data.world_status === 'supported' || data.world_status === 'contradicted') {
    if ((!corrob || corrob.length === 0) && (!runs || runs.length === 0)) {
      fail(`world_status 写 ${data.world_status}，就必须至少给一条 corroborations（独立佐证）或一条 runs（实测复跑）`);
    }
  }

  if (hardFails.length > 0) {
    return { status: 'hard_fail', data, body: parsed.body, autofixes, hardFails, text: null };
  }

  const rendered = joinFrontmatter(data, parsed.body, KEY_ORDER);
  // 比对时去掉 BOM：BOM 只是编辑器加的标记，不该让一条合规条目反复被判 dirty。
  const comparable = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const changed = rendered !== comparable;

  if (!autofixes.length && !changed) {
    return { status: 'pass', data, body: parsed.body, autofixes, hardFails, text: null };
  }
  if (!fix) {
    return { status: 'dirty', data, body: parsed.body, autofixes: autofixes.length ? autofixes : ['字段顺序或格式不规范'], hardFails, text: null };
  }
  return { status: 'fixed', data, body: parsed.body, autofixes: autofixes.length ? autofixes : ['重排为标准格式'], hardFails, text: rendered };
}
