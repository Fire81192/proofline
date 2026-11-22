/**
 * 引文定位。
 *
 * 唯一职责：给一段原文和一句引文，返回引文在原文里的字符区间。
 * 位置由代码算出来，永远不接受外部给的位置。
 *
 * ## 三级比较
 *
 * 真实来源很少是干净的。同一句话，在 PDF 抽出来的文本里可能被行尾断开、
 * 被 OCR 塞进空格、全角半角混用。所以比较分三级，从严到宽：
 *
 *   1. exact             真·逐字：不改任何字符，直接 indexOf
 *   2. normalized        折叠全角、连续空白折成一个空格、去首尾
 *   3. space-insensitive 再进一步，把所有空白全部去掉
 *
 * 三级只在上一级失败时启用。第二级治全角字母（「ＰＰＧ」），
 * 第三级治中文 OCR 的典型毛病：「重要参考 数据」中间被塞了一个空格。
 *
 * 四级以前没有 exact，第一级就叫 normalized——README 写「逐字」而实现默认就折叠，
 * 这是文档比实现严。加 exact 之后，「逐字」才算数。
 *
 * 每次命中都记录是哪一级命中的（`mode`），让调用方知道这次匹配有多硬。
 *
 * ## 为什么不用正则
 *
 * 正则里嵌用户输入要转义，而且同样要做偏移映射。直接建索引表更直白，
 * 也更容易测。代价是 O(n) 内存，对这个体量完全无所谓。
 */

/** 单个字符是否空白（含全角空格 U+3000、不换行空格 U+00A0）。 */
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\u3000' || ch === '\u00a0' || ch === '\f' || ch === '\v';
}

/**
 * 全角 ASCII -> 半角。1:1 映射，不改变长度。
 * OCR 出来的英文经常是「Ｒesearch」「ＰＰＧ」这种全角字母。
 */
function foldChar(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return ch;
}

/**
 * 规范化，同时记录每个规范化字符来自原文的哪个下标。
 *
 * @param {string} text
 * @param {{stripSpace?: boolean}} opts  true 时把空白全部删掉（不留占位）
 */
export function canonicalize(text, { stripSpace = false } = {}) {
  const chars = [];
  const map = [];
  let pendingSpaceAt = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isSpace(ch)) {
      if (stripSpace) continue;
      if (pendingSpaceAt === -1) pendingSpaceAt = i;
      continue;
    }
    if (pendingSpaceAt !== -1 && chars.length > 0) {
      chars.push(' ');
      map.push(pendingSpaceAt);
    }
    pendingSpaceAt = -1;
    chars.push(foldChar(ch));
    map.push(i);
  }

  return { text: chars.join(''), map };
}

/** 只规范化，不要映射表。用于比较引文。 */
export function normalize(text, opts) {
  return canonicalize(text, opts).text;
}

function search(haystack, quote, opts) {
  const needle = normalize(quote, opts);
  if (!needle) return null;
  const hay = canonicalize(haystack, opts);
  const at = hay.text.indexOf(needle);
  if (at === -1) return null;
  const start = hay.map[at];
  const end = hay.map[at + needle.length - 1] + 1;
  return { start, end, matched: haystack.slice(start, end) };
}

/**
 * 在 haystack 里找 quote。先按空白归一找，找不到再按去掉全部空白找。
 *
 * @returns {{start:number,end:number,matched:string,mode:'normalized'|'space-insensitive'}|null}
 *   start/end 是 haystack 上的 UTF-16 下标，end 不含。
 */
export function locateQuote(haystack, quote) {
  if (typeof haystack !== 'string' || typeof quote !== 'string') return null;

  // 空引文必须挡在这里：`indexOf('')` 返回 0，会被当成命中。
  if (!quote) return null;

  // 一级：不改任何字符。这才是 README 说的「逐字」。
  const at = haystack.indexOf(quote);
  if (at !== -1) {
    return { start: at, end: at + quote.length, matched: quote, mode: 'exact' };
  }

  // 二级：折叠全角与连续空白
  const near = search(haystack, quote, {});
  if (near) return { ...near, mode: 'normalized' };

  // 三级：去掉全部空白
  const loose = search(haystack, quote, { stripSpace: true });
  if (loose) return { ...loose, mode: 'space-insensitive' };

  return null;
}

/**
 * 一次定位多条引文。任何一条找不到，ok 记为 false，
 * 但已经找到的仍然返回（诊断时要知道是哪条挂了）。
 */
export function locateAll(haystack, quotes) {
  const results = quotes.map((quote, index) => {
    const hit = locateQuote(haystack, quote);
    return {
      index,
      quote,
      ok: hit !== null,
      start: hit ? hit.start : null,
      end: hit ? hit.end : null,
      matched: hit ? hit.matched : null,
      mode: hit ? hit.mode : null,
    };
  });
  return { ok: results.every((r) => r.ok), results };
}

/**
 * 一个值是否作为**完整 token** 出现在文本里。
 *
 * 为什么不用 `includes`：期望值 `18.92532733578351` 时，`8.92532733578351`、
 * `.92532733578351`、`18.9` 全都是它的子串，`includes` 全部放行。
 * 也就是说「期望值必须能在输出里逐字找到」这句话，用 includes 实现出来
 * 是「附近有这串数字」，不是「这个值在」。
 *
 * 边界取「数字 / 字母 / 下划线 / 点 / 负号」——这些字符紧邻时算同一个数
 * 或同一个标识符。所以：
 *   输出 18.92…，期望 18.9       -> 不匹配（后面还接着数字）
 *   输出 18.92…，期望 8.92…      -> 不匹配（前面是数字）
 *   输出 -1.50，  期望 1.50      -> 不匹配（前面是负号）
 *   输出 1.5.0，  期望 1.5       -> 不匹配（后面还接着 .0）
 *   输出 "mae": 18.92…，期望 18.92… -> 匹配
 *
 * **两侧必须用同一套字符**。第一版不是：后向排除 5 个字符（含 `.` `-`），
 * 前向只排除 3 个（`[0-9A-Za-z_]`）。于是 `1.5.0` 里找 `1.5` 判为匹配——
 * 而 1.5 和 1.5.0 不是同一个值。版本号是最常见的场景，这条几乎必踩。
 *
 * 加严的代价：`1.5-2` 这种区间里找 `1.5` 也会不匹配。可以接受——
 * 期望值要的是「这次跑出来是几」，不是「某个数出现在某个区间里」。
 * 漏报（错值通过）比误报（提示找不到）危险得多。
 *
 * @param {string} text
 * @param {string} value
 * @returns {boolean}
 */
export function containsValue(text, value) {
  if (typeof text !== 'string' || typeof value !== 'string' || value === '') return false;
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前后用同一个字符类，写成一份常量——就是为了不再出现两侧不一致。
  const TOKEN = '0-9A-Za-z_.\\-';
  return new RegExp(`(?<![${TOKEN}])${esc}(?![${TOKEN}])`).test(text);
}
