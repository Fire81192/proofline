/**
 * 读时重算状态。
 *
 * 核心原则：**状态不存，算出来。**
 * 磁盘上写着 `evidence_status: supported` 不算数——快照可能被换过，
 * 引文可能已经不在原文里。每次读都重新核一遍，核不过就降级。
 *
 * 为什么不用存下来的状态：
 * 存下来就会撒谎。源文早改了，字段还写着「已核实」。而撒谎的状态比没有
 * 状态更危险，因为下游会信它。
 *
 * 降级规则（fail-closed）：
 *   快照缺失 / 哈希不符 / 引文定位不到  -> evidence 维度一律 unresolved
 *   有 blocking 缺口                   -> 对应维度 unresolved
 * 一处都不过，也不会把结论改成「通过」——只会改成「无法判定」。
 */

import { parseFrontmatter } from './frontmatter.js';
import { locateAll, containsValue } from './quote.js';
import { sha256, sha256Bytes, SNAPSHOT_REL } from './snapshot.js';
import { DECIDED, retiredOf } from './schema.js';

/** 缺口默认归到 world 维度：evidence 维度的问题基本会被机械检查先抓住。 */
function gapDimension(gap) {
  if (gap && typeof gap.dimension === 'string') return gap.dimension;
  return 'world';
}

/**
 * @param {object} args
 * @param {string} args.dirName
 * @param {string} args.text
 * @param {string|null} args.snapshotText
 * @param {object|null} [args.boxes]  tools/locate.py 生成的 raw/boxes.json
 * @param {((rel:string)=>string|null)|null} [args.readSnapshot] 读条目目录内的佐证快照
 * @param {((rel:string)=>string|null)|null} [args.readRunScript]
 *        读 workspace 内的文件：实测脚本，以及它声明的上游产物（inputs）。
 *        两者路径基准相同，共用一个读取器。由调用方算好传进来。
 * @param {{status:string, reason:string|null, blocking:boolean}|null} [args.sourceStatus]
 *        来源级判断。由调用方算好传进来，这里不碰文件，保持纯函数。
 * @returns {object} 派生视图
 */
