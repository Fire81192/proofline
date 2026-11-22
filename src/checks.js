/**
 * 把条目里的「可检查条件」变成真正能跑的规则。
 *
 * 这一层是项目和别的笔记库最实质的差别：
 * 别人存知识是存下来等人看；这里存的知识会自己长出检查。
 *
 * ## 一条 check 长什么样
 *
 *   type=pattern  present/absent 是正则
 *   type=term     present/absent 是普通字符串，内部转义后当子串查
 *
 * 两者判定完全相同，term 只是省事的写法。加它的原因很直接：
 * 21 条条目里只有 3 条写了 checks，因为「为了记一个坑，还得会写正则」
 * 这个门槛太高。term 把门槛降到「想起要查哪个词」。
 *
 * 两者同时成立才算命中。要求两个条件，是因为单关键词误报太多——
 * 误报一次，后面所有提示都会被当成噪音。
 *
 * ## scope：这条规则只在哪些文件上生效
 *
 * 不加这个字段，一条「PPG 要先滤波」的规则会在**每一个**碰到 PPG 字样的
 * 文件上命中——包括只读 pickle 的、只画图的。实测 9 个脚本命中 8 个，
 * 其中一半根本不该滤波。全部命中等于全部没用。
 *
 * scope 是一个路径正则，匹配文件相对路径。不匹配就不扫。
 * 拿不到文件路径时**一律不命中**：scope 的意思是「只在这里生效」，
 * 范围未知就不能假定生效。
 *
 * ## 边界
 *
 * - 正则写错不该让整个扫描崩掉：单条坏规则被跳过，并记进 `broken`。
 *   校验层会拦住坏正则，但历史文件可能早于校验存在。
 * - 条目被删了，规则自然消失——规则的生命周期跟着知识走，不另存一份。
 */

import { parseFrontmatter } from './core/frontmatter.js';

const COMMENT_LINE = /^\s*(#|\/\/|\*|--)/;

function hitLines(text, re, max = 2) {
  const out = [];
  let total = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (COMMENT_LINE.test(line)) continue;
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    total += 1;
    if (out.length < max) out.push({ line: i + 1, snippet: line.trim().slice(0, 120) });
  }
  out.total = total;
  return out;
}

