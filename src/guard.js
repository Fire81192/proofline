/**
 * 动作前闸门。
 *
 * 存在的理由：入库校验再好，也只管「已经决定要记下来的东西」。
 * 而真正会出事的地方在更前面——AI 直接改文件、直接删目录、直接往外发。
 * 那个位置没有任何检查点，因为它发生在有人想到要校验之前。
 *
 * ## 它不做什么
 *
 * 不做语义判断。不问「这个指令专不专业」——那要给每个领域写一套判断标准，
 * 写不完，也测不准。它只拦四类**机械可判**的事：
 *
 *   1. 直接写 entries/<id>/entry.md   绕过版本校验与入库闸门
 *   2. 目标跑出工作区                  工具管不着的边界
 *   3. 不可逆动作                      删、发布、强推、截断
 *   4. 内容命中已知的坑 / 含本机信息    条目里学到的教训，用在这儿
 *
 * ## 为什么这不是「门卫」
 *
 * 它仍然是个被调用的命令。区别在于调用点从「归档前」挪到了「动手前」——
 * 前者只在人想记东西时发生，后者在每个动作前都可能发生。
 * 要让它真的生效，宿主得在工具调用前挂一次；这一步工具自己做不到，
 * 但它把协议做稳（固定 JSON + 固定退出码），谁都能挂。
 *
 * ## 保守方向
 *
 * 拿不准就 ask，不 allow。整个工具的一条基本判断是：
 * 误报的代价是多看一眼，漏报的代价是「以为查过了」。
 */

import { resolve, relative, isAbsolute } from 'node:path';
import { PATTERNS } from './audit.js';

/** 决策强度，数字大的压小的。 */
export const DECISION_WEIGHT = { allow: 0, ask: 1, deny: 2 };

/**
 * 动作名归一化。
 *
 * 早先是白名单：只认 write / modify，其余当成「不是写」。
 * 结果是这道全工具唯一的 deny 能被一个动词绕过——`edit`、`create`、
 * `update`、`patch`、`save` 全部 allow。而真实环境里写文件的工具
 * 恰好就叫 Edit。
 *
 * 现在反过来：**除了明确的删除和发布，其余一律按写入处理。**
 * 不认识的动词（frobnicate 也好）走写入分支，顶多多检查一次；
 * 走漏一次就可能是整条证据被绕过。这个方向的代价小得多。
 */
const DELETE_RE = /delet|remov|unlink|eras|truncat|drop|(^|[^a-z])rm([^a-z]|$)/;
const PUBLISH_RE = /publish|deploy|releas|push|force/;

/**
 * 只读动作。
 *
 * 这一档必须单列，因为后面所有保护都写成「非读才拦」。
 * 没有它的时候，`classify` 把 read 归进 write，于是**读一个 entry.md 也会被 deny**——
 * 一个只会喊「不许碰」的闸门，第一次误伤之后就会被关掉，然后什么都不拦。
 *
 * 只列明确的读动词；不认识的仍然按写入处理。方向不能反：
 * 把写误判成读是放行，把读误判成写只是多问一句。
 */
const READ_RE = /^(read|get|list|stat|cat|head|tail|less|more|grep|search|find|ls|dir|view|open|inspect|show|check|describe|exists|test)/;

function classify(act) {
  if (READ_RE.test(act)) return 'read';
  if (DELETE_RE.test(act)) return 'delete';
  if (PUBLISH_RE.test(act)) return 'publish';
  return 'write';
}

/**
 * 条目正文：唯一合法入口是 commit（带版本保护的写入）。
 *
 * 前面加 `(^|[\\/])` 而不是锚定在开头：真实项目里 entries 常常不在工作区根下
 * （这个仓库是 workspace/ppg2abp/entries/）。早先写成 `^entries`，
 * 结果从项目根跑 guard 时一条都拦不住——**保护在真实路径下完全失效，
 * 而单元测试用的是扁平路径，正好测不到。**
 */
const ENTRY_FILE_RE = /(^|[\\/])entries[\\/][^\\/]+[\\/]entry\.md$/i;

/** 条目目录本身（删它等于删整条主张）。 */
const ENTRY_DIR_RE = /(^|[\\/])entries[\\/][^\\/]+$/i;

