/**
 * 字段契约。
 *
 * 这里的每个字段都对应一条设计决定，注释里写清「为什么必须有」，
 * 因为删字段的人需要知道删掉之后哪个能力就没了。
 *
 * 平铺格式：不支持嵌套。gaps 用一行 JSON 数组装对象。
 */

/** 判定五态。两个维度共用同一套取值。 */
export const VERDICTS = [
  'supported',     // 支持
  'contradicted',  // 反对
  'conflicting',   // 来源之间互相冲突
  'unresolved',    // 查过，但定不了
  'not_checked',   // 没查过
];

/** 只有这两态才算「有结论」。not_checked 永远不会被当成通过。 */
export const DECIDED = new Set(['supported', 'contradicted']);

export const KINDS = ['原理', '方法', '参考架构', '观点'];
export const LAYERS = ['线索', '标准'];
export const SOURCE_KINDS = ['短视频', '文章', '官方文档', '标准', '教材', '论文', '项目', '其他'];

/**
 * 这条主张是**怎么知道的**。
 *
 * 与 layer 正交：layer 说的是「能不能用」（线索 / 标准），
 * basis 说的是「凭什么知道」。把这两件事压在 layer 一个字段上，
 * 结果是纯推理既没法标「想清楚了」，也没法标「没证据」。
 *
 *   条目  从原文读来的。必须有快照、有能定位的引文。
 *   实测  自己跑出来的。必须有 runs。
 *   判断  推出来的。不要求出处，但**永远不能当依据**——
 *         用推理去否定别人，是不够的。
 *
 * 为什么必填而不是自动派生：派生只能看出「有没有证据」，
 * 看不出「结论有没有超出证据」。一条有引文但推过头的条目，
 * 派生会说「条目」，而它实际是「条目 + 判断」的混合——
 * 那正是幻觉最典型的形态。
 *
 * 人必须自己说清这一条属于哪种。缺省即拒，不许含糊。
 */
export const BASIS = ['条目', '实测', '判断'];

/**
 * 快照是怎么来的。
 *
 * 这一项存在的原因：快照很少是「原文本身」。
 * 论文的原文是 PDF，我们手上是解析出来的文字；视频的原文是画面和声音，
 * 我们手上是转录。中间隔着一道有损转换。
 *
 * 不记这一项，就等于假装手上的文本和原件等价。而 OCR 会认错字，
 * 转录会漏句——引文能定位到「我们手上的文本」，不代表能定位到原件。
 */
/**
 * 快照是怎么从原件来的。
 *
 * 前五档说的是**手段**（原文 / OCR / PDF抽取 / 转录 / 摘要）。
 * 最后一档说的是**损失**：表格压平——内容一个字不少，但行列关系没了，
 * 一整张表变成 `Ⅰ阶段目标值701503575` 这样一串。
 *
 * 为什么单列一档，而不是在 PDF抽取 上加个备注：因为这两件事的后果不同。
 * PDF抽取 的引文读得懂；表格压平 的引文「逐字可核但不可读」——
 * 校验过得去，人看不懂。不单列出来，下一个读这条的人会以为
 * `Ⅰ阶段目标值701503575` 是他自己眼花。
 *
 * 用了这一档就说明：内容到了，结构没到。读的人得自己把表还原回去。
 */
export const SOURCE_EXTRACTIONS = ['原文', 'OCR', 'PDF抽取', '转录', '摘要', '表格压平'];

/**
 * 一条知识能自己长出检查的条件。
 *
 * 存在的理由：rules.js 里那几条规则是手写的，库攒再多知识也不影响它。
 * 而真正的价值在于——你学到一个坑，入库一次，以后它自动帮你盯代码。
 *
 * 每个 check 描述「什么样的代码踩了这个坑」：
 *   present  必须出现的（正则）
 *   absent   必须不出现的（正则，可选）
 * 两者同时成立，才算命中。
 *
 * 风险分级（level/cost/reversible/action）放在 check 上而不是条目上：
 * 同一个主张，落到不同代码场景里严重度可能不同。
 */