function safeRegExp(pattern) {
  try {
    // 不带 g：命中位置由调用方按行判断，避免 lastIndex 状态污染
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** 把普通字符串变成「只匹配它本身」的正则。term 走这条路。 */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按 check 的类型取它的匹配式。term 不解释正则，避免「括号」被当分组。 */
function matcherOf(c, key) {
  const raw = c[key];
  if (raw === undefined) return null;
  return safeRegExp(c.type === 'term' ? literal(raw) : raw);
}

/**
 * @param {Array<{id:string, text:string}>} entries
 * @returns {{rules:Array, broken:Array<{entry:string,index:number,reason:string}>}}
 */
export function rulesFromEntries(entries) {
  const rules = [];
  const broken = [];

  for (const entry of entries) {
    let data;
    try {
      ({ data } = parseFrontmatter(entry.text));
    } catch (err) {
      broken.push({ entry: entry.id, index: 0, reason: `frontmatter 解析失败：${err.message}` });
      continue;
    }
    const checks = Array.isArray(data.checks) ? data.checks : [];
    if (checks.length === 0) continue;

    checks.forEach((c, i) => {
      const where = `检查 #${i + 1}`;
      if (!c || (c.type !== 'pattern' && c.type !== 'term')) {
        broken.push({ entry: entry.id, index: i + 1, reason: `${where} 类型不是 pattern / term` });
        return;
      }
      const present = matcherOf(c, 'present');
      if (!present) {
        // term 转义之后必然是合法正则，所以走到这里的一定是 pattern 写错了。
        // 报错要指向真正的原因，不能为了兼容两种类型把它说含糊。
        broken.push({ entry: entry.id, index: i + 1, reason: `${where} 的 present 不是合法正则` });
        return;
      }
      const absent = matcherOf(c, 'absent');
      if (c.absent !== undefined && !absent) {
        broken.push({ entry: entry.id, index: i + 1, reason: `${where} 的 absent 不是合法正则` });
        return;
      }

      // scope 始终按正则解释，不受 type 影响——它匹配的是路径，不是代码。
      let scope = null;
      if (c.scope !== undefined) {
        if (typeof c.scope !== 'string' || c.scope.trim() === '') {
          broken.push({ entry: entry.id, index: i + 1, reason: `${where} 的 scope 必须是非空字符串` });
          return;
        }
        scope = safeRegExp(c.scope);
        if (!scope) {
          broken.push({ entry: entry.id, index: i + 1, reason: `${where} 的 scope 不是合法正则` });
          return;
        }
      }

      rules.push({
        id: `entry:${entry.id}#${i + 1}`,
        entry: entry.id,
        claim: typeof data.claim === 'string' ? data.claim : null,
        quote: Array.isArray(data.quotes) ? data.quotes[0] ?? null : null,
        level: c.level,
        cost: c.cost,
        reversible: c.reversible,
        action: c.action,
        scope: c.scope ?? null,
        detect(text, filePath) {
          if (scope) {
            scope.lastIndex = 0;
            if (typeof filePath !== 'string' || !scope.test(filePath)) return [];
          }
          const hits = hitLines(text, present);
          if (hits.length === 0) return [];
          // absent 是全文判断：只要文件里出现过，就不算踩坑
          if (absent) {
            absent.lastIndex = 0;
            if (absent.test(text)) return [];
          }
          return hits;
        },
      });
    });
  }

  return { rules, broken };
}

/**
 * 起草一条 check 的候选线索。
 *
 * 存在的理由很实在：checks 的使用率是 3/21。不是没人想写，是
 * 「盯着一条已经看懂的结论，想不出该让机器查什么词」这一步卡住了。
 * 这个函数不生成成品——它只把条目里**已经出现过的代码标识符**摊开，
 * 让人从里面挑一个。
 *
 * 为什么从引文和代码块里抽：那两处出现的标识符，一定是这条主张
 * 真正说的那个东西。从正文散文里抽会抽出「血压」「模型」这种没用的词。
 *
 * 它故意不填 action。填了就成了「一条看着合法、实际没人想说下一步」的检查，
 * 入库能过、扫描会响，但响了不知道该干什么——比没有更坏。
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'true', 'false', 'none', 'null',
  'return', 'import', 'print', 'class', 'def', 'self', 'lambda', 'assert', 'raise',
  'const', 'let', 'var', 'function', 'export', 'default', 'async', 'await', 'typeof',
  'string', 'number', 'boolean', 'object', 'array', 'value', 'values', 'data', 'file',
  'path', 'name', 'type', 'size', 'index', 'item', 'items', 'list', 'dict', 'shape',
  // 这几个在引文里出现频率极高，但它们说明不了「这段代码在干什么」。
  // 抽出来当 present 只会让人多看一眼再划掉，不如不抽。
  'format', 'join', 'split', 'load', 'save', 'read', 'write', 'open', 'close',
  'main', 'test', 'info', 'text', 'line', 'lines', 'result', 'results', 'output',
]);

export function draftChecks(text) {
  let data = {};
  let body = '';
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch {
    return { candidates: [], note: 'frontmatter 解析不了，先修结构' };
  }

  const found = new Map();
  const add = (word, from) => {
    if (word.length < 4) return;
    if (STOP_WORDS.has(word.toLowerCase())) return;
    if (/^\d+$/.test(word)) return;
    const prev = found.get(word);
    if (prev) {
      if (!prev.from.includes(from)) prev.from.push(from);
      prev.count += 1;
    } else {
      found.set(word, { word, from: [from], count: 1 });
    }
  };

  // 引文优先：它是这条主张的原话，里面的标识符一定和主张直接相关。
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
  for (const q of quotes) {
    if (typeof q !== 'string') continue;
    for (const m of q.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) add(m[0], '引文');
  }

  // 正文代码块。
  for (const m of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const w of m[1].matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) add(w[0], '代码块');
  }

  // 「别用 / 不要 / 避免」这类句子后面的词，往往正是 absent 该写的反例。
  const warnings = [];
  for (const line of body.split('\n')) {
    if (!/(不要|别用|别直接|避免|不该|反而|而不是)/.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
      if (!STOP_WORDS.has(m[0].toLowerCase())) warnings.push(m[0]);
    }
  }

  const candidates = [...found.values()]
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 12)
    .map((c) => ({ word: c.word, from: c.from, count: c.count }));

  return {
    candidates,
    suggestAbsent: [...new Set(warnings)].slice(0, 6),
    note: candidates.length === 0
      ? '引文和正文代码块里都没有代码标识符——这条可能不适合写 check（它更像观点，不是可查的方法）'
      : null,
  };
}