export function deriveStatus({ dirName, text, snapshotText, boxes = null, readSnapshot = null, readRunScript = null, sourceStatus = null, citableOf = null }) {
  const { data, body } = parseFrontmatter(text);
  const reasons = [];

  let evidence = data.evidence_status ?? 'unresolved';
  let world = data.world_status ?? 'unresolved';

  // ---- evidence 维度：全部由代码判 ----
  //
  // 判断档没有原文是它的定义，不是缺陷。报「快照缺失」会让人去补一个
  // 本来就不该存在的文件——那正是我们想避免的那种「为了过关而补材料」。
  // 必须 trim：'判断 '（尾随空格）能绕过这一行。validate 会 trim 后判 hard_fail，
  // 但 status 是读时防线——只调 deriveStatus 的消费者会拿到可引用。
  const judgedBasis = typeof data.basis === 'string' && data.basis.trim() === '判断';
  if (snapshotText === null) {
    if (judgedBasis) {
      evidence = 'not_checked';
    } else {
      reasons.push({ dimension: 'evidence', code: 'snapshot_missing', detail: `找不到 ${data.source_snapshot ?? SNAPSHOT_REL}` });
      evidence = 'unresolved';
    }
  } else if (typeof data.source_sha256 !== 'string' || data.source_sha256 === '') {
    // 没有哈希 = 没有任何东西能证明快照没被换过。
    // 「没核」不是「核过了」，按 fail-closed 降级。
    reasons.push({ dimension: 'evidence', code: 'snapshot_unhashed', detail: '条目没有 source_sha256，快照无法证明未被替换' });
    evidence = 'unresolved';
  } else if (sha256(snapshotText) !== data.source_sha256) {
    reasons.push({ dimension: 'evidence', code: 'snapshot_changed', detail: '快照哈希与 source_sha256 不符，原文被改过' });
    evidence = 'unresolved';
  } else {
    const quotes = Array.isArray(data.quotes) ? data.quotes.filter((q) => typeof q === 'string') : [];
    if (quotes.length === 0) {
      reasons.push({ dimension: 'evidence', code: 'no_quote', detail: '没有引文' });
      evidence = 'unresolved';
    } else {
      const located = locateAll(snapshotText, quotes);
      for (const r of located.results) {
        if (!r.ok) {
          reasons.push({
            dimension: 'evidence',
            code: 'quote_not_found',
            detail: `第 ${r.index + 1} 条引文定位不到：${JSON.stringify(r.quote.slice(0, 40))}`,
          });
        } else if (r.mode && r.mode !== 'exact') {
          // 命中了，但不是逐字命中（折叠了空白，或全角转半角）。
          // 以前 mode 算出来就被丢掉：报告里分不出「严格命中」和「宽松命中」，
          // 而 README 写的是「逐字定位」——那就成了文档比实现严。
          // 不降级：宽松命中仍然是命中，但要说出来。
          reasons.push({
            dimension: 'evidence',
            code: 'quote_normalized',
            detail: `第 ${r.index + 1} 条引文是宽松命中（${r.mode}），不是逐字`,
          });
        }
      }
      if (!located.ok) evidence = 'unresolved';
    }
  }

  // ---- 来源级判断：整份材料被判为可疑/弃用，它下面所有主张都不可引用 ----
  // 这不覆盖条目里人写的判定，只在读取时压下来——判定只能由人改。
  if (sourceStatus && sourceStatus.blocking) {
    reasons.push({
      dimension: 'evidence',
      code: 'source_blocked',
      detail: `来源被标为「${sourceStatus.status}」${sourceStatus.reason ? `：${sourceStatus.reason}` : ''}`,
    });
    evidence = 'unresolved';
  }

  // ---- 世界维度的佐证 ----
  // 声称「是真的」必须有独立来源撑着。这里不判断来源独不独立（那是人的事），
  // 只核一件事：佐证还在不在、引文还定不定得到。核不过就不算数。
  const corroborations = Array.isArray(data.corroborations) ? data.corroborations : [];
  // snapshot + sha256 相同的算同一份材料
  const seenCorrob = new Map();
  let worldBasis = 0;
  if (corroborations.length > 0 && typeof readSnapshot === 'function') {
    for (const [i, c] of corroborations.entries()) {
      if (!c || typeof c !== 'object' || typeof c.snapshot !== 'string') continue;
      const snap = readSnapshot(c.snapshot);
      if (snap === null || snap === undefined) {
        reasons.push({ dimension: 'world', code: 'corroboration_missing', detail: `佐证 #${i + 1} 的快照不在：${c.snapshot}` });
        continue;
      }
      // 三件套缺一即不算数。缺字段不能当「跳过检查」，那等于缺省即通过。
      if (typeof c.sha256 !== 'string' || c.sha256 === '') {
        reasons.push({ dimension: 'world', code: 'corroboration_unhashed', detail: `佐证 #${i + 1} 没有 sha256` });
        continue;
      }
      if (sha256(snap) !== c.sha256) {
        reasons.push({ dimension: 'world', code: 'corroboration_changed', detail: `佐证 #${i + 1} 的快照被改过` });
        continue;
      }
      if (typeof c.quote !== 'string' || c.quote === '') {
        reasons.push({ dimension: 'world', code: 'corroboration_no_quote', detail: `佐证 #${i + 1} 没有引文` });
        continue;
      }
      if (!locateAll(snap, [c.quote]).ok) {
        reasons.push({ dimension: 'world', code: 'corroboration_quote_missing', detail: `佐证 #${i + 1} 的引文定位不到` });
        continue;
      }
      // 同一条佐证写两遍不算两份独立来源。
      //
      // 判据只看内容哈希，不看路径：同一篇文章存成 raw/verify-1.txt 和 raw/copy.txt，
      // 内容一样，仍然是同一份材料。以前键里带了 snapshot 路径，改个文件名就能骗成两份。
      // 路径是位置，哈希才是身份。
      const dupKey = c.sha256;
      if (seenCorrob.has(dupKey)) {
        reasons.push({ dimension: 'world', code: 'corroboration_duplicate', detail: `佐证 #${i + 1} 和第 ${seenCorrob.get(dupKey) + 1} 条是同一份材料，只算一份` });
        continue;
      }
      seenCorrob.set(dupKey, i);
      worldBasis += 1;
    }
  }

  // ---- 世界维度之二：实测复跑 ----
  // corroborations 解决「别人也这么说」，runs 解决「我自己跑出来是这样」。
  // 核三件事：脚本没被改、输出没被改、期望值仍在输出里。
  // 任一条不成立，这次实测就清零——不是打个折，因为「脚本改过了但结论没变」
  // 恰恰是最常见的那种悄悄失效。
  const runs = Array.isArray(data.runs) ? data.runs : [];
  let runBasis = 0;
  for (const [i, r] of runs.entries()) {
    const at = `实测 #${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      reasons.push({ dimension: 'world', code: 'run_malformed', detail: `${at} 不是对象` });
      continue;
    }
    if (typeof readRunScript !== 'function' || typeof readSnapshot !== 'function') {
      reasons.push({ dimension: 'world', code: 'run_unverifiable', detail: `${at}：调用方没提供读取器，实测无法核验` });
      continue;
    }
    const src = typeof r.script === 'string' && r.script !== '' ? readRunScript(r.script) : null;
    if (src === null || src === undefined) {
      reasons.push({ dimension: 'world', code: 'run_script_missing', detail: `${at} 的脚本不在：${r.script}` });
      continue;
    }
    if (typeof r.script_sha256 !== 'string' || r.script_sha256 === '') {
      reasons.push({ dimension: 'world', code: 'run_script_unhashed', detail: `${at} 的脚本没有哈希，无法证明跑的是哪一版` });
      continue;
    }
    if (sha256Bytes(src) !== r.script_sha256) {
      reasons.push({ dimension: 'world', code: 'run_script_changed', detail: `${at} 的脚本被改过，结论没有跟着重跑` });
      continue;
    }
    // 上游产物：模型、中间数据、上一次运行的结果。
    // 真实实验几乎都是链式的，只核本脚本抓不到「模型被换了一个」——
    // 而那才是最常见的失效方式。
    // inputs 存在但不是数组 = 声明的依赖坏了，不能当成「没有依赖」。
    // 那样一条本该失效的实测会白拿依据。
    if ('inputs' in r && !Array.isArray(r.inputs)) {
      reasons.push({ dimension: 'world', code: 'run_inputs_malformed', detail: `${at} 的 inputs 不是数组` });
      continue;
    }
    const inputs = Array.isArray(r.inputs) ? r.inputs : [];
    let inputBroken = null;
    for (const [j, inp] of inputs.entries()) {
      const text = inp && typeof inp.path === 'string' ? readRunScript(inp.path) : null;
      if (text === null || text === undefined) {
        inputBroken = `上游 #${j + 1} 不在：${inp?.path}`;
        break;
      }
      if (sha256Bytes(text) !== inp.sha256) {
        inputBroken = `上游 #${j + 1} 变了：${inp.path}`;
        break;
      }
    }
    if (inputBroken) {
      reasons.push({ dimension: 'world', code: 'run_input_changed', detail: `${at} 的${inputBroken}` });
      continue;
    }
    const out = typeof r.output === 'string' && r.output !== '' ? readSnapshot(r.output) : null;
    if (out === null || out === undefined) {
      reasons.push({ dimension: 'world', code: 'run_output_missing', detail: `${at} 的输出快照不在：${r.output}` });
      continue;
    }
    if (typeof r.output_sha256 !== 'string' || r.output_sha256 === '') {
      reasons.push({ dimension: 'world', code: 'run_output_unhashed', detail: `${at} 的输出没有哈希` });
      continue;
    }
    if (sha256(out) !== r.output_sha256) {
      reasons.push({ dimension: 'world', code: 'run_output_changed', detail: `${at} 的输出快照被改过` });
      continue;
    }
    const expect = r.expect && typeof r.expect === 'object' && !Array.isArray(r.expect) ? r.expect : {};
    // 空期望 = 没有可核的东西。写入路径会拒（validate 要求非空），
    // 但读时必须自己守——否则手改出来的 `expect: {}` 会白拿一条依据。
    if (Object.keys(expect).length === 0) {
      reasons.push({ dimension: 'world', code: 'run_no_expect', detail: `${at} 没有期望值，这次实测核不了任何东西` });
      continue;
    }
    // 两种「核不了」要分开报，因为改法不同：
    //   不是字符串 → 写法问题（YAML 里 4.02 没加引号，读出来是数字）
    //   是字符串但输出里没有 → 证据问题（脚本跑出来的值变了）
    //
    // 以前只挑出第二种，非字符串值被 `typeof v === 'string'` 静默放过，
    // 于是 `expect: {"mae": 4.02}` 一条断言都不核，却照样 runBasis += 1。
    // 写入路径（validate）会拒数字，但读时防线自己漏了——写严读松，方向反了。
    const entries = Object.entries(expect);
    const uncheckable = entries.filter(([, v]) => typeof v !== 'string' || v === '');
    if (uncheckable.length > 0) {
      reasons.push({
        dimension: 'world',
        code: 'run_expect_uncheckable',
        detail: `${at} 的期望值没法核（不是非空字符串）：${uncheckable.map(([k]) => k).join(', ')}——数字请写成字符串`,
      });
      continue;
    }
    const missing = entries.filter(([, v]) => !containsValue(out, v));
    if (missing.length > 0) {
      reasons.push({
        dimension: 'world',
        code: 'run_expect_missing',
        detail: `${at} 的期望值在输出里找不到：${missing.map(([k]) => k).join(', ')}`,
      });
      continue;
    }
    runBasis += 1;
  }

  // 两个方向的断言都要依据。没有任何可用依据却说「真 / 假」，按未定处理。
  if (DECIDED.has(data.world_status) && worldBasis + runBasis === 0) {
    reasons.push({
      dimension: 'world',
      code: 'world_unsubstantiated',
      detail: `声称世界为${data.world_status === 'contradicted' ? '假' : '真'}，但没有一条可用佐证或有效实测——按未定处理`,
    });
    world = 'unresolved';
  }

  // ---- 判断档：手改文件也改不掉这条限制 ----
  //
  // validate 会拒绝「basis=判断 + evidence_status=supported」。但这一层的
  // 整个前提是「状态不存，读时算」——手改文件正是它要防的场景。
  // 如果只在写闸门守，读时就等于把这个承诺让掉了。
  if (judgedBasis && evidence === 'supported') {
    reasons.push({
      dimension: 'evidence',
      code: 'judged_basis_supported',
      detail: '判断档不能声称来源支持这个结论——原文并没有说它',
    });
    evidence = 'not_checked';
  }

  // ---- gap 只在对应维度上生效，不互相污染 ----
  const gaps = Array.isArray(data.gaps) ? data.gaps.filter((g) => g && typeof g === 'object') : [];
  const blockers = (dim) => gaps.filter((g) => g.blocking !== false && gapDimension(g) === dim).map((g) => g.question);

  const evidenceBlockers = blockers('evidence');
  const worldBlockers = blockers('world');
  if (evidenceBlockers.length) evidence = 'unresolved';
  if (worldBlockers.length) world = 'unresolved';

  const evidenceOk = evidence === 'supported';
  const worldDecided = DECIDED.has(world);
  /**
   * 推理不能当依据。
   *
   * 这一条在现在的规则下是冗余的（判断档的 evidence_status 必须是
   * not_checked，evidenceOk 自然为 false），但冗余要留着：
   * 哪天有人放宽了 evidence 的判定，这里不会跟着悄悄放行。
   * 「用推出来的结论去否定别人」是这套工具最该拦住的一种用法。
   */
  const basisDecisive = data.basis !== '判断';

  /**
   * 边界声明：这条不能被用来干什么。
   *
   * 位置很关键——它**不是** hard_fail，但它决定能不能下判断。
   *
   * 理由：一条能当依据去否定别人的主张，被推过头会伤人；而「不写边界」
   * 不是数据坏了，是没想清楚。用报错挡这类事有两个问题：挡住写入但挡不住
   * 三个月后的误用；而且会和老条目撞死锁（同时缺 basis 和 not_for 时两个都补不上）。
   *
   * 所以判在这里：缺边界 → 不判 decisive。不是不能入库，是不能拿去否定别人。
   */
  const notForList = Array.isArray(data.not_for)
    ? data.not_for.filter((x) => typeof x === 'string' && x.trim() !== '')
    : [];
  const hasBoundary = notForList.length > 0;

  /**
   * 退役：这条不再当依据，但条目留着。
   *
   * 注意它**不改 evidence_effective / world_effective**——原文有没有说过、
   * 事情是不是真的，这两件事不会因为我们决定不用它而变化。改的是可用性。
   *
   * 混在一起改，会让人以为证据失效了，于是去补一份新的证据来修一个
   * 本来就不需要修的东西。
   */
  const retiredInfo = retiredOf(data);
  const retired = retiredInfo !== null;

  // 退役**不进 reasons**。
  //
  // 第一版把它 push 进 reasons，dimension 标成 evidence，于是 status 出现
  // 「来源维度 supported -> supported」紧跟着「为什么降级：[evidence] entry_retired」——
  // 一屏之内自己否定自己。更糟的是 dimension=evidence 会让任何按维度
  // 统计「证据问题」的下游，把「我们决定不用了」算成「证据出毛病了」，
  // 而这正是退役设计要避免的那个混淆——只是从字段搬到了 reason 的维度标签上。
  //
  // 退役是独立状态，不是降级。它有自己的字段，cli 单独打印。
  if (retired && retiredInfo.invalid) {
    reasons.push({
      dimension: 'retired',
      code: 'retired_malformed',
      detail: 'deprecated 字段存在但内容残缺（缺 at 或 reason）——按退役处理，但这条记录本身要修',
    });
  }

  /**
   * 推理链：这条判断从哪几条推的，那几条现在还站得住吗。
   *
   * 判断档最容易被当成一坨黑——「反正是推的，都不能用」。但「把三条可引的事实
   * 摆在一起」和「我自己想的」差得很远，这个差别值得被算出来。
   *
   * `citableOf` 由调用方注入（deriveStatus 是纯函数，不能自己去读别的条目）。
   * 没注入时 `computed: false`——**不假装算过**，也不给一个假的 0/3。
   */
  let derivation = null;
  if (data.basis === '判断' && Array.isArray(data.derived_from) && data.derived_from.length > 0) {
    const ids = data.derived_from;
    const unknown = [];
    let usable = 0;
    if (citableOf) {
      for (const id of ids) {
        const c = citableOf(id);
        if (c === null || c === undefined) unknown.push(id);
        else if (c) usable += 1;
      }
    }
    derivation = {
      total: ids.length,
      usable,
      unknown,
      computed: Boolean(citableOf),
      complete: Boolean(citableOf) && unknown.length === 0 && usable === ids.length,
    };
  }

  // ---- 可选：原件定位（页码 + 框）----
  // 这一层回答的是「这句话在原件 PDF 的哪一页哪一块」，与「快照里有没有」
  // 是两个问题。快照可能是 OCR 出来的，原件里那句话可能长得不一样。
  // 所以它不改两个 verdict，只单独给一个 original_verified 信号。
  const locations = [];
  let originalVerified = null;
  if (boxes && Array.isArray(boxes.boxes) && boxes.boxes.length > 0) {
    const byQuote = new Map(boxes.boxes.map((b) => [b.quote, b.found]));
    const quoteList = Array.isArray(data.quotes) ? data.quotes.filter((q) => typeof q === 'string') : [];
    let missing = 0;
    for (const q of quoteList) {
      const hit = byQuote.get(q);
      if (hit) {
        locations.push({ quote: q, page: hit.page, page_count: hit.page_count, bbox: hit.bbox, lines_spanned: hit.lines_spanned });
      } else {
        missing += 1;
        reasons.push({
          dimension: 'evidence',
          code: 'box_missing',
          detail: `引文在原件 PDF 里定位不到：${JSON.stringify(q.slice(0, 30))}`,
        });
      }
    }
    originalVerified = missing === 0;
  }

  return {
    id: data.id ?? dirName,
    claim: data.claim ?? '',
    kind: data.kind ?? null,
    layer: data.layer ?? null,
    basis: data.basis ?? null,
    source_kind: data.source_kind ?? null,
    evidence_status: data.evidence_status ?? null,
    evidence_effective: evidence,
    world_status: data.world_status ?? null,
    world_effective: world,
    downgraded: evidence !== data.evidence_status || world !== data.world_status,
    reasons,
    blocking_gaps: { evidence: evidenceBlockers, world: worldBlockers },
    /**
     * 两级可用性。混成一级会把「参考架构」类条目全部判死，
     * 因为「这个做法对不对」永远只能 unresolved。
     *
     * citable  能引用：来源确实这么说过（引文已定位）。用来触发去查、说明有这种说法。
     * decisive 能下判断：还要 标准层 + 世界维度有结论。用来判「你这做法业余」。
     */
    evidence_ok: evidenceOk,
    citable: evidenceOk && !retired,
    decisive: basisDecisive && data.layer === '标准' && evidenceOk && worldDecided && !retired && hasBoundary,
    usable_as_basis: basisDecisive && data.layer === '标准' && evidenceOk && worldDecided && !retired && hasBoundary,
    // 差一步就能下判断的，单独记下来——否则人只会看到「否」，不知道为什么否。
    boundary_missing: basisDecisive && data.layer === '标准' && evidenceOk && worldDecided && !retired && !hasBoundary,
    retired,
    deprecated: retiredInfo,
    derivation,
    not_for: notForList,
    value: data.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value : null,
    original_verified: originalVerified,
    world_basis: worldBasis + runBasis,
    /**
     * 依据从哪来。这两个不是一回事：
     *   corroboration = 别人也这么说（独立来源，能反对也能支持）
     *   run           = 我自己跑出来是这样（只能支持数值性主张，
     *                   不能证明「这个解释对」——一次实验不解释自己）
     * 分开展示，是为了不让人把「我跑过」当成「学界认可」。
     */
    world_basis_detail: { corroborations: worldBasis, runs: runBasis },
    corroborations,
    runs,
    locations,
    prereq: Array.isArray(data.prereq) ? data.prereq : [],
    gaps,
    body,
  };
}