/**
 * 话题：这条主张在说「哪件事」。
 *
 * 存在的理由：条目多了之后，同一个问题上会并存好几条主张，
 * 而它们互相不知道对方存在。工具读不懂语义，但可以保证**同话题的必须同屏**。
 *
 * 形如 ppg.preprocess / abp.model.loss，小写、点分。
 * 它是分类不是注释——别往里面塞句子。
 */
export const TOPIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 可检查条件的两种写法。
 *
 * pattern 要人写正则——这是它使用率只有 3/21 的原因：写正则比记结论难得多。
 * term 只给普通字符串，内部转义后当子串查。允许写「MinMax」而不是
 * 「MinMax(A|B)」这种，把门槛降到「想起来要查什么」就够。
 *
 * 语义上两者等价：present/absent。term 只是 pattern 的省事写法，
 * 不另开一套判定，免得规则引擎要维护两条路径。
 */
export const CHECK_TYPES = ['pattern', 'term'];
export const RISK_LEVELS = ['致命', '失真', '偏离惯例', '偏好'];
export const RISK_COSTS = ['low', 'high'];
export const GAP_ACTIONS = ['fetch', 'search', 'reanalyse'];

/** 缺口落在哪一维。以前不校验，拼错就沉底——blocking 缺口谁的账都不进。 */
export const GAP_DIMENSIONS = ['evidence', 'world'];

/**
 * 实测复跑记录。
 *
 * 存在的理由：world_status（这条主张是不是真的）在真实工作里从来没人填，
 * 21 条条目全部停在 unresolved——因为填它要「找一份独立佐证」，
 * 而大多数结论根本没有第二份来源，只有「我自己跑过」。
 *
 * corroborations 解决「别人也这么说」，runs 解决「我自己跑出来是这样」。
 * 两者合起来才让第二个维度有东西可填。
 *
 * 一条 run 不执行脚本（不替人跑，环境依赖和副作用都不可控），它做的是**冻结**：
 *
 *   script         脚本路径，相对 workspace 根（实测脚本属于项目，不属于某条条目）
 *   script_sha256  脚本内容的哈希。脚本一改，run 立即失效——结论没跟着重跑
 *   inputs         可选。这次运行依赖的上游产物 [{path, sha256}]，相对 workspace 根。
 *                  真实实验几乎都是链式的：train.py 出模型 → eval.py 出指标。
 *                  只记 eval.py 的哈希，抓不到「模型被换了一个」——而那才是
 *                  最常见的失效方式。声明 inputs 之后，上游产物一改，这条 run
 *                  自动失效。
 *   output         那次运行的原始输出，存成条目内的快照文件
 *   output_sha256  输出的哈希。改动即失效
 *   expect         期望键值。每个 **值** 都必须能在 output 里逐字找到
 *   cmd            实际跑的命令，给人复现用，不参与判定
 *   env            环境说明（Python 版本、依赖），只记录
 *
 * 关键在 expect 与 output 的对照：写 observed 是「我说跑出来是 4.02」，
 * 写 output 快照是「这是那次的完整输出，4.02 必须在里面」。
 * 前者自证，后者可核。
 *
 * ## 它保证不了什么
 *
 * 它不验证「这个脚本能产出这个输出」。两者都是人填的，工具只核两个哈希
 * 对得上、期望值在输出里找得到。脚本和输出错配（记 A 脚本、贴 B 脚本的
 * 产出），它查不出来——这种错只能靠人写对。
 *
 * 同理，它保证的是「这一次的记录没被改过」，不是「这个结论可重复」。
 * 浮点实验换个线程数就可能差最后几位，那一层它不管。
 */
export const RUN_REQUIRED = ['script', 'script_sha256', 'output', 'output_sha256', 'expect', 'at'];

/** 写入时的字段顺序。按这个顺序渲染，同一份数据写出来字节一致。 */
export const KEY_ORDER = [
  'schema', 'id', 'claim', 'kind', 'layer', 'basis', 'topic',
  'source_kind', 'source_uri', 'source_published_at', 'source_available_basis',
  'source_extraction', 'source_original',
  'source_snapshot', 'source_sha256',
  'evidence_status', 'world_status',
  'value',
  'not_for',
  'quotes', 'checks', 'corroborations', 'runs', 'prereq', 'derived_from', 'gaps',
  'deprecated',
  'added_at',
];

