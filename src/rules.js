/**
 * 检查规则。
 *
 * 每条规则对应一种「翻车形态」，来源是设计讨论里那句话：
 * **不探测人，检查物。** 用了错的采样率、选了会相位失真的滤波、数据集划分错了——
 * 这些错误客观存在于产出物里，不需要他自己知道。
 *
 * ## 写规则的三条纪律
 *
 * 一、**宁可漏，不可误报。** 误报一次，后面所有提示都会被当成噪音。
 *     所以每条规则都要求两个以上条件同时成立，不靠单一关键词。
 *
 * 二、**必须给得出下一步动作。** `action` 为空的规则不该存在——
 *     判定层会把它判成 silent，等于白写。
 *
 * 三、**说得出「怎么观察」。** 每条规则要能指出文件名和行号。
 *     指不出位置的提醒，人没法核，也没法改。
 *
 * ## 现在的局限
 *
 * 规则是手写的，不是从条目里长出来的。理想形态是条目带一个
 * 「可检查条件」字段，规则由它生成——`checks` 里的 `entry` 字段是那个接口的
 * 预留位置，暂时都为 null。这一点在 README 里也写明了，不装作已经有。
 */

/** 命中后要不要跳过某些行（注释里的示例代码不该算）。 */
const COMMENT_LINE = /^\s*(#|\/\/|\*|--)/;

/**
 * 收集命中的行。
 *
 * 返回的数组带一个 `total` 属性：**命中总数**，不受 max 限制。
 * 分开的理由：显示「命中 10 处」而只列 3 个位置，和显示「命中 3 处」，
 * 是两句不同的话。前者诚实，后者是假的。
 */
function hitLines(text, re, max = 3) {
  const out = [];
  let total = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    total += 1;
    if (out.length < max) out.push({ line: i + 1, snippet: line.trim().slice(0, 120) });
  }
  out.total = total;
  return out;
}

function has(text, re) {
  re.lastIndex = 0;
  return re.test(text);
}

export const RULES = [
  {
    id: 'filter-phase-shift',
    entry: null,
    level: '偏离惯例',
    cost: 'high',
    reversible: true,
    action: '把 lfilter 换成 filtfilt（零相位），否则滤波后的波形会整体时移，峰值位置对不上',
    // 两个条件同时成立才报：用了 IIR 设计，又直接 lfilter
    detect(text) {
      if (!has(text, /\bbutter\s*\(|\bcheby[12]?\s*\(|\biirnotch\s*\(/)) return [];
      const bad = hitLines(text, /\blfilter\s*\(/);
      if (bad.length === 0) return [];
      if (has(text, /\bfiltfilt\s*\(/)) return []; // 已经用了零相位，混用不算错
      return bad;
    },
  },
  {
    id: 'unseeded-random',
    entry: null,
    level: '偏离惯例',
    cost: 'low',
    reversible: true,
    action: '在入口固定随机种子（np.random.default_rng(0) 或 random.seed(0)），否则结果不可复现',
    detect(text) {
      const uses = hitLines(text, /\b(np\.random\.|random\.(random|randint|shuffle|choice)\b)/, 1);
      if (uses.length === 0) return [];
      if (has(text, /\b(seed|default_rng|RandomState)\s*\(/)) return [];
      return uses;
    },
  },
  {
    id: 'timeseries-random-split',
    entry: null,
    level: '失真',
    cost: 'high',
    reversible: true,
    action: '改成按时间切（前 80% 训练、后 20% 测试），随机划分会让未来样本进入训练集',
    // 三个条件：有 train_test_split、没有 shuffle=False、文件里出现时间语义
    detect(text) {
      const calls = hitLines(text, /\btrain_test_split\s*\(/);
      if (calls.length === 0) return [];
      if (has(text, /shuffle\s*=\s*False/)) return [];
      if (!has(text, /time|date|timestamp|datetime|时间/i)) return [];
      return calls;
    },
  },
  {
    id: 'hardcoded-abs-path',
    entry: null,
    level: '偏离惯例',
    cost: 'low',
    reversible: true,
    action: '改成相对路径或环境变量，绝对路径换台机器就跑不了',
    detect(text) {
      return hitLines(text, /["'][A-Za-z]:[\\/]|["']\/(home|Users)\//, 2);
    },
  },
  {
    id: 'destructive-cleanup',
    entry: null,
    level: '致命',
    cost: 'high',
    reversible: false,
    action: '先把数据复制一份再执行删除；这条一旦跑下去没有第二次',
    detect(text) {
      return hitLines(text, /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\bshutil\.rmtree\s*\(|\bos\.remove\s*\(|\bRemove-Item\b.*-Recurse/i, 2);
    },
  },
];

/** 规则注册表：按 id 取。 */
export function ruleById(id) {
  return RULES.find((r) => r.id === id) ?? null;
}