/**
 * 不可再生的产物：模型权重、张量、数据集、数据库。
 *
 * 只对这类文件管「覆盖」，不管文本文件的覆盖——文本编辑是正常工作，
 * 每个都拦会把闸门变成点击确认的仪式，最后一定被关掉。
 * 而 .keras 这种没人「编辑」，只有「重训一次」，覆盖等于几十小时没了。
 */
const IRREPLACEABLE_RE = /\.(keras|h5|hdf5|pkl|pickle|npy|npz|mat|parquet|db|sqlite|pt|pth|onnx|ckpt|bin|zip|tar|gz|7z)$/i;

/**
 * 规则只对代码生效。
 *
 * 那些规则问的是「这段代码有没有踩坑」，把它喂给散文会得到什么，实测过：
 * 一篇讲 PPG 的论文命中「PPG 要先滤波」，一份 README 里写了 `rm -rf` 四个字
 * 就命中「危险删除」。**23 个文档里 12 个被规则命中，全是假阳性。**
 *
 * 按扩展名判断「这是不是代码」是可靠的；按文件名判断「这是不是预处理脚本」
 * 不可靠（`_scaled.py` 做缩放但名字里没 normalize）。这两件事要分开看：
 * 这个常量只管前者。
 */
const CODE_EXT_RE = /\.(py|js|mjs|cjs|ts|jsx|tsx|c|h|cc|cpp|hpp|java|go|rs|m|r|jl|sh|bash|ps1|bat|lua|rb|php|swift|kt|scala)$/i;

/**
 * @param {object} args
 * @param {string} [args.action]      动作名：write / modify / delete / publish ...
 * @param {string} args.target        目标路径（相对 workspaceRoot 或绝对）
 * @param {string} [args.workspaceRoot]
 * @param {string} [args.content]     即将写入的内容（有就用它扫坑和隐私）
 * @param {boolean} [args.targetExists] 目标是否已存在（由调用方 stat，纯函数不碰盘）
 * @param {Array}  [args.rules]       checks 生成的规则
 * @param {Array}  [args.patterns]    隐私正则，默认 audit 那四类
 * @returns {{decision:string, action:string, target:string, inside_workspace:boolean, checks:Array}}
 */
