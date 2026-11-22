/**
 * 数值校验：主张里标注的核心数值，必须在引文里出现过。
 *
 * ## 为什么只查 value.number
 *
 * 试过「主张里的每个数字都必须在引文里」，43 条里 12 条报警——但其中大半是噪音：
 * `GB 3095-2012` 的标准号、`2024 年`、`1024×10/1250` 算出来的商。
 * 噪音的代价不是「多看一眼」，是「以后都不看」。
 *
 * `value.number` 不一样：它是作者显式标注的「这条的核心数值」。
 * 一个数字值得单独拎出来放进 value，就值得被校验它到底出处在哪。
 *
 * ## 只对 basis=条目 生效
 *
 * - 条目（从原文读来）：数字必须能在原文里找到
 * - 实测（自己跑出来）：数字来自 runs 的输出，不在这里查
 * - 判断（推出来）：数字是算的，本来就不该在原文里
 *
 * 对「判断」档要求原文有那个数，等于要求推算结果凭空出现。
 *
 * ## 两级，不是一级
 *
 * - 引文里没有、整份快照里有 → 引文选窄了：结论没错，但引的那一句撑不住这个数
 * - 引文和快照都没有 → 数字来源不明：要么记错了，要么是从别处带来的
 *
 * 这两件事的严重程度差一个数量级。混成一句「数字对不上」，看的人分不出该改哪。
 */

/** 数字的几种写法：35 / 35.0 / 35.00 应当视为同一个。 */
function normalize(n) {
  const s = String(n).trim();
  const f = Number(s);
  return Number.isFinite(f) ? String(f) : s;
}

function presentIn(text, n) {
  if (!text) return false;
  const f = Number(n);
  if (!Number.isFinite(f)) return text.includes(String(n));
  // 必须做边界检查，不能用裸 includes：
  // 快照是 PDF 抽取的，里面「B - 1049 Brussels」这种地址会让 10 假命中，
  // 「2025 年」会让 25 假命中。短数字的误匹配是第一版的主要噪音源。
  // 边界要同时满足两件相反的事：
  //   35 不该在「35.5」里算命中（那是另一个数）
  //   35 该在「35.0」里算命中（同一个数）
  // 所以先吃掉尾随的 .0，再检查后面不是数字也不是小数点。
  const re = new RegExp(`(?<![\\d.])${String(f).replace('.', '\\.')}(\\.0+)?(?![\\d.])`);
  return re.test(text);
}

/**
 * @param {object} args
 * @param {string} args.claim
 * @param {object} [args.value]      条目里的 value 字段
 * @param {string} [args.basis]      条目 / 实测 / 判断
 * @param {string[]} [args.quotes]
 * @param {string|null} [args.snapshotText]
 * @returns {{checked:boolean, ok:boolean, kind?:string, number?:string, detail?:string}}
 */
export function checkValue({ claim, value, basis, quotes, snapshotText }) {
  if (!value || value.number === undefined || value.number === null) {
    return { checked: false, ok: true };
  }
  if (basis !== '条目') {
    // 实测的数字在 runs 的输出里；判断的数字是算的。都不该在原文里找。
    return { checked: false, ok: true };
  }
  const quoteText = Array.isArray(quotes) ? quotes.join('\n') : '';
  if (!quoteText) {
    // 没有引文的「条目」档本身就不合规，形状检查会拦，这里不重复报
    return { checked: false, ok: true };
  }

  const n = value.number;
  if (presentIn(quoteText, n)) return { checked: true, ok: true, number: String(n) };

  if (presentIn(snapshotText ?? '', n)) {
    return {
      checked: true,
      ok: false,
      kind: 'quote_too_narrow',
      number: String(n),
      detail: `核心数值 ${n} 在原文里有，但引的那一句没包含它——引文选窄了`,
    };
  }
  return {
    checked: true,
    ok: false,
    kind: 'number_without_source',
    number: String(n),
    detail: `核心数值 ${n} 在引文和整份快照里都找不到——这个数从哪来的？`,
  };
}

export { normalize };