/**
 * 必填。缺一个就是 hard_fail，不猜默认值。
 *
 * 注意 source_sha256 和 quotes 不在这里——它们是条件必填：
 *   取到了原文  -> 两个都必须有，且引文必须能定位
 *   没取到原文  -> 两个都不许有，且 evidence_status 只能是 not_checked
 * 这两条合起来的意思是：要么可核，要么明确标「没核」，不许含糊。
 *
 * source_extraction 必填：缺省不是「原文」，是「没说」。
 * 不申报来源形态就能免检「二手必须给原件」，等于不填表就不用审。
 */
export const REQUIRED = [
  'id', 'claim', 'kind', 'layer', 'basis', 'source_kind',
  'source_extraction',
  'evidence_status', 'world_status', 'added_at',
];

export const LIMITS = {
  claimMinChars: 8,
  claimMaxChars: 200,
  quoteMaxChars: 1000,
  maxQuotes: 12,
  maxGaps: 12,
  maxCorroborations: 12,
  maxNotFor: 3,
  notForMinChars: 8,
  maxNotForChars: 200,
  maxValueScopeChars: 60,
  maxValueSubjectChars: 24,
  maxValueUnitChars: 24,
  maxChecks: 8,
  checkPatternMaxChars: 500,
  corroborationQuoteMaxChars: 1000,
  maxRuns: 8,
  maxRunInputs: 12,
  maxRunExpectKeys: 12,
  maxRunValueChars: 200,
  maxRunCmdChars: 300,
  maxRunEnvChars: 160,
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;


/**
 * 来源发布日期允许三种精度：2024 / 2024-05 / 2024-05-17。
 *
 * 为什么不像 added_at 那样只要完整日期：
 * 期刊论文常常只有「2024 年第 5 期」，视频只有上传年份，标准只有发布年。
 * 强制填完整日期，人就会猜一个——猜出来的日期比没有日期更糟，
 * 因为它看起来是精确的。宁可只知道年。
 *
 * 精度用字符串长度表达，不另开字段：4 位=年，7 位=月，10 位=日。
 */
export const PUBLISHED_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function datePrecision(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}$/.test(value)) return 'year';
  if (/^\d{4}-\d{2}$/.test(value)) return 'month';
  if (DATE_RE.test(value)) return 'day';
  return null;
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 字段说明表。CLI 的 `proofline fields` 直接打印这个，
 * 避免文档和代码两处维护。
 */