export function guardAction({
  action = 'write',
  target,
  workspaceRoot = process.cwd(),
  content = '',
  targetExists = false,
  rules = [],
  patterns = PATTERNS,
} = {}) {
  const checks = [];
  const push = (code, decision, detail, next = null) => checks.push({ code, decision, detail, next });

  const act = String(action || 'write').toLowerCase();
  const kind = classify(act);
  const absTarget = resolve(workspaceRoot, target ?? '');
  // 统一成正斜杠再交给规则。scan 那边就是这么做的（scan.js 里 .replace(/\\/g,'/')），
  // 两边不一致的话，一条 `preprocess/` 这样的 scope 规则会在 scan 命中、在 guard 不命中——
  // 同一个动作、同一份知识，两个检查器给出不同结论。
  const rel = relative(workspaceRoot, absTarget).replace(/\\/g, '/');
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);

  // 1. 条目正文：绕过 commit 就等于绕过所有校验
  //
  // 只管 entry.md，**不管 raw/source.txt**，这是有意的，不是漏了。
  //
  // 换一份更好的原文是正常操作：你要重算哈希、重挑引文，那本来就走 set / corroborate。
  // 直接写 source.txt 会被 source_sha256 在下次 check 时抓出来（snapshot_changed），
  // 那是「事后发现」，不是「事前拦」。
  //
  // 这条边界的代价要说清：guard 不保证「库里的字节没变」，只保证
  // 「entry.md 的改动走工具」。改快照靠哈希，改正文靠闸门——两层分工，别混。
  if (ENTRY_FILE_RE.test(rel) && kind === 'write') {
    push(
      'protected_entry',
      'deny',
      `直接写 ${rel} 会绕过版本校验和入库闸门`,
      '用 proofline set / run / corroborate / check --fix 走那几条路',
    );
  }

  // 1b. 删条目不拦成 ask，直接 deny：工具里有 deprecate 干这件事。
  // 「删」会把证据链和别的条目的 prereq 一起打断，而这个库的整个价值
  // 就在「每条结论都能追回去」——删掉一条，追回去的路就断了。
  //
  // 判的是 `kind !== 'read'`，不是 `kind === 'delete'`。
  // 早先只拦 delete，于是 `purge` / `wipe` / `clear` / `destroy` 这些
  // 同样是删除语义的动词被归进 write 分支，而 write 分支只管 entry.md、
  // **不管条目目录**——四个动词全部 allow。整条主张就这么没了。
  // 不认识动作名的代价应该是多查一次，不是放行。
  if (ENTRY_DIR_RE.test(rel) && kind !== 'read') {
    push(
      'protected_entry_delete',
      'deny',
      `删条目会让依赖它的条目断链：${rel}`,
      // 这里指的路必须是真能走的。以前指向 deprecate，而 deprecate 只认来源，
      // 拿条目 id 去调只会得到「找不到这个来源」——一个 deny 指向一条死路，
      // 等于告诉人「没别的办法」，于是人就去 rm -rf 了。
      '用 proofline retire <条目> --reason "为什么"——退役是可逆的，删除不是',
    );
  }

  // 2. 越界：工具在工作区外没有版本保护，也不该假装有
  if (!inside) {
    push(
      'outside_workspace',
      'ask',
      `目标不在工作区内：${absTarget}`,
      '确认这不是误伤；工作区外出了问题，proofline 一条都查不到',
    );
  }

  // 3. 不可逆
  if (kind === 'delete' || kind === 'publish') {
    push(
      'irreversible',
      'ask',
      `${act} 没有第二次机会`,
      '先备份，或让用户明确确认这一次',
    );
  }

  // 3b. 覆盖不可再生的产物：模型、张量、数据集、数据库。
  // 不管文本文件的覆盖——那是正常编辑，每个都拦会让闸门变成点击仪式。
  if (targetExists && IRREPLACEABLE_RE.test(absTarget) && kind === 'write') {
    push(
      'overwrite_artifact',
      'ask',
      `要覆盖的是不可再生的产物：${rel || absTarget}`,
      '先确认真的想重写它；这东西重来一次的成本不是「再跑一遍」',
    );
  }

  // 4. 已知的坑：条目里学到的教训，在写代码时用上。
  // 只对代码文件跑——喂给散文会得到一堆假阳性（见 CODE_EXT_RE 的注释）。
  if (content && CODE_EXT_RE.test(absTarget)) {
    for (const r of rules) {
      if (typeof r?.detect !== 'function') continue;
      let hits;
      try {
        // 带 scope 的规则要按目标路径判断该不该管这条内容。
        hits = r.detect(content, rel);
      } catch {
        continue; // 单条规则坏了不该挡整个闸门
      }
      if (!hits || hits.length === 0) continue;
      const first = hits[0];
      push(
        'rule_hit',
        'ask',
        `${r.entry ?? '某条'}：${r.action ?? '命中一条已知的坑'}`,
        first ? `第 ${first.line} 行：${first.snippet}` : null,
      );
    }
  }

  // 5. 隐私：要写出去的东西里带着本机信息。
  // 认 `// audit-ignore` 豁免——否则同一个文件，audit 说干净、guard 说危险，
  // 两个检查器对同一份东西给出相反结论，人只会两个都不信。
  if (content) {
    const scannable = content
      .split('\n')
      .filter((line) => !/(?:\/\/|#|<!--)\s*audit-ignore\b/.test(line))
      .join('\n');
    for (const p of patterns) {
      if (!p?.re) continue;
      p.re.lastIndex = 0; // 带 g 的正则跨次调用会残留位置
      if (p.re.test(scannable)) {
        push('privacy', 'ask', `内容里有${p.label}`, '这东西写出去就收不回来了');
      }
    }
  }

  const decision = checks.reduce(
    (acc, c) => (DECISION_WEIGHT[c.decision] > DECISION_WEIGHT[acc] ? c.decision : acc),
    'allow',
  );

  return { decision, action: act, target: absTarget, inside_workspace: inside, checks };
}