export const FIELD_DOC = [
  ['schema', '格式版本。现在是 1。加字段就升版本，老条目缺的当 null。'],
  ['id', '日期-短名。必须等于所在目录名。'],
  ['claim', '一句话主张，能判真假的那种。8–200 字符。'],
  ['kind', '原理 / 方法 / 参考架构 / 观点。决定这条怎么被用。'],
  ['layer', '线索 / 标准。线索只能触发去查，不能当依据。'],
  ['basis', '凭什么知道：条目（从原文读来）/ 实测（自己跑出来）/ 判断（推出来的）。判断档不要求出处，但永远不能当依据。必填，缺省即拒。'],
  ['source_kind', '来源形态。短视频 / 文章 / 官方文档 / 标准 / 教材 / 论文 / 项目 / 其他。'],
  ['source_uri', '可回访的地址。短链会失效，能存原文就存快照。'],
  ['source_published_at', '源发布日期。不是入库日期。只支持 2024 / 2024-05 / 2024-05-17 三种精度，不确定就别补全。'],
  ['source_available_basis', '你凭什么认为它那天可公开获得。填了日期就必须填依据。'],
  ['source_extraction', '快照怎么来的：原文 / OCR / PDF抽取 / 转录 / 摘要 / 表格压平。不是「原文」时必须给 source_original。表格压平表示「内容到了、结构没到」，引文会是一串黏在一起的字符。'],
  ['source_original', '原件在哪（PDF 路径、DOI、视频地址）。快照是二手的时候必须填。'],
  ['source_snapshot', '原文快照相对路径，默认 raw/source.txt。'],
  ['source_sha256', '快照的 sha256。内容一改就失效，这是证据的地基。'],
  ['evidence_status', '来源是否支持这条主张。五态。'],
  ['world_status', '这条主张在世界里是否为真。五态，与上一条独立。'],
  ['topic', '话题。同话题的条目会在 `review` 里并排出现，防止「同一件事两种说法」被漏看。小写点分，如 ppg.preprocess。'],
  ['quotes', '引文数组，至少一条。必须能在快照里逐字定位到。'],
  ['checks', '可检查条件。type=pattern 写正则，type=term 写普通字符串（省事，别写正则）。scan 会据此自动生成规则。'],
  ['corroborations', '独立佐证数组。world_status 写 supported 就必须至少有一条（或一条有效 runs），且每条都要能定位。'],
  ['runs', '实测复跑记录。脚本哈希 + 上游产物 + 原始输出 + 期望值成环：脚本改了、上游产物换了、输出改了、或期望值在输出里找不到，run 就失效，world 维度自动降级。'],
  ['prereq', '学这条之前要先懂什么（指向别的条目 id）。'],
  ['derived_from', '这条判断是从哪几条推出来的（条目 id 数组），只在 basis=判断 时允许。填了它，status 会算「推理链完整度」——3/3 和 0/3 都是判断，但分量不同：一种是把三条可引的事实摆在一起，一种是我自己想的。'],
  ['gaps', '缺口数组，每条 {question, blocking, action, locator}。'],
  ['deprecated', '退役标记 {at, reason, superseded_by?}。有它就不可引用、不可判定，但条目仍在库里能被查到——删了就追不回来了。'],
  ['not_for', '这条主张**不能**被用来干什么（字符串数组，1-3 条）。门槛跟着杀伤力走：声明上像「能下判断」的条目必须填，其余可选。它不是「还缺什么」（那是 gaps），是「够了，但别越界」。'],
  ['value', '这条主张里的那个数 {metric, number, unit, scope, subject, effective_from?}。填了它，同指标的条目会在 review 里排成一张对照表——这是「同一个数在不同口径下不是一回事」唯一能被看见的地方。'],
  ['added_at', '入库日期。'],
];

/**
 * 这条条目退役了没有。返回退役信息对象，或 null（没退役）。
 *
 * 抽出来是因为有四个地方要判断「退役了吗」：状态派生、来源统计、
 * 话题旗子、并排视图。四份 if 迟早有一份写错，而写错的后果是
 * 一条退役的条目在某张表里看起来还在用。同一个事实只算一处。
 *
 * ## 字段残缺算不算退役
 *
 * 算。只判类型、不判字段的第一版有个要命的性质：手改文件把手写残了
 * （`deprecated: {}`、`deprecated: []`、`deprecated: "2026-11-22"`），
 * 会被当成「没退役」——也就是说，**想退役却写残了的条目，反而继续可引用**。
 *
 * 这是「失败路径静默通过」的教科书形状。所以方向定死：
 * 只要出现这个字段，就按退役处理；字段缺什么记在 `invalid` 里给人看，
 * 但不因此放行。坏数据应该让条目更不可用，不是更可用。
 *
 * @returns {null | {at:string|null, reason:string|null, superseded_by?:string, invalid:boolean}}
 */
export function retiredOf(data) {
  const d = data?.deprecated;
  // null 表示「明确没有」，这和「字段不存在」是同一个意思：JSON 里 null 就是空。
  if (d === null || d === undefined) return null;

  if (typeof d !== 'object' || Array.isArray(d)) {
    return { at: null, reason: null, invalid: true };
  }
  const at = typeof d.at === 'string' && d.at !== '' ? d.at : null;
  const reason = typeof d.reason === 'string' && d.reason.trim() !== '' ? d.reason : null;
  return { ...d, at, reason, invalid: at === null || reason === null };
}
