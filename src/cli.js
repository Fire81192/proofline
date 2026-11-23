#!/usr/bin/env node
/**
 * CLI。
 *
 * 五个命令，每个对应设计里的一件事：
 *   check   四态校验（写入前 / 定期维护）
 *   status  读时重算（每次要用之前）
 *   index   生成索引行（给 agent 的检索入口）
 *   new     建条目（把「原文 + 引文」钉成一条）
 *   fields  打印字段契约
 *
 * 退出码：0 全过 / 1 有 hard_fail 或 dirty / 2 用法错误。
 * 沿用 MasterVault 的约定，好让脚本和 agent 能直接判断。
 */

import { readFile, writeFile, mkdir, stat, readdir, unlink, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, isAbsolute, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { FIELD_DOC, KEY_ORDER, retiredOf } from './core/schema.js';
import { parseFrontmatter, joinFrontmatter } from './core/frontmatter.js';
import { sha256, sha256Bytes } from './core/snapshot.js';
import { validateEntry } from './core/validate.js';
import { deriveStatus } from './core/status.js';
import { listEntryDirs, readEntry, commit, writeEntryText, resolveInside, contentHash } from './core/store.js';
import { createEntry } from './create.js';
import { fromAgentero, fromCodeDir } from './importers.js';
import { decide, replay, toRecords, DEFAULT_POLICY } from './interrupt.js';
import { readLog, appendLog, listProjects } from './ledger.js';
import { scanProject } from './scan.js';
import { RULES } from './rules.js';
import { rulesFromEntries, draftChecks } from './checks.js';
import { readSources, writeSources, overview, statusOf, groupBySource } from './sources.js';
import { renderView } from './views/view.js';
import { renderViewMd } from './views/view-md.js';
import { groupByTopic, flagged, valueTables, valueConflicts } from './topics.js';
import { startServer } from './serve.js';
import { buildForest } from './map.js';
import { readMap, analyze } from './views/curriculum.js';
import { isInboxOn, setInbox, readProject, INBOX_DIR, DONE_DIR } from './core/inbox.js';
import { readTrace, verifyChain, lastByEntry, controlState, appendTrace, readHead, writeHead, verifyHead, lineHash } from './core/trace.js';
import { checkValue } from './core/value-check.js';
import { renderCurriculum } from './views/curriculum-view.js';
import { auditDir } from './audit.js';
import { guardAction } from './guard.js';
import { containsValue } from './core/quote.js';

const DEFAULT_ROOT = 'entries';

function usage() {
  process.stdout.write(`proofline —— 每条主张都要能在原文里定位到

用法：
  proofline check  [目录] [--fix]      校验全库，四态
  proofline status <id> [目录]          读时重算这条现在还能不能用
  proofline index  [目录]               生成 INDEX.md
  proofline review [目录] [--topic 话题] [--json]   同话题的主张并排看
  proofline new    <id> --spec f.json [目录]
  proofline import <id> --paper <目录> --claim "..." --quote "..." [目录]
  proofline import <id> --code  <目录> --claim "..." --quote "..." [--url 仓库地址] [目录]
  proofline corroborate <id> --source <文件> --uri <地址> --quote "..." [目录]
  proofline run    <id> --script <脚本> --output <输出> --expect 键=值 [--input <上游产物>] [目录]
  proofline draft  <id> [目录] [--json]     从条文里抽 check 候选（不替你做决定）
  proofline guard  --target <路径> [--action write] [--content <文件>] [--json]   动手前问一次
  proofline set    <id> <字段> <值> [目录]
  proofline set    <id> --patch '{"k1":v1,"k2":v2}' [目录]   两个字段必须同时改时用这个
  proofline scan   <目录> --project <项目> [--advise] [--commit] [--json]
  proofline advise --project <项目> --candidates <f.json> [--commit] [--json]
  proofline sources [目录] [--json]        看这个库靠哪些材料撑着
  proofline projects ['workspace'] [--json]   多个库并排：各自几条、能引用几条
  proofline stats  [目录] [--json]         文档里要引用的数字，从库里现算一遍
  proofline trace  [目录] [--json]         看留痕：哪些条目没入库记录、哪些被改过
  proofline trace  [目录] --adopt --confirm  为已有条目建基线（写明此前不可考）
  proofline doctor [目录]                  体检：物理隔离生效没有、留痕全不全、地图在不在
  proofline inbox  [on|off] [目录]         收件箱开关：开了之后 new/import 必须先落草稿
  proofline ingest <收件箱目录> [--into X] [--confirm]   把草稿搬进正式区
  proofline deprecate <来源> --reason "..." [--confirm]   弃用前先看后果
  proofline restore <来源> [目录]          恢复为「在用」
  proofline retire <条目> --reason "..." [--by <接替者>] [--confirm]
                                           条目退役：留着，但不再当依据
  proofline retire <条目> --undo            撤销退役
  proofline view   [--out 文件]            导出只读证据册（静态文件，可发给别人）
  proofline map    [--out 文件 | --json]  生成课程地图；--json 只出数据（给别人渲染用）
  proofline map    --brief                  生成「给 AI 的地图任务书」，可整段粘过去
  proofline serve  [--port 4321] [--open]       本地只读服务，刷新即当下
  proofline open                                = serve --open（最常用，记不住命令就用它）
  proofline audit  [目录] [--strict] [--all] [--json]
  proofline rules
  proofline log    <项目>
  proofline fields                      打印字段契约
  proofline fields --audit [目录]        字段审计：谁写、谁读、条目里有几种值

退出码：0 通过 / 1 有 hard_fail 或 dirty / 2 用法错误
`);
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

/**
 * 用系统默认浏览器打开一个地址。
 *
 * 打不开不算失败：服务已经起来了，地址也印出来了，用户自己粘一下就行。
 * 所以这里吞掉错误，只在返回 false 时提示一句。
 */
function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 目录必须存在。不存在 ≠ 空的 ≠ 干净——这三件事必须分开。 */
async function ensureDir(dir, what) {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) {
      out(`${what}不是目录：${dir}`);
      return false;
    }
    return true;
  } catch {
    out(`${what}不存在：${dir}`);
    return false;
  }
}

/**
 * 字段审计：每个字段都要能回答「谁写、谁读」。
 *
 * 这条规矩是从 Alexandria 的 field law 抄来的。它的来历很具体：
 * 一个 `supersedes` 字段建了 14 个月，一次都没被写过——
 * 字段本身看起来天经地义，就是没人用。
 *
 * 判据两条，缺一不可：
 *   代码层——有没有「业务读者」（create / validate / schema 之外的读取）
 *   数据层——在现有条目里有几种不同取值（只有一种 = 信息量为零）
 *
 * 两条都命中才算死字段。只命中一条的标「可疑」——工具给线索，人下结论。
 */
/**
 * 找出要审计的条目目录。
 *
 * 传 entries 目录 → 就是它自己。
 * 传 workspace → 把下面每个库的 entries 都收进来——单个库看不出字段是否全局在用，
 * 比如 aqi 里没有 runs，不代表 runs 没人用。
 */
async function auditTargets(root) {
  const subs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const roots = [];
  for (const d of subs) {
    if (!d.isDirectory()) continue;
    const e = join(root, d.name, 'entries');
    const ok = await stat(e).then((s) => s.isDirectory()).catch(() => false);
    if (ok) roots.push(e);
  }
  return roots.length > 0 ? roots : [root];
}

async function cmdFieldsAudit(root) {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)));
  const names = await listSrcFiles(srcDir);
  const code = new Map();
  for (const n of names) code.set(n, await readFile(join(srcDir, n), 'utf8'));

  // 一个库看不出问题：aqi 里没有 runs，但那不代表这个字段没人用。
  // 传 workspace 就把下面所有库合起来算——「有没有读者」是全局问题。
  const roots = await auditTargets(root);
  const items = [];
  for (const r of roots) items.push(...(await loadAllEntries(r).catch(() => [])));
  const rows = [];

  for (const [key] of FIELD_DOC) {
    const re = new RegExp(`\\b${key}\\b`);
    const files = names.filter((n) => re.test(code.get(n)));
    // create/validate/schema 是「写入与形状」，不算业务读者
    // 分目录之后要按 basename 判：core/validate.js 的文件名是 validate.js，
    // 但字符串 `core/validate.js` 不等于 `validate.js`——不修正则 validate 会被算成业务读者。
    const business = files.filter((n) => !['create.js', 'validate.js', 'schema.js'].includes(n.split('/').pop()));
    const values = new Set();
    for (const it of items) {
      const v = it.data?.[key];
      if (v === undefined || v === null) continue;
      values.add(typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));
    }
    rows.push({ key, files, business, distinct: values.size, count: items.length });
  }

  const flagged = rows.filter((r) => r.distinct <= 1 || r.business.length === 0);
  const fine = rows.filter((r) => !(r.distinct <= 1 || r.business.length === 0));

  out(`字段审计：${rows.length} 个字段 · ${items.length} 条条目 · ${roots.length} 个库`);
  out();
  if (flagged.length === 0) {
    out('每个字段都有多个取值，且至少有一个业务读者。');
  } else {
    out(`要看的 ${flagged.length} 个：`);
    for (const r of flagged) {
      const verdict = r.distinct === 0 ? '从未写入'
        : r.business.length === 0 ? (r.distinct <= 1 ? '死字段：一种取值，且没有业务读者' : '没有业务读者')
        : '只有一种取值';
      out(`  ${r.key.padEnd(20)} ${String(r.distinct).padStart(3)} 种值   ${verdict}`);
    }
    out();
    out('「只有一种取值」不一定是错：比如 layer 全库都是「标准」，那是实情。');
    out('「没有业务读者」也不一定错：可能只在 validate 里当形状检查用。');
    out('两种同时命中才值得动手——那是写进去、没人读、还骗人以为有信息。');
  }
  out();
  out(`其余 ${fine.length} 个有多重取值且有业务读者，没列。`);
  return 0;
}

async function cmdCheck(root, fix) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const dirs = await listEntryDirs(root);
  if (dirs.length === 0) {
    out(`（${root} 下没有条目）`);
    return 0;
  }
  const counts = { pass: 0, fixed: 0, dirty: 0, hard_fail: 0 };
  for (const name of dirs) {
    const entry = await readEntry(root, name);
    if (!entry) {
      out(`missing\t${name}\t没有 entry.md`);
      counts.hard_fail++;
      continue;
    }
    // --fix 直接用 fix:true 跑一次：它的返回值已经把 pass / fixed / hard_fail 分好了，
    // 不需要「先 fix:false 看脏不脏，再 fix:true 修一遍」那两趟。
    const result = validateEntry({
      dirName: name, text: entry.text, snapshotText: entry.snapshotText,
      readSnapshot: entry.readSnapshot, fix,
    });
    let status = result.status;
    let autofixes = result.autofixes;

    if (fix && status === 'fixed' && result.text) {
      await writeEntryText(entry.dir, result.text);
      // 写回也必须留痕。
      //
      // 不留痕的后果很具体：`check --fix` 改完 entry.md，trace 最后一条还是旧哈希，
      // 下一次 `status` 判「未受控」——用官方工具做机械修复，反而把条目变成不可引用。
      // 「写进来的每条都有留痕」这句话，在 --fix 这条路上曾经直接失效。
      await appendTrace(root, {
        op: 'fix',
        id: name,
        after: contentHash(result.text),
      }).catch((err) => {
        // 不能 .catch(() => {}) 吞掉。create 那条路上写着「留痕失败不能静默」，
        // 这里吞了就是同一个仓库两种态度：文件改了、记录没写，下次 check 报未受控，
        // 而人只会看到「修好了」。把话说明白，让他自己决定要不要重来。
        out(`  留痕失败：${name}——entry.md 已改，但没有 fix 记录（${err.message}）`);
        out('  下次 check 会把它判成未受控。要补：proofline trace --reseal');
      });
      // 写回后复验。「fixed」必须是观察到的，不是断言的——
      // 上一轮就出现过「报了修却没修」的 autofix，只有复验才发现。
      const reread = await readEntry(root, name);
      const again = reread
        ? validateEntry({
          dirName: name, text: reread.text, snapshotText: reread.snapshotText,
          readSnapshot: reread.readSnapshot, fix: false,
        })
        : null;
      if (again && again.status === 'pass') {
        status = 'fixed';
      } else {
        status = again ? again.status : 'dirty';
        autofixes = [...autofixes, '写回后复验仍未通过'];
      }
    }

    counts[status]++;
    if (status === 'pass') continue;
    out(`${status}\t${name}`);
    for (const h of result.hardFails) out(`  hard  ${h}`);
    for (const a of autofixes) out(`  fix   ${a}`);
  }
  out();
  out(`扫描 ${dirs.length} 条 | pass=${counts.pass} fixed=${counts.fixed} dirty=${counts.dirty} hard=${counts.hard_fail}`);

  // 同话题提示：只提示，不改退出码——数据没错，只是需要人看一眼
  const registry = await readSources(root);
  const items = await collectItems(root, registry);
  const { groups, untagged } = groupByTopic(items);
  const warn = flagged(groups);
  if (warn.length > 0) {
    out();
    out(`同话题提示（${warn.length} 组需要看一眼，不影响本次成败）：`);
    for (const g of warn) out(`  ${g.topic}  ${g.flags.join(' · ')}  → proofline review ${g.topic}`);
    out('  「不一致」不代表有错，只代表同一件事上并存多种说法。');
    out('  「全组已退役」是另一回事：这个话题现在没有可用的东西了。');
  }
  if (untagged.length > 0) {
    out(`  未归话题 ${untagged.length} 条（不影响检查，但它们在 review 里看不到）`);
  }

  // 引用完整性：前置指向一条已经退役的条目。
  //
  // 这不是形状错误——那条条目本身完全合规，只是我们决定不再用它。
  // 但「依赖它」的人不会自动知道，所以要在全库层面报一次。
  // 退役不删条目的代价就是这个：链接还在，指向的东西没了。
  const all = await loadAllEntries(root);
  const retiredIds = new Set(all.filter((e) => retiredOf(e.data)).map((e) => e.id));
  const knownIds = new Set(all.map((e) => e.id));
  if (retiredIds.size > 0) {
    const dangling = [];
    for (const e of all) {
      if (!Array.isArray(e.data?.prereq)) continue;
      for (const p of e.data.prereq) if (retiredIds.has(p)) dangling.push({ from: e.id, to: p });
    }
    if (dangling.length > 0) {
      out();
      out(`前置指向已退役的条目（${dangling.length} 处，不影响本次成败）：`);
      for (const d of dangling) out(`  ${d.from}  →  ${d.to}`);
      out('  链没断，但指向的东西已经不能用了——换前置，或者撤销那条的退役。');
    }
  }

  // 接替关系也要查。`retire --by` 只在写入那一刻看目标在不在，
  // 之后目标被删、被退役、或者两条互相接替，它一概不知道。
  //
  // 「A 由 B 接替」这句话是要给人看的：读的人会去看 B。
  // 如果 B 本身也不可用，这句话就是在骗人。
  const supersededIssues = [];
  for (const e of all) {
    const d = retiredOf(e.data);
    const to = d && typeof d.superseded_by === 'string' ? d.superseded_by : null;
    if (!to) continue;
    if (!knownIds.has(to)) {
      supersededIssues.push(`${e.id}  →  ${to}（这个条目不存在）`);
    } else if (retiredOf(all.find((x) => x.id === to)?.data)?.superseded_by === e.id) {
      // 环要排在「接替者也退役了」前面判。互相接替的两条一定都退役了，
      // 先判退役就会把它说成两个独立的「接替者也退役了」，
      // 而真正的问题是它们指回了对方——那是结构错，不是状态变化。
      supersededIssues.push(`${e.id}  ⇄  ${to}（互相接替，谁都没接上）`);
    } else if (retiredIds.has(to)) {
      supersededIssues.push(`${e.id}  →  ${to}（接替者自己也退役了）`);
    }
  }
  if (supersededIssues.length > 0) {
    out();
    out(`接替关系有问题（${supersededIssues.length} 处，不影响本次成败）：`);
    for (const s of supersededIssues) out(`  ${s}`);
    out('  「由谁接替」是给人指路的。指到一个不可用的地方，不如不指。');
  }

  // 结构提示：这个库有没有骨架，地图跟没跟上。
  //
  // 为什么放在 check 里：知识地图不是一条命令，是一个「该画了」的判断。
  // 工具画不出地图（那要理解这个领域需要什么），但它能一直指出两件可核的事：
  // 这个库根本没有地图；或者地图落后了，有几条在用主张没挂在任何能力块上。
  // 不说，就等于默认「一堆孤立的句子」是可接受的状态——而它恰恰是这个工具
  // 最想避免的东西：43 条各自成立，合起来什么都没解释。
  const st = await structureState(root, items);
  // 形状错误先说：它会污染后面的覆盖率判断（块被跳过，条目就会显示成孤儿）。
  if (st.shapeErrors.length > 0) {
    out();
    out(`结构提示：地图里有 ${st.shapeErrors.length} 处形状不对：`);
    for (const e of st.shapeErrors.slice(0, 5)) out(`  · ${e}`);
    if (st.shapeErrors.length > 5) out(`  · 还有 ${st.shapeErrors.length - 5} 处`);
    out('  这些块被跳过了，下面的覆盖率会偏低——先修形状，再看覆盖率。');
  }
  if (!st.hasMap && st.mapError) {
    out();
    out(`结构提示：knowledge-map.json 读不了——${st.mapError}`);
    out('  这不是「还没画」，是「画了但存坏了」。先修文件，别急着新建一份。');
  } else if (!st.hasMap && st.active > 0) {
    out();
    out(`结构提示：这个库没有 knowledge-map.json——${st.active} 条主张现在是彼此的孤岛。`);
    out('  地图回答的是「这些句子撑起了哪几块能力、哪块还空着」，不是「一共有几条」。');
    out('  要画：在库目录下写 knowledge-map.json，再跑 proofline map <entries 目录>。');
  } else if (st.hasMap && st.blocks === 0) {
    // 「有文件但 blocks 是空的」和「没有文件」是两件事：
    // 前者说明有人画过、但没画完（或者清空了）；后者说明从没开始。
    out();
    out(`结构提示：knowledge-map.json 里一个能力块都没有——${st.active} 条主张还是没有骨架。`);
    out('  有文件不等于有地图。空 blocks 只是让检查闭嘴，不解决任何问题。');
  } else if (st.hasMap && (st.orphans.length > 0 || st.dangling.length > 0 || st.stale.length > 0)) {
    out();
    if (st.orphans.length > 0) {
      out(`结构提示：地图落后了——${st.active} 条在用主张里有 ${st.orphans.length} 条没挂到任何能力块：`);
      out(`  ${st.orphans.slice(0, 8).join('、')}${st.orphans.length > 8 ? ' 等' : ''}`);
      out('  可能是新条目没进地图，也可能它本来就不属于任何能力块——两种都要人看一眼。');
    }
    if (st.dangling.length > 0) {
      out(`结构提示：地图里引用了 ${st.dangling.length} 条库里不存在的条目：${st.dangling.slice(0, 8).join('、')}`);
      out('  条目被删或改名了，地图还在指它。');
    }
    if (st.stale.length > 0) {
      out(`结构提示：地图还挂着 ${st.stale.length} 条已退役的条目：${st.stale.slice(0, 8).join('、')}`);
      out('  退役的意思是「不再当依据」。它继续撑着一个能力块，那一块看起来就是有支撑的。');
    }
  }

  // 数值校验：value 里写的那个数，必须能在引文里找到。
  //
  // 只查 basis=条目 的：实测的数字来自 runs 输出，判断的数字是算的，
  // 对它们要求「原文有」等于要求推算结果凭空出现。
  const valueIssues = [];
  for (const e of all) {
    if (e.broken) continue;
    const r = checkValue({
      claim: e.data?.claim,
      value: e.data?.value,
      basis: e.data?.basis,
      quotes: e.data?.quotes,
      snapshotText: e.entry?.snapshotText ?? null,
    });
    if (r.checked && !r.ok) valueIssues.push({ id: e.id, ...r });
  }
  if (valueIssues.length > 0) {
    out();
    out(`数值提示 ${valueIssues.length} 条（value 里写的数，对不上原文）：`);
    for (const v of valueIssues.slice(0, 8)) out(`  ${v.id}  ${v.detail}`);
    if (valueIssues.length > 8) out(`  …还有 ${valueIssues.length - 8} 条`);
    out('  这只是提示，不改判定：引文选窄了可以只换引文，数字来源不明要回去核对。');
  }

  // 留痕：哪些条目没有入库记录，或者入库后被改过。
  //
  // 这不是「拦截」——拦不住，AI 有文件写权限。这是让绕过留下证据：
  // 没记录的、记录对不上的，都标出来，并且在 status / view 里不给「可引用」。
  // 拦不住但能作废，比拦不住又装作没事强。
  const trace = await readTrace(root);
  const chain = verifyChain(trace.lines);
  const head = await readHead(root);
  const headChk = verifyHead(head, trace.lines);
  const lastRec = lastByEntry(trace.lines);
  const uncontrol = [];
  for (const e of all) {
    const state = controlState(lastRec.get(e.id)?.after ?? null, contentHash(e.text));
    if (!state.controlled) uncontrol.push({ id: e.id, ...state });
  }

  if (trace.error) {
    out();
    out(`留痕读不了：${trace.error}`);
    out('  没有留痕不等于没被改过——只等于没法判断。');
  } else if (!headChk.ok) {
    // 链本身可能自洽，但末行被改过或末尾被追加过——这两种都不会让任何 prev 对不上。
    out();
    out(`留痕链头对不上：${headChk.reason}`);
    out('  链头在 .trace.head，它记着最后一条的哈希和总条数。');
    out('  对不上说明记录被改过或增删过；确认是本人操作的话，跑 proofline trace --reseal 重建链头。');
  } else if (!chain.ok) {
    out();
    out(`留痕链在第 ${chain.brokenAt} 行断了：${chain.reason}`);
    out('  链断说明记录被改过或被插过；从断点之后的所有记录都不能作数。');
  } else if (uncontrol.length > 0) {
    out();
    out(`未受控 ${uncontrol.length} 条（在工具之外被写或改过，不能当依据）：`);
    for (const u of uncontrol.slice(0, 8)) out(`  ${u.id}  ${u.why}`);
    if (uncontrol.length > 8) out(`  …还有 ${uncontrol.length - 8} 条`);
    if (!trace.exists) {
      out('  这个库还没有任何留痕。要么一直是在工具之外手写的，要么是留痕功能加入之前建的。');
      out('  接受现状并建立基线：proofline trace --adopt（会写明「此前历史不可考」）');
    } else {
      out('  可能是手改了 entry.md，也可能是改了之后顺手改了 frontmatter 里的哈希。');
    }
  }

  // 收件箱只在「明确关掉」时说一句。
  // 从没启用过的库不提——每次体检都多一行，人会整体不看，那是更大的损失。
  const proj = await readProject(root);
  if (proj?.inbox === false && items.length > 0) {
    out();
    out('收件箱：这个库启用过，现在关着——新建会直接写正式区，只靠留痕兜底。');
  }

  return counts.hard_fail || counts.dirty ? 1 : 0;
}

/**
 * 一个库的地图状态。
 *
 * 只做机械判断：有没有地图文件、有哪些条目没被任何能力块引用、
 * 地图有没有指向不存在的条目。至于「该不该把这条挂上去」，人说了算。
 */
async function structureState(root, items) {
  const active = items.filter((it) => !it.retired);
  const retired = new Set(items.filter((it) => it.retired).map((it) => it.id));
  const { knowledge, knowledgeError, knowledgeShape } = await readMap(root);

  // 「读不到」有三种，别混成一句：
  //   文件不存在 / 解析失败 / 解析成功但不是对象（内容为 null、[] 之类）。
  // 上一版只分前两种，`null` 掉进了「没有地图」，于是 check 说「你还没有地图」，
  // 而磁盘上明明躺着一份（坏的）——人照着提示去新建，把它盖掉了。
  const mapError = knowledgeError ?? knowledgeShape;
  if (!knowledge) {
    return {
      hasMap: false, mapError,
      active: active.length, blocks: 0,
      orphans: [], dangling: [], stale: [], shapeErrors: [],
    };
  }
  if (!Array.isArray(knowledge.blocks)) {
    return {
      hasMap: false,
      mapError: mapError ?? 'knowledge-map.json 里没有 blocks 数组',
      active: active.length, blocks: 0,
      orphans: [], dangling: [], stale: [], shapeErrors: [],
    };
  }

  // 手写地图最常见的手滑是 entries 写成数字或单个字符串。
  // 直接 for...of 会崩（数字）或者逐字符迭代（字符串，于是把 "2026-…" 拆成
  // 6、2、0、-… 报一堆「悬空引用」）——两种都比「报一句类型错」糟得多。
  const used = new Set();
  const shapeErrors = [];
  for (const b of knowledge.blocks) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      shapeErrors.push('blocks 里有一项不是对象');
      continue;
    }
    const label = b.name ?? b.id ?? '(无名)';
    if (b.entries === undefined || b.entries === null) continue;
    if (!Array.isArray(b.entries)) {
      shapeErrors.push(`能力块「${label}」的 entries 必须是数组，现在是 ${typeof b.entries}`);
      continue;
    }
    for (const id of b.entries) {
      if (typeof id !== 'string') {
        shapeErrors.push(`能力块「${label}」的 entries 里有非字符串项（${typeof id}）`);
        continue;
      }
      used.add(id);
    }
  }

  const known = new Set(items.map((it) => it.id));
  return {
    hasMap: true,
    mapError: null,
    active: active.length,
    blocks: knowledge.blocks.length,
    orphans: active.filter((it) => !used.has(it.id)).map((it) => it.id),
    dangling: [...used].filter((id) => !known.has(id)),
    // 挂在能力块上的退役条目：它还在库里（所以不算悬空），但已经不能当依据。
    // 地图继续拿它撑那一块，等于让一块能力看起来有支撑。
    stale: [...used].filter((id) => retired.has(id)),
    shapeErrors,
  };
}

/**
 * 一条条目的完整评估：形状（validate）+ 证据（derive）。
 *
 * 为什么要合在一起：check 只管形状，status/index 只管证据，
 * 于是「缺必填字段」的条目会 check 判废、index 却标「可引用」。
 * 一个结论两处算法，迟早打架。这里统一成一个入口。
 */
function sourceStatusOf(registry, data) {
  const uri = typeof data?.source_uri === 'string' ? data.source_uri.trim() : '';
  const rec = registry?.[uri];
  if (!rec || typeof rec !== 'object') return { status: '在用', reason: null, blocking: false };
  const status = ['在用', '可疑', '弃用'].includes(rec.status) ? rec.status : '在用';
  return { status, reason: rec.reason ?? null, blocking: status !== '在用' };
}


/**
 * 写入失败时，把「为什么」和「怎么办」都说出来。
 *
 * 只报一个错误码等于让人猜——而这个工具的每一条拒绝都该有出路。
 */
function explainCommitError(res) {
  if (res.code === 'untracked_change') {
    // 错误码留着：脚本和 CI 靠它判断；后面是人话。
    out('写入失败：untracked_change——文件内容和上次入库记录不符（在工具之外被改过）。');
    out('  留痕的意义是「每次写入都基于上次记录的状态」，所以这里不吞下改动。');
    out('  接受现状（把现在的内容当成新基线）：proofline trace --adopt');
    out('  放弃改动（回到入库时的样子）：git checkout -- <这个条目目录>');
    return;
  }
  if (res.code === 'drift') {
    out('写入失败：文件在你读它之后被改过（并发写入）。重跑一次这条命令。');
    return;
  }
  if (res.code === 'locked') {
    out('写入失败：库被另一个进程锁着。等几秒重试，或者删掉 entries/.lock（确认没有别的写入在跑）。');
    return;
  }
  out(`写入失败：${res.code}`);
}

/**
 * 算一条的形状与判定。
 *
 * `controlledOf` 是第五个参数，只在「输出里会写『可引用』三个字」的地方传。
 *
 * 为什么需要它：`deriveStatus` 只管两个维度（来源说过没、世界真不真），
 * 它读不到留痕——留痕在 `.trace.jsonl` 里，是库级的东西。
 * 结果就是 `status` 判「未受控、不给引用」，而 `index` / `review` / 地图
 * 走的是同一个 `deriveStatus`，照样标「可引用」。同一件事，两套口径。
 *
 * 接口 `status` 自己算留痕（它要单独显示「受控」那一行），所以不传这个参数。
 * 其余输出必须传，否则主张 3 只在半个工具里成立。
 */
function assessEntry(entry, name, registry = {}, citableOf = null, controlledOf = null) {
  try {
    const shape = validateEntry({
      dirName: name, text: entry.text, snapshotText: entry.snapshotText,
      readSnapshot: entry.readSnapshot, fix: false,
    });
    const derived = deriveStatus({
      dirName: name, text: entry.text, snapshotText: entry.snapshotText,
      boxes: entry.boxes, readSnapshot: entry.readSnapshot, readRunScript: entry.readRunScript,
      sourceStatus: sourceStatusOf(registry, shape.data),
      citableOf,
    });

    // 未受控 = 内容和上次入库记录不符。它和「引文没了」是两回事，
    // 但对「能不能引用」的结论一样：不能。所以在这里压一次，
    // 让所有走 assessEntry 的输出自动对齐，不用每个命令各写一遍。
    if (typeof controlledOf === 'function' && !controlledOf(name, entry.text)) {
      derived.citable = false;
      derived.controlled = false;
      derived.reasons = derived.reasons ?? [];
      derived.reasons.push({
        dimension: 'evidence',
        code: 'untracked',
        detail: '内容和上次入库记录不符——在工具之外被改过，不算依据',
      });
    }

    // 视图要的是「卡在哪」的具体一句话，不是数量
    const blockingList = (derived.gaps ?? [])
      .filter((g) => g && g.blocking !== false && (g.dimension === undefined || g.dimension === 'evidence' || g.dimension === 'world'))
      .map((g) => g.question);
    return { shape, derived, parseError: null, blockingList };
  } catch (err) {
    // 坏 frontmatter 不该让整个 index/status 崩掉——只有这一条坏。
    return { shape: null, derived: null, parseError: err.message };
  }
}

/**
 * 全库的「这条能不能引用」映射。
 *
 * 推理链要算「我推的那几条还站不站得住」，而 deriveStatus 是纯函数、读不到别的条目。
 * 所以先全库跑一遍不带 citableOf 的派生，拿到基础可用性，再注入回去。
 *
 * 两遍的开销只有在库里真的存在 derived_from 时才付——没有就不算。
 */
async function buildCitableMap(root, registry) {
  const all = await loadAllEntries(root);
  const hasDerived = all.some((e) => e.data?.basis === '判断' && Array.isArray(e.data.derived_from) && e.data.derived_from.length);
  if (!hasDerived) return null;
  const map = new Map();
  for (const e of all) {
    const { derived } = assessEntry(e.entry, e.id, registry);
    map.set(e.id, derived ? Boolean(derived.citable) : false);
  }
  return (id) => (map.has(id) ? map.get(id) : null);
}

/**
 * 全库的「这条受不受控」映射。
 *
 * trace 最后一条的 `after` 就是这条内容上次入库时的哈希——它才是「应该长什么样」。
 * 和当前文件比对，不一样就是被抓改过。
 *
 * 读不到留痕时返回 null，不返回「全都不受控」：
 * 读不到是「不知道」，不是「有问题」。不知道就不判，不冤枉人。
 */
async function buildControlledMap(root) {
  const trace = await readTrace(root).catch(() => null);
  if (!trace || trace.error) return null;
  const last = lastByEntry(trace.lines);
  return (id, text) => {
    const rec = last.get(id);
    if (!rec || typeof rec.after !== 'string') return false;
    return rec.after === contentHash(text);
  };
}

async function cmdStatus(root, id) {
  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目 ${id}`);
    return 2;
  }
  const registry = await readSources(root);
  const citableOf = await buildCitableMap(root, registry);
  const { shape, derived: s, parseError } = assessEntry(entry, id, registry, citableOf);
  if (parseError) {
    out(`${id}`);
    out(`  解析失败：${parseError}`);
    out('  这条改不了、也用不了，先修 frontmatter。');
    return 1;
  }
  out(`${s.id}`);
  out(`  主张         ${s.claim}`);
  out(`  类型 / 层级   ${s.kind} / ${s.layer} / 依据：${s.basis ?? '（旧条目未填）'}`);
  out(`  来源形态      ${s.source_kind ?? (s.basis === '判断' ? '（判断档，无来源）' : '未填')}`);
  // 数值单独一行，并带上口径。只显示「35」而不显示「谁定的 35」，
  // 等于把最容易被误读的那一半藏起来。
  if (s.value) {
    const eff = s.value.effective_from ? `，${s.value.effective_from} 起` : '';
    out(`  数值          ${s.value.number} ${s.value.unit} · ${s.value.scope}${eff}`);
  }
  // 推理链：判断档最容易被当成一坨黑，这一行把它拆开。
  if (s.derivation) {
    const d = s.derivation;
    if (!d.computed) {
      out(`  推理链        ${d.total} 条（未核对可用性）`);
    } else if (d.unknown.length > 0) {
      out(`  推理链        ${d.usable}/${d.total} 可引用，另有 ${d.unknown.length} 条不存在：${d.unknown.join(', ')}`);
    } else if (d.complete) {
      out(`  推理链        ${d.total}/${d.total} 条依据全部可引用（完整）`);
    } else {
      out(`  推理链        ${d.usable}/${d.total} 条依据可引用——推的那几条里有掉队的`);
    }
  }
  // 受控：有没有入库记录、记录对不对得上。
  // 放在「能不能引用」之前，因为它是**否决项**——未受控的条目，
  // 后面那些 supported / citable 都不作数：内容没经过入库闸门，说什么都可能是假的。
  const trace = await readTrace(root);
  const lastRec = lastByEntry(trace.lines).get(id) ?? null;
  const ctrl = controlState(lastRec?.after ?? null, entry.hash);

  out();
  if (ctrl.controlled) {
    out(`  受控         是（${lastRec.at} · ${lastRec.op}）`);
  } else {
    out(`  受控         否（${ctrl.why}）`);
    out('                内容没经过入库闸门，下面的判定都不作数。');
  }
  out();
  out(`  来源维度      ${s.evidence_status} -> ${s.evidence_effective}${s.evidence_status === s.evidence_effective ? '' : '  (已降级)'}`);
  out(`  世界维度      ${s.world_status} -> ${s.world_effective}${s.world_status === s.world_effective ? '' : '  (已降级)'}`);
  if (shape.status === 'hard_fail') {
    out(`  形状         不合规（check 会判 hard_fail，下面这些结论都不算数）`);
    for (const h of shape.hardFails.slice(0, 3)) out(`                ${h}`);
  }
  const usable = s.citable && shape.status !== 'hard_fail';
  // 退役要单独说，不能混在「否」里。它和「引文核不上」是两回事：
  // 前者是「我们决定不用了」，后者是「这条撑不住」。
  // 混在一起，人会去修一条本来就不需要修的东西。
  if (s.retired) {
    const d = s.deprecated;
    if (d.invalid) {
      const missing = [!d.at && 'at', !d.reason && 'reason'].filter(Boolean).join(' / ');
      out(`  状态         已退役，但这条记录残缺（缺 ${missing}）`);
      out('               字段写过但写残了——按退役处理，因为写残的退役不该变成可引用');
    } else {
      out(`  状态         已退役（${d.at}）：${d.reason}`);
    }
    if (d.superseded_by) out(`  由谁接替     ${d.superseded_by}`);
    // 判断档 + 退役时，「不能用」有两个独立理由。说清是哪两条，
    // 否则读者会以为退役是它唯一的问题。
    if (s.basis === '判断') {
      out('  能引用        否（两个独立理由：它本来就是推的，而且已退役）');
    } else {
      out('  能引用        否（不是撑不住，是我们决定不再用它）');
    }
    out(`  能下判断      否（同上）`);
    out(`  要恢复       proofline retire ${s.id} --undo`);
  } else {
    // 未受控是一票否决：内容没经过闸门，`citable` 说得再漂亮也不作数。
    const blockedByTrace = !ctrl.controlled;
    out(`  能引用        ${blockedByTrace ? '否（未受控——内容没经过入库闸门）' : usable ? '是（来源确实这么说过）' : '否'}`);
    const whyNo = blockedByTrace
      ? '否（同上：未受控）'
      : s.boundary_missing && shape.status !== 'hard_fail'
        ? '否（差一步：两个维度都定了，但没写清不能被用来干什么）'
        : '否（还缺世界层面的结论，或不在标准层，或形状不合规）';
    out(`  能下判断      ${!blockedByTrace && s.decisive && shape.status !== 'hard_fail' ? '是' : whyNo}`);
  }

  // 边界紧跟在「能下判断」后面。
  // 放在页脚等于承认它不重要——而「这条能被用到哪儿为止」恰恰是
  // 引用的人最该先看的一行。
  if (Array.isArray(s.not_for) && s.not_for.length > 0) {
    s.not_for.forEach((x, i) => {
      out(i === 0 ? `  不能用来      ${x}` : `                ${x}`);
    });
  }

  const basis = s.world_basis_detail ?? { corroborations: 0, runs: 0 };
  const basisParts = [];
  if (s.corroborations.length) basisParts.push(`独立来源 ${basis.corroborations}/${s.corroborations.length}`);
  if ((s.runs ?? []).length) basisParts.push(`实测 ${basis.runs}/${s.runs.length}`);
  if (basisParts.length) {
    // 两类依据分开报。合并成一个数会让人以为「我跑过一次」和
    // 「别人也这么说」是同一件事。
    out(`  世界佐证      ${basisParts.join('，')}`);
  } else {
    out(`  世界佐证      无（没有佐证或实测，就不能声称世界为真）`);
  }

  if (s.original_verified === null) {
    out(`  原件定位      未做（可选：python tools/locate.py --entry <条目> --pdf <原件>）`);
  } else {
    out(`  原件定位      ${s.original_verified ? '全部命中' : '有引文在原件里找不到'}`);
    for (const loc of s.locations) {
      const b = loc.bbox;
      out(`    p${loc.page}/${loc.page_count}  跨${loc.lines_spanned}行  [${b.x0}, ${b.top}] → [${b.x1}, ${b.bottom}]`);
      out(`      ${JSON.stringify(loc.quote.slice(0, 34))}`);
    }
  }
  if (s.reasons.length) {
    // 标题按内容定，不按习惯定。
    // 第一版无条件写「为什么降级」，于是退役条目会出现
    // 「来源维度 supported -> supported」紧跟「为什么降级」的自相矛盾。
    const onlyRetired = s.reasons.every((r) => r.dimension === 'retired');
    out();
    out(onlyRetired ? '  退役记录有问题：' : '  为什么降级：');
    for (const r of s.reasons) out(`    [${r.dimension}] ${r.code}  ${r.detail}`);
  }
  if (s.blocking_gaps.evidence.length || s.blocking_gaps.world.length) {
    out();
    out('  阻塞缺口：');
    for (const q of s.blocking_gaps.evidence) out(`    [evidence] ${q}`);
    for (const q of s.blocking_gaps.world) out(`    [world]    ${q}`);
  }
  out();
  out(`  版本         ${entry.hash}`);
  return 0;
}

async function cmdIndex(root) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const controlledOf = await buildControlledMap(root);
  const dirs = await listEntryDirs(root);
  const rows = [];
  for (const name of dirs) {
    const entry = await readEntry(root, name);
    if (!entry) continue;
    const { shape, derived: s, parseError } = assessEntry(entry, name, registry, null, controlledOf);
    if (parseError) {
      rows.push(`- （解析失败，不可用）  \n  \`${name}\` · ${parseError.slice(0, 60)} · 不可用`);
      continue;
    }
    // 形状废了就不许进索引说「可引用」——check 会拒它，index 不能替它背书。
    const flag = shape.status === 'hard_fail'
      ? '形状废'
      : (s.decisive ? '可判定' : (s.citable ? '可引用' : '仅线索'));
    rows.push(`- ${s.claim}  \n  \`${name}\` · ${s.kind} · ${s.layer} · ${s.evidence_effective}/${s.world_effective} · ${flag}`);
  }
  const body = `# 索引\n\n一行一条，只放主张和状态，不放正文。\n找的时候先扫这里，判断相关再去读那条 entry.md。\n\n共 ${rows.length} 条。\n\n${rows.join('\n')}\n`;
  const target = join(root, 'INDEX.md');
  await writeFile(target, body, 'utf8');
  out(`已写 ${target}（${rows.length} 条）`);
  return 0;
}

async function cmdNew(root, id, specPath) {
  // 收件箱开着的时候，正式区不接受直接新建——这是「多一道门」的兑现。
  // 只在 new/import 上拦：改已有条目（set/run/corroborate）仍走原路，
  // 那条路有哈希保护 + 留痕，不需要再过一道门。
  if (await isInboxOn(root)) {
    out('这个库启用了收件箱：不能直接新建。');
    out(`  把原料（原文 + 引文 + 一句话）放进 ${INBOX_DIR}/，再跑 proofline ingest。`);
    out('  要直接建：proofline inbox off 先关掉收件箱（关掉之后 check 会一直标「未启用」）。');
    return 2;
  }

  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'));
  } catch (err) {
    out(`读不到 spec：${err.message}`);
    return 2;
  }

  const result = await createEntry({ root, id, spec });
  for (const w of result.warnings ?? []) out(`注意：${w}`);

  if (!result.ok) {
    if (result.code === 'hard_fail') {
      out('拒绝写入：');
      // 兜底：拒绝理由可能来自 commit 那条路，历史上那里漏传过 hardFails。
      for (const h of result.hardFails ?? ['（没有给出理由——这是工具的 bug，不是条目的问题）']) out(`  ${h}`);
    } else if (result.code === 'dirty') {
      out('形状还不合规，先修：');
      for (const a of result.autofixes) out(`  ${a}`);
    } else {
      explainCommitError(result);
    }
    return 1;
  }
  out(`已建 ${id}  版本 ${result.hash}`);
  return 0;
}

/**
 * 从 Agentero 的论文目录接过来。
 *
 * 采集交给已经在做这件事的工具，这里只负责把它产出的文本变成可核的条目。
 * claim 和引文仍然要人给，因为「哪句是要点」是判断，不是解析。
 */
async function cmdImport(root, id, paperDir, opts) {
  let spec;
  try {
    // 代码和论文走同一条入库流程，只是快照怎么来的不同。
    // 以前代码要伪装成论文目录才能进来，那是工具让人干活的毛病。
    spec = opts.code
      ? await fromCodeDir(resolve(opts.code), { url: opts.url, title: opts.title })
      : await fromAgentero(paperDir);
  } catch (err) {
    out(`接不过来：${err.message}`);
    return 2;
  }

  const meta = spec._meta; // 不可枚举，展开与序列化都不会带出去，无需 delete


  out(`来源：${meta.title ?? '（无标题）'}`);
  out(`  正文来自 ${meta.snapshot_origin}，body_quality=${meta.body_quality}`);
  if (opts.code) out(`  source_kind=项目  source_extraction=${spec.source_extraction}`);
  else out(`  body_source=${meta.body_source}  映射为 source_extraction=${spec.source_extraction ?? '（未映射）'}`);
  for (const issue of meta.issues ?? []) out(`  注意：${issue}`);

  const merged = {
    ...spec,
    claim: opts.claim,
    quotes: [opts.quote],
    kind: opts.kind ?? '方法',
    layer: opts.layer ?? '线索',
    // 导入一定带快照和引文，所以默认「条目」。要记实测或判断，用 --basis 明说。
    basis: opts.basis ?? '条目',
    evidence_status: opts.evidence ?? 'unresolved',
    world_status: opts.world ?? 'unresolved',
    body: opts.body ?? '',
  };

  if (opts.evidence === undefined) {
    out('注意：没给 --evidence，按 unresolved 入库（判定不许猜，和 new 一致）');
  }
  if (opts.kind === undefined) out('注意：没给 --kind，按「方法」入库');
  if (opts.layer === undefined) {
    out('注意：没给 --layer，按「线索」入库——线索层永远不能下判断，这是默认值造成的，不是材料不够');
  }
  if (opts.basis === undefined) {
    out('注意：没给 --basis，按「条目」入库——导入一定带快照与引文');
  }

  const result = await createEntry({ root, id, spec: merged });
  for (const w of result.warnings ?? []) out(`注意：${w}`);

  if (!result.ok) {
    if (result.code === 'hard_fail') {
      out('拒绝写入：');
      for (const h of result.hardFails) out(`  ${h}`);
    } else if (result.code === 'dirty') {
      out('形状还不合规，先修：');
      for (const a of result.autofixes) out(`  ${a}`);
    } else {
      explainCommitError(result);
    }
    return 1;
  }
  out(`已建 ${id}  版本 ${result.hash}`);
  return 0;
}

/**
 * 给一条条目加独立佐证。
 *
 * 这是「世界维度」唯一的入口：声称某个主张是真的，就必须能拿出第二份
 * 能定位的来源。不加佐证就写 world_status: supported，校验会直接拒绝。
 *
 * 它不判断两份来源是否真的独立——那是人的判断。它只负责把第二份证据
 * 钉死成可复核的形态：快照 + 哈希 + 引文。
 */
async function cmdCorroborate(root, id, opts) {
  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目 ${id}`);
    return 2;
  }

  let snapText;
  try {
    snapText = await readFile(resolve(opts.source), 'utf8');
  } catch (err) {
    out(`读不到佐证源文件：${err.message}`);
    return 2;
  }

  const { data, body } = parseFrontmatter(entry.text);
  const existing = Array.isArray(data.corroborations) ? data.corroborations : [];
  const rel = `raw/verify-${existing.length + 1}.txt`;

  await mkdir(join(entry.dir, 'raw'), { recursive: true });
  await writeFile(join(entry.dir, rel), snapText, 'utf8');

  const corroborations = [
    ...existing,
    { uri: opts.uri, sha256: sha256(snapText), snapshot: rel, quote: opts.quote },
  ];

  const text = joinFrontmatter({ ...data, corroborations }, body, KEY_ORDER);
  const res = await commit({ root, id, text, expect: entry.hash, op: 'corroborate' });

  if (!res.ok) {
    // 提交失败就把刚写的快照删掉，别留孤儿文件：它不被任何佐证引用，
    // 却会被 audit 扫到，也会让目录与记录对不上。
    const { unlink } = await import('node:fs/promises');
    await unlink(join(entry.dir, rel)).catch(() => {});
    if (res.code === 'hard_fail') {
      out('拒绝写入：');
      for (const h of res.hardFails) out(`  ${h}`);
    } else if (res.code === 'drift') {
      out(`版本对不上：你手上是 ${res.expected}，磁盘上是 ${res.currentHash}`);
    } else {
      explainCommitError(res);
    }
    return 1;
  }
  out(`已加佐证 ${rel}  版本 ${res.hash}`);
  out('注意：world_status 仍要你自己改成 supported，程序不替你下这个结论。');
  return 0;
}

/**
 * 动作前闸门。
 *
 * 这是把执法点往前提的唯一办法：不是等归档时校验，而是在动手前问一次。
 * 它仍然是被人调用的命令——区别在于调用点从「想记东西时」挪到了「做动作前」。
 *
 * 宿主想挂它，只需要两样稳定的东西：固定的 JSON 结构 + 固定的退出码。
 * 退出码只回答「能不能直接继续」：0 能，1 不能（ask 和 deny 都要人看一眼）。
 * 要区分两者就读 JSON 的 decision —— 别指望退出码承载语义，那东西
 * 一旦被超时或信号截断就没了。
 */
async function cmdGuard(opts) {
  // root 与 workspace 不能绑成「父子」。
  //
  // 早先 workspaceRoot = resolve(root, '..')，隐含假设「entries 就在工作区根下」。
  // 真实项目里是 workspace/ppg2abp/entries/，而插件源码在 ../../proofline——
  // 于是从项目根跑时找不到条目（规则 0 条），从条目目录跑时源码又算「工作区外」。
  // 两边都错。所以：root 只用来找条目，workspace 只用来判边界，各管各的。
  let root = opts.root;
  let roots = [root];
  try {
    await stat(root);
  } catch {
    // 项目根下没有 entries 时，看 workspace/ 下有几家。
    // 有几家就全用上——这个命令问的是「这个动作安全吗」，
    // 不是「查哪个库」。让调用方先去选库，等于给它一个多余的分叉。
    const wsDir = 'workspace';
    const hits = [];
    try {
      const subs = (await readdir(wsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const n of subs) {
        const probe = join(wsDir, n, 'entries');
        try {
          await stat(probe);
          hits.push(probe);
        } catch { /* 这个子目录没有条目库 */ }
      }
    } catch { /* 没有 workspace 目录 */ }

    if (hits.length > 0) roots = hits;
  }
  root = roots[0];

  // 边界取当前工作目录：这就是「我正在哪儿动手」。
  const workspaceRoot = opts.workspace ? resolve(opts.workspace) : process.cwd();

  let content = '';
  if (opts.content) {
    try {
      const contentAbs = isAbsolute(opts.content) ? opts.content : resolveInside(workspaceRoot, opts.content);
      if (!contentAbs) {
        out(`内容文件必须在 workspace 内，或给绝对路径：${opts.content}`);
        return 2;
      }
      content = await readFile(contentAbs, 'utf8');
    } catch (err) {
      out(`读不到内容文件：${err.message}`);
      return 2;
    }
  }

  // 已知的坑全部来自条目。没有内容要查就不必读——这个命令会被挂在
  // 每个动作前面，读 22 个条目要 400ms，快得没意义但慢得很要命。
  let rules = [];
  let broken = [];
  if (content) {
    // 所有条目库的规则一起上。一个动作可能同时踩到两个库里的坑。
    const entries = [];
    for (const r of roots) {
      try {
        const dirs = await listEntryDirs(r);
        for (const name of dirs) {
          const e = await readEntry(r, name);
          if (e) entries.push({ id: name, text: e.text });
        }
      } catch { /* 单个库坏了不影响其它库 */ }
    }
    try {
      ({ rules, broken } = rulesFromEntries(entries));
    } catch {
      rules = [];
    }
  }

  // 目标存不存在要问磁盘，派生函数不碰盘。只用来判断「这是新建还是覆盖」。
  let targetExists = false;
  try {
    const st = await stat(resolve(workspaceRoot, opts.target));
    targetExists = st.isFile() || st.isDirectory();
  } catch {
    targetExists = false;
  }

  const result = guardAction({
    action: opts.action,
    target: opts.target,
    workspaceRoot,
    content,
    targetExists,
    rules,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...result, rules_loaded: rules.length, rules_broken: broken.length }, null, 2)}\n`);
  } else {
    out(`guard: ${result.decision}`);
    out(`  动作   ${result.action}`);
    out(`  目标   ${result.target}${result.inside_workspace ? '' : '  （工作区外）'}`);
    for (const c of result.checks) {
      out(`  [${c.decision}] ${c.code}  ${c.detail}`);
      if (c.next) out(`      → ${c.next}`);
    }
    if (result.checks.length === 0) out('  没有拦下来的东西。');
    if (result.decision === 'deny') out('  这条不能直接做——先换一条路。');
    else if (result.decision === 'ask') out('  做之前先看一眼上面那几条。');
  }

  return result.decision === 'allow' ? 0 : 1;
}

/**
 * 起草一条 check。
 *
 * 不做决定，只把候选摊开。理由：写 check 卡住的不是语法，是
 * 「盯着一条看懂的结论，想不出该让机器查什么」。候选词能帮人想起来。
 *
 * 草稿里 action 故意留空——空 action 会被校验拒掉，这是设计。
 * 一条说不出「检出后该怎么办」的检查，入库只会变成噪音。
 */
async function cmdDraft(root, id, json) {
  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目 ${id}`);
    return 2;
  }
  const result = draftChecks(entry.text);

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (result.candidates.length === 0) {
    out(result.note ?? '没有可用候选。');
    return 0;
  }

  out(`${id} 里出现过的代码标识符（挑一个当 present）：`);
  out();
  for (const c of result.candidates) {
    out(`  ${c.word.padEnd(24)} ${c.from.join(' / ')}${c.count > 1 ? `  ×${c.count}` : ''}`);
  }
  if (result.suggestAbsent.length) {
    out();
    out('正文里提到「不该这样」时出现的词（可作 absent 反例）：');
    for (const w of result.suggestAbsent) out(`  ${w}`);
  }
  out();
  out('草稿（把尖括号换掉，action 必须自己写，空着会被校验拒）：');
  out();
  out(JSON.stringify([{
    type: 'term',
    present: '<从上面挑一个>',
    absent: result.suggestAbsent[0] ?? '',
    level: '偏离惯例',
    cost: 'low',
    reversible: true,
    action: '',
  }], null, 2));
  out();
  out(`写入：proofline set ${id} checks '[ ... ]'`);
  return 0;
}

/**
 * 记一次实测：把「脚本 + 那次运行的原始输出 + 期望值」钉在一起。
 *
 * 这里最要紧的一步是在**写入之前**就拿期望值去输出里找。
 * 找不到就整条拒绝入库——因为找不到意味着要么期望写错了，
 * 要么结论要改。两种情况都不该让这条记录进库：
 * 前一种会留下一条永远核不过的条目，后一种会把错结论固化下来。
 *
 * 工具不执行脚本。重跑要环境、要数据、可能有副作用；一旦它自己跑，
 * 「可复现」就变成「工具说它可复现」。它只负责冻结「跑的是哪一版、
 * 出来的是什么」，并保证这两样后来没被改过。
 */
async function cmdRun(root, id, opts) {
  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目 ${id}`);
    return 2;
  }

  const scriptAbs = resolveInside(entry.workspaceRoot, opts.script);
  if (!scriptAbs) {
    out(`脚本路径必须在 workspace 内（相对 ${entry.workspaceRoot}）：${opts.script}`);
    return 2;
  }
  let scriptBuf;
  try {
    scriptBuf = await readFile(scriptAbs);
  } catch (err) {
    out(`读不到脚本：${err.message}`);
    return 2;
  }

  // 上游产物：模型、中间数据、上一次运行的结果。
  // 按字节哈希——.keras 这类二进制按 utf8 读会把非法字节换掉，
  // 算出来的值拿 sha256sum 对不上，那就不是「可核」。
  const inputs = [];
  for (const rel of opts.input ?? []) {
    const abs = resolveInside(entry.workspaceRoot, rel);
    if (!abs) {
      out(`上游路径必须在 workspace 内（相对 ${entry.workspaceRoot}）：${rel}`);
      return 2;
    }
    let buf;
    try {
      buf = await readFile(abs);
    } catch (err) {
      out(`读不到上游产物 ${rel}：${err.message}`);
      return 2;
    }
    inputs.push({ path: rel, sha256: sha256Bytes(buf) });
  }

  // --script / --input 相对 workspace，--output 却相对 cwd —— 同一命令里
  // 两个基准，从不同目录跑会指向不同文件。统一成 workspace 相对，
  // 绝对路径照旧接受（output 是读，读到哪儿由调用方负责）。
  const outAbs = isAbsolute(opts.output) ? opts.output : resolveInside(entry.workspaceRoot, opts.output);
  if (!outAbs) {
    out(`输出路径必须在 workspace 内，或给绝对路径：${opts.output}`);
    return 2;
  }
  let outText;
  try {
    outText = await readFile(outAbs, 'utf8');
  } catch (err) {
    out(`读不到输出文件：${err.message}`);
    return 2;
  }

  // 期望值对账，放在任何写入之前。
  const missing = Object.entries(opts.expect).filter(([, v]) => !containsValue(outText, v));
  if (missing.length > 0) {
    out('期望值在实际输出里找不到，这次实测不成立：');
    for (const [k, v] of missing) out(`  ${k} = ${JSON.stringify(v)}`);
    out();
    out('要么期望写错了，要么结论要改。两种情况都不该入库。');
    return 1;
  }

  const { data, body } = parseFrontmatter(entry.text);
  const existing = Array.isArray(data.runs) ? data.runs : [];
  const rel = `raw/run-${existing.length + 1}.txt`;

  await mkdir(join(entry.dir, 'raw'), { recursive: true });
  await writeFile(join(entry.dir, rel), outText, 'utf8');

  const runs = [
    ...existing,
    {
      script: opts.script,
      script_sha256: sha256Bytes(scriptBuf),
      ...(inputs.length ? { inputs } : {}),
      cmd: opts.cmd ?? '',
      output: rel,
      output_sha256: sha256(outText),
      expect: opts.expect,
      at: opts.at ?? today(),
      env: opts.env ?? '',
    },
  ];

  /**
   * 判断档挂上实测，就自动改判成实测档。
   *
   * 不然会撞死锁：`run` 拒给判断档加 runs，而 `set basis 实测` 又要求先有 runs。
   * 两个都做不了，这条永远升不上去——只能手改文件，而手改正是所有问题的源头。
   *
   * 改判的理由也是对的：跑过了就是实测。basis 说的是「凭什么知道」，
   * 现在它凭的是这次运行，不再凭推理。
   *
   * 顺带把「等验证」的缺口关掉——那个缺口问的就是「打算怎么验」，
   * 现在验了。留着它会让条目的 blocking_gaps 一直挂着。
   */
  let next = { ...data, runs };
  if (data.basis === '判断') {
    next.basis = '实测';
    const gaps = Array.isArray(data.gaps) ? data.gaps : [];
    const kept = gaps.filter((g) => !(g && g.action === 'reanalyse' && g.dimension === 'world'));
    if (kept.length !== gaps.length) next.gaps = kept;
    out('注意：这条原先是判断档，这次实测把它改判成「实测」——跑过了就算实测。');
    if (kept.length !== gaps.length) out('      同时关掉了「打算怎么验」那条缺口。');
    out();
  }
  const text = joinFrontmatter(next, body, KEY_ORDER);
  const res = await commit({ root, id, text, expect: entry.hash, op: 'run' });

  if (!res.ok) {
    // 提交失败就把刚写的输出删掉，别留孤儿文件：它不被任何 run 引用，
    // 却会被 audit 扫到，也让目录与记录对不上。
    const { unlink } = await import('node:fs/promises');
    await unlink(join(entry.dir, rel)).catch(() => {});
    if (res.code === 'hard_fail') {
      out('拒绝写入：');
      for (const h of res.hardFails) out(`  ${h}`);
    } else if (res.code === 'drift') {
      out(`版本对不上：你手上是 ${res.expected}，磁盘上是 ${res.currentHash}`);
    } else {
      explainCommitError(res);
    }
    return 1;
  }

  out(`已记实测 ${rel}  版本 ${res.hash}`);
  out(`  脚本   ${opts.script} @ ${sha256Bytes(scriptBuf).slice(0, 12)}`);
  for (const inp of inputs) out(`  上游   ${inp.path} @ ${inp.sha256.slice(0, 12)}`);
  out(`  输出   ${rel} @ ${sha256(outText).slice(0, 12)}`);
  out(`  期望   ${Object.entries(opts.expect).map(([k, v]) => `${k}=${v}`).join(', ')}  —— 全部在输出里找到`);
  out('脚本、上游产物或输出之后被改动，这次实测就会自动失效（world 维度降级），不会悄悄留着一个过期结论。');
  return 0;
}

/** 本地日期。不用 toISOString：那是 UTC，晚上会差一天。 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 改一个字段，带版本保护。
 *
 * 存在的理由：判定字段（evidence_status / world_status）只能由人写，
 * 但写也得有个入口。这个命令不猜任何东西——值写成什么样就存什么样，
 * 校验不过就整条拒绝。
 */
async function cmdSet(root, id, field, rawValue, patch = null) {
  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目 ${id}`);
    return 2;
  }
  const { data, body } = parseFrontmatter(entry.text);

  let next;
  if (patch) {
    /**
     * 一次改多个字段。
     *
     * 存在的理由：有些字段之间是「必须同时存在」的关系，一次只能改一个就永远改不了。
     *   有 source_sha256 就必须有 quotes；有 quotes 就必须有 source_sha256
     *   没有快照时 evidence_status 只能是 not_checked；但有了快照又要引文
     *
     * 这类约束撞过两次（basis + not_for、sha256 + quotes），每次都是手改文件绕过。
     * 而手改文件正是所有问题的源头。
     */
    let parsed;
    try {
      parsed = JSON.parse(patch);
    } catch (err) {
      out(`--patch 不是合法 JSON：${err.message}`);
      return 2;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      out('--patch 必须是一个 JSON 对象，键是字段名');
      return 2;
    }
    next = { ...data, ...parsed };
    for (const [k, v] of Object.entries(parsed)) {
      out(`${k} = ${JSON.stringify(v)}`);
    }
  } else {
    let value = rawValue;
    if (/^[\[{"]|^(true|false|null)$|^-?\d+(\.\d+)?$/.test(rawValue)) {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }
    next = { ...data, [field]: value };
  }

  const text = joinFrontmatter(next, body, KEY_ORDER);
  const res = await commit({ root, id, text, expect: entry.hash, op: 'set' });

  if (!res.ok) {
    // set 不写任何文件，所以这里没有需要清理的东西。
    if (res.code === 'hard_fail') {
      out('拒绝写入：');
      for (const h of res.hardFails) out(`  ${h}`);
    } else if (res.code === 'drift') {
      out(`版本对不上：你手上是 ${res.expected}，磁盘上是 ${res.currentHash}`);
    } else {
      explainCommitError(res);
    }
    return 1;
  }
  // --patch 模式没有单个 value，只报版本
  out(patch ? `已更新 ${Object.keys(JSON.parse(patch)).join(', ')}   版本 ${res.hash}`
             : `${field} = ${JSON.stringify(next[field])}   版本 ${res.hash}`);
  return 0;
}

/**
 * 该不该打断。
 *
 * 输入是候选提醒（谁给的都行：模型、规则检查、人），
 * 输出是这一轮里每一条的处理方式。它不生成内容。
 *
 * --commit 会把「说了的」和「记账的」追加进日志，下次就不会重复说。
 */
async function cmdAdvise(root, opts) {
  let candidates;
  try {
    candidates = JSON.parse(await readFile(resolve(opts.candidates), 'utf8'));
  } catch (err) {
    out(`读不到 candidates：${err.message}`);
    return 2;
  }
  if (!Array.isArray(candidates)) {
    out('candidates 必须是数组');
    return 2;
  }

  const nowDate = opts.now ? new Date(opts.now) : new Date();
  const records = await readLog(root, opts.project);
  const decisions = decide({ candidates, records, now: nowDate });

  if (opts.json) {
    out(JSON.stringify(decisions, null, 2));
  } else {
    const label = { hardstop: '硬停', inline: '正文', log: '记账', silent: '不说' };
    for (const d of decisions) {
      const chan = d.channel === 'list' ? ' → 清单' : '';
      out(`[${label[d.strength]}]${chan} ${d.key}`);
      out(`        ${d.reasons.join(' · ')}`);
    }
    const said = decisions.filter((d) => d.channel === 'body').length;
    out();
    out(`本轮正文 ${said} 条 / 策略上限 ${(DEFAULT_POLICY.maxPerDay)} 次/天`);
  }

  if (opts.commit) {
    const recs = toRecords(decisions, { project: opts.project, now: nowDate });
    const path = await appendLog(root, opts.project, recs);
    if (!opts.json) out(path ? `已记账 ${recs.length} 条 -> ${path}` : '没有需要记的');
  }
  return 0;
}

/** 看一个项目的插话历史，状态由重放得出。 */
async function cmdLog(root, project, asJson) {
  const records = await readLog(root, project);
  if (records.length === 0) {
    // --json 的契约是「任何情况下都能 JSON.parse」，空结果也一样。
    // 这里返回文本会让调用方为「空」写特例。
    if (asJson) {
      out(JSON.stringify({ project, records: 0, keys: {} }, null, 2));
      return 0;
    }
    out(`项目 ${project} 还没有记录。`);
    return 0;
  }
  const state = replay(records);
  const rows = [...state.entries()];

  if (asJson) {
    out(JSON.stringify({
      project,
      records: records.length,
      keys: Object.fromEntries(rows),
    }, null, 2));
    return 0;
  }

  out(`项目 ${project}：${records.length} 条事件，${rows.length} 个问题`);
  out();
  for (const [key, s] of rows) {
    const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');
    out(`  ${key}`);
    out(`    状态 ${s.status}  正文 ${s.saidCount} 次  清单 ${s.listedCount ?? 0} 次  记账 ${s.notedCount} 次`);
    out(`    正文最近 ${fmt(s.lastSaid)}  清单最近 ${fmt(s.lastListed)}`);
  }
  return 0;
}

/**
 * 扫项目，出候选。--advise 直接接判定层，一条命令走完「发现 -> 该不该说」。
 *
 * 这一层只读代码，不猜人。它发现的每一条风险，都带着文件名和行号——
 * 指不出位置的提醒，人没法核，也没法改。
 */
/** 读出所有条目里的可检查条件，变成规则。条目没了，规则也就没了。 */
async function entryRulesOf(root) {
  const names = (await listEntryDirs(root).catch(() => [])) ?? [];
  const entries = [];
  for (const name of names) {
    const entry = await readEntry(root, name).catch(() => null);
    if (entry) entries.push({ id: name, text: entry.text });
  }
  return rulesFromEntries(entries);
}

async function cmdScan(root, dir, opts) {
  if (!(await ensureDir(dir, '要扫描的目录'))) return 2;

  // 内置规则 + 从条目长出来的规则。
  // 库里的知识越多，能自动盯的坑越多——这是这套东西唯一会自己变强的地方。
  const entryRules = opts.noLibrary ? { rules: [], broken: [] } : await entryRulesOf(root);
  for (const b of entryRules.broken) {
    out(`注意：${b.entry} 的检查 #${b.index} 用不了——${b.reason}`);
  }

  const { candidates, stats } = await scanProject(dir, {
    rules: [...RULES, ...entryRules.rules],
    maxEvidence: 5,
  });
  stats.builtinRules = RULES.length;
  stats.libraryRules = entryRules.rules.length;

  const nowDate = opts.now ? new Date(opts.now) : new Date();
  let decisions = null;
  let logPath = null;

  if (opts.advise) {
    const records = await readLog(root, opts.project);
    decisions = decide({ candidates, records, now: nowDate });
    if (opts.commit) {
      logPath = await appendLog(root, opts.project, toRecords(decisions, { project: opts.project, now: nowDate }));
    }
  }

  // --json 只输出**一个** JSON 文档。以前先打 candidates 再打 decisions，
  // 两段拼在一起 JSON.parse 直接失败，调用方什么都拿不到。
  if (opts.json) {
    const payload = { stats, candidates };
    if (decisions) payload.decisions = decisions;
    if (logPath) payload.log = logPath;
    out(JSON.stringify(payload, null, 2));
    return 0;
  }

  out(`扫描 ${stats.files} 个文件，${stats.rules} 条规则，命中 ${stats.fired} 类风险`);
  if (stats.skippedLarge) out(`（跳过 ${stats.skippedLarge} 个超大文件）`);
  out();
  out(`规则来源：内置 ${stats.builtinRules} 条 + 库里 ${stats.libraryRules} 条`);
  out();
  for (const c of candidates) {
    const fromLib = c.origin?.startsWith('entry:');
    out(`[${c.level}${c.reversible === false ? ' · 不可逆' : ''}] ${c.key}  命中 ${c.hits} 处`);
    if (fromLib) out(`    来自库：${c.claim ?? c.origin}`);
    if (fromLib && c.quote) out(`    依据：「${c.quote}」`);
    for (const e of c.evidence) out(`    ${e.file}:${e.line}  ${e.snippet}`);
    out(`    → ${c.action}`);
  }
  if (candidates.length === 0) out('没有命中。');

  if (!decisions) return 0;

  out();
  out('—— 该不该说 ——');
  const label = { hardstop: '硬停', inline: '正文', log: '记账', silent: '不说' };
  for (const d of decisions) {
    const chan = d.channel === 'list' ? ' → 清单' : '';
    out(`[${label[d.strength]}]${chan} ${d.key}   ${d.reasons.join(' · ')}`);
  }
  if (logPath) out(`已记账 -> ${logPath}`);
  return 0;
}

/**
 * 隐私自查：库里有没有本机路径、邮箱、手机号、身份证号。
 *
 * 只查不改。改了就废——快照参与哈希，删一个字那条证据就失效。
 * 所以脱敏只能在入库前做，入库后只能检查或整条作废。
 */
async function cmdAudit(root, opts) {
  if (!(await ensureDir(root, '要检查的目录'))) return 2;
  const { findings, stats } = await auditDir(root, { includeRaw: Boolean(opts.all) });

  if (opts.json) {
    out(JSON.stringify({ stats, findings }, null, 2));
  } else {
    out(`检查 ${stats.files} 个文本文件，${stats.hitFiles} 个命中`);
    if (stats.skippedRaw > 0) {
      // 跳过要报数，否则「没查」和「查了没问题」长得一样。
      // 说清是「文件」不是「快照」：raw/ 下还有 run-*.txt、boxes.json 这类派生物。
      out(`（跳过 ${stats.skippedRaw} 个 raw/ 与 sources/ 下的文件：快照不能改，报了也只能整条作废。要一起查加 --all）`);
    }
    if (stats.ignoredLines > 0) {
      // 豁免也要报数：0 命中如果来自 12 行豁免，那个 0 就是假的
      out(`（${stats.ignoredLines} 行标了 audit-ignore，按作者声明跳过）`);
    }
    // 「没扫完」必须自己说出来。
    // 原来 complete 只在 --json 里出现，文本报告看起来永远是「已检查、没问题」。
    const incomplete = [];
    if (stats.skippedLarge > 0) incomplete.push(`${stats.skippedLarge} 个文件超过大小上限`);
    if (stats.unreadableFiles > 0) incomplete.push(`${stats.unreadableFiles} 个文件读不了`);
    if (stats.unreadableDirs > 0) incomplete.push(`${stats.unreadableDirs} 个目录读不了`);
    if (incomplete.length > 0) {
      out(`⚠ 没有扫完：${incomplete.join('、')}——「没发现」不等于「干净」`);
    }
    if (findings.length === 0) {
      out(stats.complete
        ? '没有发现本机路径、邮箱、手机号、身份证号、疑似密钥。'
        : '在已扫到的部分里没有发现本机路径、邮箱、手机号、身份证号、疑似密钥。');
    } else {
      out();
      for (const f of findings) {
        out(`[${f.label}] ${f.file}  ${f.count} 处`);
        for (const s of f.samples) out(`    ${s}`);
      }
      out();
      out('这些内容一旦分享出去就带走了。');
      out('要修：源文件里改成相对路径或用占位符；原文快照不能改，只能整条作废重做。');
    }
  }

  // 严格模式：有命中，或者没扫完，都算没通过。
  // 只看 findings 等于把「4MB 的文件压根没打开」当成合格——那是 fail-open。
  if (opts.strict && (findings.length > 0 || !stats.complete)) return 1;
  return 0;
}

/**
 * 把每条条目压成一行事实，供 review / check 共用。
 *
 * 只做一次计算，谁要都读这份——两处各算一遍是这个项目反复踩的坑。
 */
async function collectItems(root, registry = {}) {
  const names = await listEntryDirs(root);
  const citableOf = await buildCitableMap(root, registry);
  const controlledOf = await buildControlledMap(root);
  const items = [];
  for (const name of names) {
    const entry = await readEntry(root, name).catch(() => null);
    if (!entry) continue;
    let data;
    try {
      data = parseFrontmatter(entry.text).data;
    } catch {
      continue; // 坏 frontmatter 由 check 报，这里不重复叫
    }
    const { shape, derived } = assessEntry(entry, name, registry, citableOf, controlledOf);
    if (!derived) continue;
    const blocked = shape?.status === 'hard_fail';
    items.push({
      id: name,
      claim: derived.claim,
      topic: typeof data.topic === 'string' ? data.topic.trim() : null,
      layer: derived.layer ?? '',
      kind: derived.kind ?? '',
      // 并排看的时候，最要紧的差别是「凭什么知道」。少了这个，
      // 一条推理和一条原文引用会挨着排在一起，看起来一样可信。
      basis: derived.basis,
      evidence: derived.evidence_effective,
      world: derived.world_effective,
      citable: Boolean(derived.citable) && !blocked,
      decisive: Boolean(derived.decisive) && !blocked,
      // 退役的条目留着，只是不再用。并排的时候要看得见这件事，
      // 否则它跟一条「没问题的条目」长得一模一样。
      retired: Boolean(derived.retired),
      value: data.value,
      derivation: derived.derivation,
      not_for: Array.isArray(data.not_for) ? data.not_for : [],
      source: typeof data.source_uri === 'string' ? data.source_uri : '',
    });
  }
  return items;
}

/** 读出所有条目（含解析后的 frontmatter），给来源统计和视图用。 */
async function loadAllEntries(root) {
  const names = await listEntryDirs(root);
  const out = [];
  for (const name of names) {
    const entry = await readEntry(root, name).catch(() => null);
    if (!entry) continue;
    try {
      const { data } = parseFrontmatter(entry.text);
      out.push({ id: name, text: entry.text, data, entry });
    } catch {
      out.push({ id: name, text: entry.text, data: {}, entry, broken: true });
    }
  }
  return out;
}

/**
 * 同话题并排。
 *
 * 它不是「矛盾检测」——工具读不懂语义，判不了谁对。
 * 它保证的是另一件事：**同一件事上的多种说法，不会互相不知道对方存在。**
 *
 * 带话题参数时只看那一组。
 */
async function cmdReview(root, only, asJson) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const items = await collectItems(root, registry);
  const { groups, untagged } = groupByTopic(items);

  const shown = only ? groups.filter((g) => g.topic === only) : groups;

  if (asJson) {
    out(JSON.stringify({ groups: shown, untagged: untagged.length }, null, 2));
    return 0;
  }

  if (only && shown.length === 0) {
    out(`没有话题 ${only}。现有话题：`);
    for (const g of groups) out(`  ${g.topic}  (${g.items.length})`);
    return 2;
  }

  if (shown.length === 0) {
    out('还没有条目写 topic，所以没有可并排的东西。');
    out('给相关条目加同一个 topic（如 ppg.preprocess），它们就会出现在这里。');
    return 0;
  }

  for (const g of shown) {
    const mark = g.flags.length ? `  ⚠ ${g.flags.join(' · ')}` : '';
    out(`${g.topic}   ${g.items.length} 条${mark}`);

    // 数值对照表放在条目列表前面。
    //
    // 放在前面的理由：人读一串主张时，眼睛是从上往下的，读到第三句就忘了第一句
    // 说的是几。而数值恰恰是最该横向比的东西。先给表，再给句子。
    for (const t of valueTables(g.items)) {
      out();
      out(`  指标 ${t.metric}（${t.unit}） · ${t.rows.length} 条带数值 · ${t.distinct} 个不同值`);
      for (const g of t.groups ?? [{ subject: '', rows: t.rows }]) {
        if (g.subject) out(`    ${g.subject}`);
        for (const r of g.rows) {
          const marks = [
            r.citable ? '' : '不可引用',
            r.retired ? '已退役' : '',
          ].filter(Boolean).join(' ');
          const eff = r.effective_from ? ` · ${r.effective_from} 起` : '';
          out(`    ${String(r.number).padStart(8)}  ${r.scope}${eff}${marks ? `  [${marks}]` : ''}`);
          out(`              ${r.id}`);
        }
      }
      if (t.distinct > 1) {
        out();
        out(`  同一个指标，${t.distinct} 个不同的值。`);
        // 数值重复时要点出来——重复不代表同一个数，可能只是一个数被切成了几段。
        const counts = new Map();
        for (const r of t.rows) counts.set(r.number, (counts.get(r.number) ?? 0) + 1);
        const dup = [...counts.entries()].filter(([, n]) => n > 1);
        if (dup.length) {
          out(`  ${dup.map(([v, n]) => `${v} 出现 ${n} 次`).join('，')}——看 scope 那一列，它们不是一回事。`);
        }
      }
    }

    const conflicts = valueConflicts(valueTables(g.items));
    if (conflicts.length) {
      out();
      for (const c of conflicts) {
        out(`  ✗ 同口径不同值：${c.metric} · ${c.scope}`);
        for (const r of c.rows) out(`      ${r.number} ${c.unit}  ${r.id}`);
        out('    口径说是同一件事，值却不一样——这两个数不可能同时成立。');
      }
    }

    out();
    for (const it of g.items) {
      const state = [
        it.citable ? '可引用' : '不可引用',
        `世界=${it.world}`,
        // 判断档单独标出来：它和旁边那条「读来的」长得一样，但分量不同。
        // 推理链完整度也带上——「3/3 条依据都可引」和「我自己想的」都是判断，
        // 但在并排看的时候，这个差别比「都是判断」有用得多。
        ...(it.basis === '判断'
          ? [`依据=判断（推的${it.derivation?.computed ? `，推理链 ${it.derivation.usable}/${it.derivation.total}` : ''}）`]
          : []),
      ].join(' · ');
      out(`  [${it.layer || '?'}] ${it.claim}`);
      out(`        ${state} · ${it.id}`);
      // 边界跟条目一起列，不要藏起来。并排看的时候，最该看到的是
      // 「这条能用到哪儿为止」——因为它旁边那条常常是它的反面。
      for (const x of it.not_for ?? []) out(`        ✗ 不能用来：${x}`);
    }
    out();
  }

  const warned = flagged(shown).length;
  out(`共 ${shown.length} 个话题，其中 ${warned} 个有不一致需要看一眼。`);
  if (!only) out(`未归话题 ${untagged.length} 条——它们不会在 review 里出现。`);
  return 0;
}

/** 来源清单：这个库到底靠哪些材料撑着，每个撑了几条。 */
/**
 * 项目总览：这个工作区里有哪些库，各自是什么。
 *
 * ## 为什么需要它
 *
 * 项目靠目录区分，但目录名不说明任何事——`workspace/aqi` 是什么，
 * 新来的人（或者三个月后的自己）得翻 README 才知道。而 `self` 连 README 都没有。
 *
 * ## 架构上的位置
 *
 * **插件只读不写，不存任何项目数据。** 分类信息在各自的 `project.json` 里，
 * 这个命令只负责把它们读出来排在一起。少了文件就显示「未登记」，不编造。
 *
 * @param {string} dir workspace 根目录，或任一项目的 entries 目录
 */
/**
 * 这个目录是不是「装着多个库的 workspace」。
 *
 * 判据是结构而不是名字：有一个子目录下面带 entries/，就算。
 * 反过来，一个 entries 目录下面全是条目目录，没有任何一个带 entries/，
 * 所以不会误判成 workspace。
 */
async function looksLikeWorkspace(d) {
  try {
    const subs = await readdir(d, { withFileTypes: true });
    for (const x of subs) {
      if (!x.isDirectory()) continue;
      try {
        await stat(join(d, x.name, 'entries'));
        return true;
      } catch { /* 这个子目录不是项目 */ }
    }
  } catch { /* 目录不存在 */ }
  return false;
}

/**
 * 把文档里那些「手抄数字」变成可重算的。
 *
 * 起因很具体：三份文档分别停在不同时刻，同一件事写着 49 条、24 条、42 条，
 * 而库里是 43 条。库变了，文档里的数字不会变，而且没人会去核对——
 * 这跟「来源说过」当成「世界为真」是同一个毛病，只是发生在文档上。
 *
 * 所以这个命令只报能被机械数出来的东西：条目数、依据档、世界维度、
 * 可引用/可判定、退役、来源、话题，以及代码规模。
 *
 * 它**不**报测试数——那要跑测试，不是读文件；文档里写测试数时，
 * 依据只能是「刚跑过的那次输出」。
 */
/**
 * 收件箱开关。
 *
 * 开着的库：`new` / `import` 拒绝直接写，必须先落 `_inbox/` 再 ingest。
 * 关掉不是「没事了」——`check` 和证据册会一直标「本库未启用收件箱」。
 *
 * 这是它和「留痕不能关」的区别：关掉是合法的，但关掉的事实必须挂在墙上。
 */
async function cmdInbox(root, action) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const cur = await isInboxOn(root);

  if (action === undefined) {
    out(`收件箱：${cur ? '已启用' : '未启用'}`);
    if (cur) {
      out(`  新建走 ${INBOX_DIR}/ + proofline ingest；改已有条目仍走 set。`);
    } else {
      out('  正式区接受直接新建。开启：proofline inbox on');
    }
    return 0;
  }
  if (action !== 'on' && action !== 'off') {
    out('用法：proofline inbox [on|off] [目录]');
    return 2;
  }

  const want = action === 'on';
  if (want === cur) {
    out(`收件箱已经是${cur ? '启用' : '关闭'}状态，没改。`);
    return 0;
  }
  await setInbox(root, want);
  if (want) {
    await mkdir(join(root, '..', INBOX_DIR), { recursive: true });
    out(`已启用收件箱：${INBOX_DIR}/`);
    out('  从下一条起，new / import 会拒绝直接写正式区，要求先落草稿再 ingest。');
  } else {
    out('已关闭收件箱。');
    out('  注意：check 和证据册会一直标「本库未启用收件箱」——关掉是合法的，但要留在明面上。');
  }
  return 0;
}

/**
 * 把收件箱里的草稿搬进正式区。
 *
 * 每个 `.json` 就是一份 spec（和 `new --spec` 同格式），但必须带 `id`。
 * 搬成功的移到 `_done/`，不删——「搬过什么」本身是记录。
 */
async function cmdIngest(srcDir, root, opts) {
  if (!(await ensureDir(srcDir, '收件箱'))) return 2;
  if (!(await ensureDir(root, '条目目录'))) return 2;

  const names = (await readdir(srcDir)).filter((n) => n.endsWith('.json')).sort();
  if (names.length === 0) {
    out(`${srcDir} 里没有 .json 草稿。`);
    return 0;
  }

  const parsed = [];
  for (const n of names) {
    try {
      const spec = JSON.parse(await readFile(join(srcDir, n), 'utf8'));
      if (!spec || typeof spec.id !== 'string' || !spec.id) {
        parsed.push({ name: n, error: 'spec 里没有 id' });
        continue;
      }
      parsed.push({ name: n, id: spec.id, spec });
    } catch (err) {
      parsed.push({ name: n, error: `不是合法 JSON：${err.message}` });
    }
  }

  const ok = parsed.filter((x) => !x.error);
  if (!opts.confirm) {
    out(`收件箱里 ${names.length} 个草稿，能搬 ${ok.length} 个：`);
    for (const x of ok) out(`  ${x.id}  ← ${x.name}`);
    for (const x of parsed.filter((y) => y.error)) out(`  ✗ ${x.name}：${x.error}`);
    out('加 --confirm 执行。');
    return 0;
  }

  const doneDir = join(srcDir, DONE_DIR);
  await mkdir(doneDir, { recursive: true });

  let moved = 0;
  let failed = 0;
  for (const x of parsed) {
    if (x.error) {
      out(`✗ ${x.name}：${x.error}`);
      failed += 1;
      continue;
    }
    const r = await createEntry({ root, id: x.id, spec: x.spec });
    if (r.ok) {
      await rename(join(srcDir, x.name), join(doneDir, x.name)).catch(() => {});
      out(`✓ ${x.id}`);
      moved += 1;
    } else {
      out(`✗ ${x.id}：${r.code}${r.hardFails?.length ? `（${r.hardFails[0]}）` : ''}`);
      failed += 1;
    }
  }

  out();
  out(`搬入 ${moved} 条，失败 ${failed} 条${moved ? `；原件已移到 ${DONE_DIR}/` : ''}。`);
  if (failed > 0) out('失败的草稿留在收件箱里，改完再跑一次 ingest。');
  return failed > 0 ? 1 : 0;
}

/**
 * 体检。
 *
 * 它回答一个别的命令都答不了的问题：**物理隔离到底生效没有。**
 *
 * 工具没法替你开关沙箱（那是宿主的设置，改错会把工作区锁死），
 * 但它能测：往 entries/ 写一个探针文件。能写，说明当前权限可以改正式区；
 * 而 AI 用的是同一套权限——这条结论直接适用于它，不是推测。
 *
 * 这个命令的价值不在「检查」，在把「不确定」变成一个随时能复核的事实。
 */
async function cmdDoctor(root) {
  if (!(await ensureDir(root, '条目目录'))) return 2;

  const items = await loadAllEntries(root);
  const active = items.filter((e) => !retiredOf(e.data));

  const trace = await readTrace(root);
  const chain = verifyChain(trace.lines);
  const last = lastByEntry(trace.lines);
  const controlled = items.filter((e) =>
    controlState(last.get(e.id)?.after ?? null, contentHash(e.text)).controlled);

  const { knowledge, knowledgeError, knowledgeShape } = await readMap(root);

  let meta = null;
  try {
    meta = JSON.parse(await readFile(join(root, '..', 'project.json'), 'utf8'));
  } catch { /* 没登记就说不确定，不编 */ }

  // 探针：写一下再删掉。删不掉也要报——留个文件比留个错觉好。
  let writable = null;
  const probe = join(root, '.probe-doctor');
  try {
    await writeFile(probe, 'doctor', 'utf8');
    writable = true;
  } catch {
    writable = false;
  } finally {
    if (writable) await unlink(probe).catch(() => {});
  }

  // 三态分开：从没启用过 / 启用中 / 启过又关了。
  // 第三种最需要说——它是「曾经在意、后来放弃」，和从没在意不是一回事。
  const proj = await readProject(root);
  const inboxState = proj?.inbox === true
    ? '已启用'
    : proj?.inbox === false
      ? '已关闭（这个库启用过）'
      : '从未启用';
  const inboxDir = join(root, '..', INBOX_DIR);
  const hasInbox = await stat(inboxDir).then((s) => s.isDirectory()).catch(() => false);

  const issues = [];
  if (writable) {
    issues.push('正式区可写：工具和 AI 用的是同一套权限，手改 entry.md 完全可能。收件箱只是约定，不是物理隔离。');
  }
  if (!trace.exists) issues.push('没有留痕：所有条目都不可引用。跑 trace --adopt 建基线。');
  if (!chain.ok) issues.push(`留痕链在第 ${chain.brokenAt} 行断了：从断点之后的记录都不作数。`);
  if (controlled.length < items.length) {
    issues.push(`${items.length - controlled.length} 条未受控：check 会列出来，status 不给引用。`);
  }
  if (knowledgeError || knowledgeShape) issues.push(`地图读不了：${knowledgeError ?? knowledgeShape}`);
  if (!knowledge) issues.push('没有知识地图：这个库现在是一堆各自成立的句子。');

  out(`诊断 ${root}`);
  out(`  条目          ${items.length} 条（在用 ${active.length} · 退役 ${items.length - active.length}）`);
  out(`  留痕          ${trace.exists ? `${trace.lines.length} 条记录 · 链${chain.ok ? '完整' : '有断点'} · 受控 ${controlled.length}/${items.length}` : '没有'}`);
  out(`  地图          ${knowledge ? `${knowledge.blocks?.length ?? 0} 个能力块` : '没有'}`);
  out(`  收件箱        ${inboxState}${hasInbox ? '（目录在）' : ''}`);
  out(`  正式区可写    ${writable === null ? '测不出来' : writable ? '是' : '否'}`);
  out(`  项目登记      ${meta?.name ? `${meta.name}（${meta.domain ?? '未分类'}）` : '没有 project.json'}`);

  if (issues.length === 0) {
    out();
    out('没有需要处理的事。');
    return 0;
  }
  out();
  out(`要处理 ${issues.length} 件：`);
  for (const s of issues) out(`  · ${s}`);
  return writable ? 1 : 0;
}

async function cmdStats(dir, asJson) {
  const base = resolve(dir);
  const isWs = await looksLikeWorkspace(base);

  const libs = [];
  if (isWs) {
    let subs;
    try {
      subs = (await readdir(base, { withFileTypes: true }))
        .filter((x) => x.isDirectory()).map((x) => x.name).sort();
    } catch {
      out(`读不到 ${base}`);
      return 2;
    }
    for (const name of subs) {
      const root = join(base, name, 'entries');
      try {
        await stat(root);
      } catch {
        continue;
      }
      libs.push(await countLib(root, name));
    }
  } else {
    if (!(await ensureDir(base, '条目目录'))) return 2;
    // 传进来的是 entries 目录时，库名取它的父目录——叫 entries 没有信息量
    const name = basename(base) === DEFAULT_ROOT ? basename(dirname(base)) : basename(base);
    libs.push(await countLib(base, name));
  }

  const code = await codeStats();
  const agg = sumLibs(libs);

  if (asJson) {
    out(JSON.stringify({ workspace: isWs ? base : null, libraries: libs, total: agg, code }, null, 2));
    return 0;
  }

  if (libs.length === 0) {
    out(`${base} 下没有找到库（一个库 = 一个含 entries/ 的子目录）`);
    return 0;
  }

  const w = (s, n) => String(s).padStart(n);
  out(`${libs.length} 个库 · ${agg.total} 条 · ${base}`);
  out();
  for (const l of libs) {
    out(`  ${l.dir.padEnd(14)} ${w(l.total, 3)} 条 · 引用 ${w(l.citable, 2)} · 判定 ${w(l.decisive, 2)}`
      + ` · 条目 ${l.basis['条目'] ?? 0} 实测 ${l.basis['实测'] ?? 0} 判断 ${l.basis['判断'] ?? 0}`);
    const tail = [`世界 ${l.world.supported ?? 0}/${l.total}`];
    if (l.retired) tail.push(`退役 ${l.retired}`);
    if (l.map) {
      const covered = `${l.map.covered}/${l.map.active}`;
      tail.push(`地图 ${l.map.blocks} 块·覆盖 ${l.map.covered === l.map.active ? covered : `⚠ ${covered}`}`);
    } else {
      tail.push('无地图');
    }
    if (l.broken) tail.push(`⚠ ${l.broken} 条读不了`);
    out(`  ${''.padEnd(14)} ${tail.join(' · ')}`);
  }

  out();
  out('合计');
  out(`  依据        ${distLine(agg.basis, ['条目', '实测', '判断'])}`);
  out(`  世界        ${distLine(agg.world, ['supported', 'unresolved', 'contradicted'])}`);
  out(`  可用        可引用 ${agg.citable} · 可判定 ${agg.decisive} · 已退役 ${agg.retired}`);
  out(`  来源        ${agg.sources.size} 个${agg.unregistered ? `（含未登记 ${agg.unregistered} 条主张）` : ''}`);
  out(`  话题        ${agg.topics.size} 个 · 未归话题 ${agg.untagged} 条`);
  const withMap = libs.filter((l) => l.map).length;
  out(`  结构        ${withMap}/${libs.length} 个库有知识地图${withMap < libs.length ? '（没有地图的库只是一堆孤立句子）' : ''}`);
  out();
  out('代码');
  out(`  规模        ${code.modules} 模块 · ${code.lines.toLocaleString('en-US')} 行`);
  out(`  命令        ${code.commands} 个`);
  if (code.onlyInCode.length || code.onlyInUsage.length) {
    if (code.onlyInCode.length) out(`  ⚠ usage 没写  ${code.onlyInCode.join('、')}`);
    if (code.onlyInUsage.length) out(`  ⚠ 代码里没有  ${code.onlyInUsage.join('、')}`);
  } else {
    out('  usage 与代码一致');
  }
  out();
  out('文档里每写一个数，都能用这条命令复核。');
  return 0;
}

function distLine(map, order) {
  const parts = order
    .map((k) => `${k} ${map[k] ?? 0}`)
    .concat(Object.keys(map).filter((k) => !order.includes(k)).map((k) => `${k} ${map[k]}`));
  return parts.join(' · ');
}

/** 数一个库。派生状态走 collectItems，和 review 用的是同一套算法。 */
async function countLib(root, dirName) {
  const registry = await readSources(root).catch(() => ({}));
  const all = await loadAllEntries(root).catch(() => []);
  const items = await collectItems(root, registry).catch(() => []);

  const basis = {};
  const world = {};
  const topics = new Set();
  for (const it of items) {
    basis[it.basis] = (basis[it.basis] ?? 0) + 1;
    const w = it.world ?? 'unresolved';
    world[w] = (world[w] ?? 0) + 1;
    if (typeof it.topic === 'string' && it.topic.trim()) topics.add(it.topic.trim());
  }

  const sources = groupBySource(all);
  // 地图覆盖率也放进 stats：文档里写「四个库」时，得看得见哪几个库有骨架。
  const st = await structureState(root, items);
  return {
    dir: dirName,
    total: all.length,
    broken: all.length - items.length,
    citable: items.filter((it) => it.citable).length,
    decisive: items.filter((it) => it.decisive).length,
    retired: items.filter((it) => it.retired).length,
    basis,
    world,
    sources: [...sources.keys()],
    // 「未登记来源」不是一份材料，是一堆没填 uri 的条目。报条数比报个数有用。
    unregistered: sources.get('（未登记来源）')?.entries.length ?? 0,
    topics: [...topics],
    untagged: items.filter((it) => !it.topic).length,
    map: st.hasMap
      ? { blocks: st.blocks, covered: st.active - st.orphans.length, active: st.active, orphans: st.orphans.length, dangling: st.dangling.length }
      : null,
  };
}

/** 把多个库加起来。来源和话题要去重——同一个 arxiv 地址出现在两个库里算一份。 */
function sumLibs(libs) {
  const agg = {
    total: 0, citable: 0, decisive: 0, retired: 0, broken: 0, unregistered: 0,
    basis: {}, world: {}, sources: new Set(), topics: new Set(), untagged: 0,
  };
  for (const l of libs) {
    agg.total += l.total;
    agg.citable += l.citable;
    agg.decisive += l.decisive;
    agg.retired += l.retired;
    agg.broken += l.broken;
    agg.unregistered += l.unregistered ?? 0;
    agg.untagged += l.untagged;
    for (const [k, v] of Object.entries(l.basis)) agg.basis[k] = (agg.basis[k] ?? 0) + v;
    for (const [k, v] of Object.entries(l.world)) agg.world[k] = (agg.world[k] ?? 0) + v;
    for (const s of l.sources) agg.sources.add(s);
    for (const t of l.topics) agg.topics.add(t);
  }
  return agg;
}

/** 列出 src 下所有 .js（含 core/ 与 views/ 子目录）。分目录之后，只扫一层会漏掉一半。 */
async function listSrcFiles(srcDir, sub = '') {
  const out = [];
  let names = [];
  try {
    names = await readdir(join(srcDir, sub), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const rel = sub ? `${sub}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await listSrcFiles(srcDir, rel)));
    else if (d.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

/** 代码规模。模块数和行数读文件就有；命令数靠源码里的分发和 usage 对账。 */
async function codeStats() {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const files = await listSrcFiles(srcDir);

  let lines = 0;
  for (const f of files) {
    try {
      const t = await readFile(join(srcDir, f), 'utf8');
      lines += t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    } catch { /* 单个文件读不到不影响总数 */ }
  }

  let text = '';
  try {
    text = await readFile(join(srcDir, 'cli.js'), 'utf8');
  } catch { /* 没有 cli.js 就没有命令 */ }

  // 只认分发处真的写了 `command === '...'` 的，和 usage 里真的列出来的。
  // 两边对不上就是漂移——要么 usage 漏了命令，要么列了一个不存在的。
  const code = new Set([...text.matchAll(/command === '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]));
  code.delete('h');
  code.delete('help');
  const usage = new Set([...text.matchAll(/^ {2}proofline ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]));

  return {
    modules: files.length,
    lines,
    commands: code.size,
    onlyInCode: [...code].filter((c) => !usage.has(c)).sort(),
    onlyInUsage: [...usage].filter((c) => !code.has(c)).sort(),
  };
}

/**
 * 留痕：看状态，或为已有条目建立基线。
 *
 * `--adopt` 这件事本身要说清楚：它是「承认历史不可考，从今天起开始记」，
 * 不是「补一份记录假装一直都有」。所以基线那条记录的 note 必须写明。
 */
async function cmdTrace(root, opts) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const all = await loadAllEntries(root);
  const trace = await readTrace(root);
  const chain = verifyChain(trace.lines);
  const last = lastByEntry(trace.lines);

  const pending = all.filter((e) => !last.has(e.id));

  if (opts.reseal) {
    const { lines, error } = await readTrace(root);
    if (error) { out(`留痕读不了：${error}`); return 1; }
    if (lines.length === 0) { out('这个库没有留痕记录，没什么可封的。'); return 0; }
    await writeHead(root, lineHash(lines[lines.length - 1]), lines.length);
    out(`已重建链头：${lines.length} 条记录。`);
    out('  这只在你确认「改动是自己做的」之后才该跑——它不修复篡改，只是重新承认现状。');
    return 0;
  }

  if (opts.adopt) {
    if (pending.length === 0) {
      out('每条都已经有记录了，不需要建立基线。');
      return 0;
    }
    if (!opts.confirm) {
      out(`会给 ${pending.length} 条建立基线（不代表它们此前合规，只代表从今天起开始记）。`);
      out('  记录里会写明「首次纳入留痕，此前历史不可考」。');
      out('加 --confirm 执行。');
      return 0;
    }
    for (const e of pending) {
      await appendTrace(root, {
        op: 'adopt',
        id: e.id,
        after: contentHash(e.text),
        note: '首次纳入留痕，此前历史不可考',
      });
    }
    out(`已为 ${pending.length} 条建立基线。此前的历史不可考——这一点写进了记录里。`);
    return 0;
  }

  if (!trace.exists) {
    out(`这个库还没有留痕（${all.length} 条主张全部未受控）。`);
    out('要开始记：proofline trace --adopt，然后 proofline trace --adopt --confirm');
    return 0;
  }

  const head = await readHead(root);
  const headChk = verifyHead(head, trace.lines);
  const rows = all.map((e) => {
    const rec = last.get(e.id);
    return { id: e.id, at: rec?.at ?? null, op: rec?.op ?? null, ...controlState(rec?.after ?? null, contentHash(e.text)) };
  });
  const bad = rows.filter((r) => !r.controlled);

  if (opts.json) {
    out(JSON.stringify({ exists: trace.exists, lines: trace.lines.length, error: trace.error, chain, head: headChk, rows }, null, 2));
    return chain.ok && headChk.ok ? 0 : 1;
  }

  out(`留痕 ${trace.lines.length} 条 · 链${chain.ok ? '完整' : `在第 ${chain.brokenAt} 行断了`}` + (headChk.kind === 'absent' ? ' · 没有链头' : headChk.ok ? ' · 链头一致' : ' · 链头对不上'));
  out(`受控 ${rows.length - bad.length}/${rows.length}${bad.length ? ` · 未受控 ${bad.length}` : ''}`);
  if (trace.error) out(`⚠ ${trace.error}`);
  if (bad.length > 0) {
    out();
    for (const r of bad) out(`  ${r.id}  ${r.why}`);
  }
  return chain.ok && headChk.ok ? 0 : 1;
}

async function cmdProjects(dir, asJson) {
  // 自动往上找一层：从项目目录里跑也能用
  let base = dir;
  if (!(await looksLikeWorkspace(base))) {
    const up = join('..', base);
    if (await looksLikeWorkspace(up)) base = up;
  }

  let subs;
  try {
    subs = (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory()).map((x) => x.name);
  } catch {
    out(`读不到 ${base}`);
    return 2;
  }

  const rows = [];
  for (const name of subs) {
    const root = join(base, name, 'entries');
    try {
      await stat(root);
    } catch {
      continue; // 不是项目目录
    }

    let meta = null;
    try {
      meta = JSON.parse(await readFile(join(base, name, 'project.json'), 'utf8'));
    } catch { /* 没有就是没有，不编 */ }

    const registry = await readSources(root).catch(() => ({}));
    const all = await loadAllEntries(root).catch(() => []);
    const controlledOf = await buildControlledMap(root);
    let pass = 0;
    let citable = 0;
    let decisive = 0;
    let hard = 0;
    for (const e of all) {
      const { shape, derived } = assessEntry(e.entry, e.id, registry, null, controlledOf);
      if (shape?.status === 'pass') pass += 1;
      if (shape?.status === 'hard_fail') hard += 1;
      if (derived?.citable) citable += 1;
      if (derived?.decisive) decisive += 1;
    }
    rows.push({
      dir: name,
      name: meta?.name ?? '（未登记）',
      domain: meta?.domain ?? '',
      purpose: meta?.purpose ?? '',
      total: all.length,
      pass,
      hard,
      citable,
      decisive,
    });
  }

  rows.sort((a, b) => b.total - a.total || a.dir.localeCompare(b.dir));

  if (asJson) {
    out(JSON.stringify({ workspace: base, projects: rows }, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    out(`${base} 下没有找到项目（一个项目 = 一个含 entries/ 的子目录）`);
    return 0;
  }

  out(`${rows.length} 个项目 · ${base}`);
  out();
  for (const r of rows) {
    const head = `${r.name}${r.domain ? `（${r.domain}）` : ''}`;
    out(`  ${head}`);
    out(`    ${r.dir.padEnd(14)} ${String(r.total).padStart(3)} 条 · 可引用 ${r.citable} · 可判定 ${r.decisive}${r.hard ? ` · ⚠ ${r.hard} 条形状废` : ''}`);
    if (r.purpose) out(`    ${r.purpose}`);
  }
  out();
  out('分类信息在各自目录的 project.json 里；插件不含任何项目数据。');
  return 0;
}

async function cmdSources(root, asJson) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const entries = await loadAllEntries(root);
  const rows = overview(entries, registry);

  if (asJson) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    out('库里还没有条目，所以没有来源。');
    return 0;
  }

  const total = entries.length;
  const retiredTotal = rows.reduce((n, r) => n + r.retired, 0);
  const blocked = rows.filter((r) => r.blocking).reduce((n, r) => n + r.count, 0);
  const tail = [
    blocked ? `其中 ${blocked} 条因来源被标已失效` : '',
    retiredTotal ? `${retiredTotal} 条已退役` : '',
  ].filter(Boolean).join('，');
  out(`${rows.length} 个来源，共 ${total} 条主张${tail ? `（${tail}）` : ''}`);
  out();
  for (const r of rows) {
    out(`[${r.status}] ${r.uri}`);
    // 退役的条目不支撑任何东西。所以分开报「有几条」和「几条在用」，
    // 只报总数会高估这个来源的分量。
    const parts = [`条目 ${r.count} 条`];
    if (r.retired > 0) parts.push(`在用 ${r.count - r.retired} 条 / 退役 ${r.retired} 条`);
    parts.push(r.extraction ?? '来源形态未填');
    if (r.reason) parts.push(r.reason);
    out(`        ${parts.join(' · ')}`);
  }
  out();
  out('弃用前先看后果：proofline deprecate <来源> --reason "为什么"');
  return 0;
}

/**
 * 弃用一份材料。
 *
 * 不带 --confirm 时只算后果，不改任何东西——这一步是给「AI 评估 + 人拍板」用的：
 * 工具负责说出会发生什么，好坏由人判断。
 */
async function cmdDeprecate(root, uri, opts) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const entries = await loadAllEntries(root);
  const rows = overview(entries, registry);
  const row = rows.find((r) => r.uri === uri);

  if (!row) {
    out(`找不到这个来源：${uri}`);
    out();
    out('现有来源：');
    for (const r of rows) out(`  ${r.uri}`);
    return 2;
  }

  const status = opts.status ?? '弃用';
  if (!['可疑', '弃用'].includes(status)) {
    out(`--status 只能是 可疑 或 弃用`);
    return 2;
  }

  const remaining = rows.filter((r) => r.uri !== uri && !r.blocking).reduce((n, r) => n + r.count, 0);

  out(`来源：${uri}`);
  out(`  现在状态     ${row.status}`);
  out(`  它支撑       ${row.count} 条主张`);
  for (const c of row.claims) out(`    · ${c.claim.slice(0, 46)}`);
  out();
  out(`改成「${status}」之后：`);
  out(`  这 ${row.count} 条  → 降级为不可引用（原因记为「来源${status}」）`);
  out(`  库里剩余可引用  → ${remaining} 条`);
  if (remaining === 0) {
    out('  ⚠ 这是最后一个可用来源，弃用后整个库将没有可引用的条目。');
  }
  out();
  out('这么做的好处：不再把这份材料当依据。');
  out('代价：上面这些主张失去证据，要么重新找来源，要么接受它们变成「只有印象」。');
  out();

  if (!opts.confirm) {
    out('没有改动任何东西。确认要这么做，加 --confirm 再跑一次。');
    return 0;
  }

  if (!opts.reason || !opts.reason.trim()) {
    out('弃用必须给理由：--reason "为什么"。没有理由的弃用，三个月后没人记得为什么。');
    return 2;
  }

  registry[uri] = {
    status,
    reason: opts.reason.trim(),
    decided_at: new Date().toISOString().slice(0, 10),
  };
  await writeSources(root, registry);
  out(`已登记：${uri} → ${status}`);
  return 0;
}

/**
 * 条目退役：不再当依据，但条目留着。
 *
 * 为什么不是 delete：删了就追不回来。而「这条曾经这么写过、后来作废了」
 * 本身就是有价值的信息——下次遇到同样的问题，能看见当时为什么错。
 *
 * 为什么不是改 claim：改 claim 是把错的抹掉，抹掉之后没人知道你错过。
 * 退役留着原话，只摘掉它的可用性。
 */
async function cmdRetire(root, id, opts) {
  if (!(await ensureDir(root, '条目目录'))) return 2;

  const entry = await readEntry(root, id);
  if (!entry) {
    out(`找不到条目：${id}`);
    return 2;
  }
  const { data, body } = parseFrontmatter(entry.text);
  const already = retiredOf(data);

  // ---- 撤销这条路 ----
  if (opts.undo) {
    if (!already) {
      out(`${id} 本来就没退役，不用撤销。`);
      return 0;
    }
    delete data.deprecated;
    const res = await commit({ root, id, text: joinFrontmatter(data, body, KEY_ORDER), expect: entry.hash, op: 'retire' });
    if (!res.ok) {
      out(`撤销失败：${res.code}`);
      return 1;
    }
    out(`已撤销退役：${id}`);
    out(`  它重新${data.layer === '标准' ? '可以' : '不一定能'}被引用——具体看 check 结果。`);
    return 0;
  }

  if (already && !already.invalid) {
    out(`${id} 已经退役了（${already.at}）：${already.reason}`);
    out();
    out('要恢复它，加 --undo。');
    return 0;
  }
  if (already && already.invalid) {
    // 残缺的退役记录不该挡住「重写一份好的」——挡住的话人只能手改文件，
    // 而手改正是产生残缺记录的原因。
    const missing = [!already.at && 'at', !already.reason && 'reason'].filter(Boolean).join(' / ');
    out(`注意：这条的退役记录是残的（缺 ${missing}）。`);
    out('      加 --confirm 会把这份记录重写成完整的。');
    out();
  }

  // ---- 算影响面 ----
  const derived = deriveStatus({
    dirName: id, text: entry.text, snapshotText: entry.snapshotText,
    boxes: entry.boxes, readSnapshot: entry.readSnapshot,
  });

  // 谁把它当前置。退役不删条目，但这些依赖会指向一个不能用的东西。
  let dependents = [];
  try {
    const all = await loadAllEntries(root);
    dependents = all
      .filter((e) => e.id !== id && Array.isArray(e.data?.prereq) && e.data.prereq.includes(id))
      .map((e) => e.id);
  } catch { /* 读不全就不报依赖，不影响主流程 */ }

  out(`条目：${id}`);
  out(`  ${derived.claim}`);
  out();
  out('现在：');
  out(`  能引用      ${derived.citable ? '是' : '否'}`);
  out(`  能下判断    ${derived.decisive ? '是' : '否'}`);
  out();
  out('退役之后：');
  out('  能引用      否');
  out('  能下判断    否');
  out('  条目本身    留在库里，check 照样能查到，引文照样能核');
  if (dependents.length) {
    out(`  依赖它的    ${dependents.length} 条 → ${dependents.join(', ')}`);
    out('              这些条目的 prereq 会指向一个不可用的东西');
  }
  out();
  out('这么做的好处：不用删掉历史，也能让它不再被当依据。');
  out('代价：库里会多一条「知道但不用」的东西，翻的时候得看状态。');
  out();

  // 本来就不可用的条目，退役它不改变任何事。
  // 这时候最该问的是「你是不是想弃用它的来源」或者「你是不是想改 claim」。
  // 不拦，但要让人知道这一刀切在了空气上。
  if (!derived.citable && !derived.decisive) {
    out('提醒：这条本来就不能引用、不能下判断。');
    out('      退役它不会改变任何可用性——如果你要的是「这条说错了」，该做的可能是改 claim；');
    out('      如果是「这份材料不可信」，该做的是 proofline deprecate <来源>。');
    out();
  }

  if (!opts.confirm) {
    out('没有改动任何东西。确认要这么做，加 --confirm 和 --reason 再跑一次。');
    return 0;
  }

  if (!opts.reason || opts.reason.trim().length < 8) {
    out('退役必须给理由：--reason "为什么"，至少 8 个字。');
    out('没有理由的退役，三个月后没人分得清「作废了」和「当时心情不好」。');
    return 2;
  }

  if (opts.by) {
    const target = await readEntry(root, opts.by);
    if (!target) {
      out(`--by 指向的条目不存在：${opts.by}`);
      return 2;
    }
    if (opts.by === id) {
      out('--by 不能指向自己。');
      return 2;
    }
  }

  data.deprecated = {
    at: opts.at ?? new Date().toISOString().slice(0, 10),
    reason: opts.reason.trim(),
    ...(opts.by ? { superseded_by: opts.by } : {}),
  };
  const res = await commit({ root, id, text: joinFrontmatter(data, body, KEY_ORDER), expect: entry.hash, op: 'retire' });
  if (!res.ok) {
    out(`写入被拒：${res.code}`);
    if (res.hardFails) for (const h of res.hardFails) out(`  ${h}`);
    return 1;
  }
  out(`已退役：${id}  版本 ${res.hash}`);
  if (dependents.length) {
    out(`注意：${dependents.length} 条依赖它，其中符合条件的会在下次 check 里被指出来。`);
  }
  return 0;
}

/** 恢复。理由不必留，因为恢复本身是撤回一次判断。 */
async function cmdRestore(root, uri) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  if (!registry[uri]) {
    out(`这个来源本来就没有被标过：${uri}`);
    return 2;
  }
  delete registry[uri];
  await writeSources(root, registry);
  out(`已恢复：${uri} → 在用（它支撑的条目重新可引用）`);
  return 0;
}

/**
 * 生成只读的证据册。
 *
 * 页面不写库、不连服务、不含 JS。展开靠 <details>。
 * 所有状态在这里算好，页面只负责显示——避免"同一事实两处算"。
 */
/**
 * 渲染一次。view 和 serve 共用同一套计算——同一事实只在它这一处算。
 *
 * @param {string} root
 * @param {boolean} served  是否由服务渲染（只影响抬头措辞）
 */
async function buildViewHtml(root, served = false) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const all = await loadAllEntries(root);
  const sources = overview(all, registry);

  const entries = [];
  // 证据册也要看留痕：未受控的条目不能给人当依据，因为它的内容没经过入库闸门。
  const viewTrace = await readTrace(root);
  const viewLast = lastByEntry(viewTrace.lines);

  for (const e of all) {
    if (e.broken) continue;
    const { shape, derived, parseError, blockingList } = assessEntry(e.entry, e.id, registry);
    if (parseError || !derived) continue;
    const blocked = shape.status === 'hard_fail';
    entries.push({
      id: e.id,
      claim: derived.claim,
      kind: derived.kind ?? '未填',
      layer: derived.layer ?? '未填',
      basis: derived.basis,
      evidence: derived.evidence_effective,
      world: derived.world_effective,
      citable: derived.citable && !blocked && controlState(viewLast.get(e.id)?.after ?? null, contentHash(e.text)).controlled,
      decisive: derived.decisive && !blocked && controlState(viewLast.get(e.id)?.after ?? null, contentHash(e.text)).controlled,
      controlled: controlState(viewLast.get(e.id)?.after ?? null, contentHash(e.text)).controlled,
      uncontrolledWhy: controlState(viewLast.get(e.id)?.after ?? null, contentHash(e.text)).why,
      blockingCount: blockingList.length,
      blockingList,
      quotes: Array.isArray(e.data.quotes) ? e.data.quotes : [],
      source: typeof e.data.source_uri === 'string'
        ? e.data.source_uri.trim()
        : (derived.basis === '判断' ? '（推断，无来源）' : '（未登记来源）'),
      prereq: Array.isArray(e.data.prereq) ? e.data.prereq : [],
      value: derived.value,
      notFor: derived.not_for,
      // 退役的要能在图上看出来。图上一条退役条目和一条正常条目
      // 长得一样的话，人会照着它去论证。
      retired: Boolean(derived.retired),
      retiredNote: derived.deprecated
        ? `${derived.deprecated.at}：${derived.deprecated.reason}`
        : '',
    });
  }

  const libRules = await entryRulesOf(root);
  const stats = {
    entries: entries.length,
    sources: sources.length,
    citable: entries.filter((x) => x.citable).length,
    decisive: entries.filter((x) => x.decisive).length,
    blocking: entries.filter((x) => x.blockingCount > 0).length,
    rules: RULES.length + libRules.rules.length,
    builtinRules: RULES.length,
    libraryRules: libRules.rules.length,
    deprecated: sources.filter((s) => s.blocking).length,
    uncontrolled: entries.filter((x) => x.controlled === false).length,
  };

  // 地图只吃 id / claim / prereq 三样，和上面的视图数据分开算，避免两套结构打架
  const forest = buildForest(
    all.map((e) => ({ id: e.id, claim: e.data?.claim ?? '', prereq: e.data?.prereq })),
  );

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const data = { entries, sources, stats, forest, served, generatedAt };
  // 同一份数据，两种模板。HTML 给人看，Markdown 给人批注。
  return { html: renderView(data), data, stats };
}

async function cmdView(root, outPath, asMd = false) {
  const built = await buildViewHtml(root, false);
  const { stats } = built;
  const text = asMd ? renderViewMd(built.data) : built.html;
  const target = outPath
    ? resolve(outPath)
    : join(root, '..', asMd ? '证据册.md' : '证据册.html');
  await writeFile(target, text, 'utf8');
  out(`已生成 ${target}`);
  out(`  ${stats.entries} 条主张 / ${stats.sources} 个来源 / ${stats.citable} 条可引用 / ${stats.decisive} 条可判定`);
  return 0;
}

/**
 * 生成「给 AI 的地图任务书」。
 *
 * 工具画不出地图——它不知道这个领域该分哪几块。但「不知道」不等于「没办法」：
 * 它知道库里有哪些句子、结构必须满足什么、写完会被哪几条规则拒。
 * 把这些说清楚，任务就能交出去，而验收标准留在工具手里。
 *
 * 这不是「AI 自动画图」，是**把判断外包、把校验留下**。
 * 和 `draft` 是同一个姿势：摊出候选与约束，不替你做决定。
 */
async function cmdMapBrief(root) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const registry = await readSources(root);
  const items = await collectItems(root, registry);
  if (items.length === 0) {
    out('这个库还没有条目。地图是给「一堆句子」搭骨架的——先有句子。');
    return 2;
  }

  let meta = null;
  try {
    meta = JSON.parse(await readFile(join(root, '..', 'project.json'), 'utf8'));
  } catch { /* 没有登记就标未登记，不编 */ }

  const active = items.filter((it) => !it.retired);
  const st = await structureState(root, items);
  const basisN = { 条目: 0, 实测: 0, 判断: 0 };
  // 只数在用的：把退役的算进去，表里 20+2+2=24，而头行写「在用 23 条」——AI 会照着 24 去挂。
  for (const it of active) if (basisN[it.basis] !== undefined) basisN[it.basis] += 1;

  const L = [];
  L.push('# 任务：给这个库写一份知识地图');
  L.push('');
  L.push('## 一、这是什么库');
  L.push('');
  L.push(`- 名称：${meta?.name ?? '（未登记）'}${meta?.domain ? `（${meta.domain}）` : ''}`);
  if (meta?.purpose) L.push(`- 用途：${meta.purpose}`);
  L.push(`- 在用的主张：${active.length} 条${items.length !== active.length ? `（另有 ${items.length - active.length} 条已退役，不要挂）` : ''}`);
  L.push(`- 依据分布：条目 ${basisN['条目']} · 实测 ${basisN['实测']} · 判断 ${basisN['判断']}`);
  const cur = await readMap(root);
  const mapBroken = cur.knowledgeError ?? cur.knowledgeShape ?? st.mapError;
  if (mapBroken) {
    // 读不了就别让人去「新建」——磁盘上那份可能还有内容，新建等于覆盖。
    L.push(`- 现状：**地图读不了**（${mapBroken}）。先修它，不要新建一份。`);
  } else if (!st.hasMap) {
    L.push('- 现状：**没有地图**。下面这些句子现在是彼此孤立的。');
  } else {
    L.push(`- 现状：已有 ${st.blocks} 个能力块，覆盖 ${st.active - st.orphans.length}/${st.active} 条`
      + `${st.orphans.length ? `，漏了 ${st.orphans.length} 条` : ''}${st.dangling.length ? `，另有 ${st.dangling.length} 条悬空引用` : ''}`);
    for (const b of cur.knowledge?.blocks ?? []) {
      L.push(`  - \`${b.id}\` ${b.name}（挂 ${Array.isArray(b.entries) ? b.entries.length : 0} 条）`);
    }

    // 「完整」不能只看覆盖率。
    //
    // 覆盖率只回答「每条主张都挂上了吗」，不回答「这张图本身对不对」：
    // needs 指向不存在的域、先修成环、技术域没有刻度——这些地图照样能覆盖 100%。
    // 只看覆盖率就说「完整，别动它」，等于拦住唯一该改的时刻。
    const report = analyze({
      knowledge: cur.knowledge,
      progress: cur.progress,
      knownIds: new Set(items.map((i) => i.id)),
    });
    const issues = [
      ...report.problems.map((p) => `硬问题：${p}`),
      ...st.shapeErrors.map((p) => `形状：${p}`),
    ];
    if (issues.length === 0 && !st.orphans.length && !st.dangling.length && !st.stale.length) {
      L.push('');
      L.push('> **这份地图目前是完整的**（覆盖率 100%，结构校验 0 问题）。');
      L.push('> 只有在你认为「块切得不对」时才重写；只是为了再画一次，别动它——重写会丢掉已有的 gap 说明。');
    } else if (issues.length > 0) {
      L.push('');
      L.push(`> **这份地图有 ${issues.length} 个硬问题**，先修这些，别重写：`);
      for (const s of issues.slice(0, 5)) L.push(`> - ${s}`);
      if (issues.length > 5) L.push(`> - 还有 ${issues.length - 5} 个，跑 \`proofline map ${root}\` 看全`);
    }
  }
  L.push('');
  L.push('## 二、要产出什么');
  L.push('');
  L.push('一个文件：`knowledge-map.json`，放在库目录下（`entries/` 的同级）。');
  L.push('顶层五个键：`version`（固定 1）、`goal`（一句话说清这个库要回答什么问题）、`note`（可选）、`blocks`、`domains`、`points`。');
  L.push('');
  L.push('```');
  L.push('blocks[]  一个能力块 = 把这件事做成，必须会的一件事');
  L.push('  id, name, needs[]（引用 domain id）, needLevels{domain: 1-4},');
  L.push('  entries[]（引用条目 id）, basis（条目/实测/判断）, gap（这块还缺什么）');
  L.push('');
  L.push('domains[] 一个知识域 = 支撑能力块的一门学问或一项技能');
  L.push('  id, name, prereq[]（先修，引用别的 domain id）, why,');
  L.push('  role（主线/背景/备选）, tier（基础/核心/应用）, kind（学科/技术/语言）');
  L.push('  非「学科」的域必须有 levels：[{n:1,text:"..."} ... 1-4 级]');
  L.push('');
  L.push('points[]  可选，更细的知识点');
  L.push('```');
  L.push('');
  L.push('## 三、材料：entries 里只能用下面这些 id');
  L.push('');
  L.push('| id | 依据 | 主张 |');
  L.push('|---|---|---|');
  for (const it of active) {
    L.push(`| \`${it.id}\` | ${it.basis} | ${String(it.claim ?? '').replace(/\|/g, '｜').slice(0, 70)} |`);
  }
  const retiredItems = items.filter((it) => it.retired);
  if (retiredItems.length > 0) {
    L.push('');
    L.push(`另有 ${retiredItems.length} 条已退役，**不要挂到任何块上**——它已经不能当依据，挂了 check 会报「还挂着退役条目」：`);
    L.push('');
    for (const it of retiredItems) {
      L.push(`- \`${it.id}\` ${String(it.claim ?? '').replace(/\|/g, '｜').slice(0, 50)}`);
    }
  }
  L.push('');
  L.push('## 四、硬约束（写完会被机器逐条检查）');
  L.push('');
  L.push('| 约束 | 违反时 |');
  L.push('|---|---|');
  L.push('| `blocks[].needs` 和 `needLevels` 只能引用已定义的 domain id | 硬错 |');
  L.push('| `domains[].prereq` 只能引用已定义的 domain，且不能成环 | 硬错 |');
  L.push('| 每个 domain 必须有 `name`；`kind` 只能是 学科 / 技术 / 语言 | 硬错 |');
  L.push('| 非「学科」的域必须有 `levels`，编号 1–4 不重复，每级都要有 `text` | 硬错 |');
  L.push('| `blocks[].basis` 只能是 条目 / 实测 / 判断 | 硬错 |');
  L.push('| `blocks[].entries` 只能引用上面表里出现过的 id | 硬错（check 会报悬空） |');
  L.push('| 每条在用主张至少挂一个能力块 | 提示（check 会列孤儿） |');
  L.push('| 技术域被能力块用到，就要在 `needLevels` 里说清要几级 | 警告 |');
  L.push('| `basis: 实测` 的能力块要给 `run`（复现脚本路径） | 警告 |');
  L.push('');
  L.push('## 五、写法上的三条');
  L.push('');
  L.push('1. **能力块回答的是「要做好这件事，必须会哪几件事」**，不是「我读到了什么」。');
  L.push('   按后者切，会切成一堆「某篇论文讲了X」，那是条目的目录，不是地图。');
  L.push('2. **每个块要么挂条目，要么在 `gap` 里写清为什么空。** 空着不写，等于假装这块不需要。');
  L.push('3. **`basis` 按实情标。** 整块都由可定位的条目撑着才写「条目」；只要有一半是你推的，就写「判断」。');
  L.push('   标错了没人能查出来——但这一栏存在的意义就是让你自己别糊过去。');
  L.push('');
  L.push('## 六、自检');
  L.push('');
  L.push('```');
  L.push(`proofline map ${root}`);
  L.push('```');
  L.push('');
  L.push('它会输出能力块数、缺口数，并逐条列出 problems。**0 个 problem 再交。**');
  L.push('如果报「有知识域没有出口」，意思是那个域没有任何能力块用到它——');
  L.push('要么给它加一个块，要么把它标成 `role: 背景`。');
  L.push('');
  L.push('## 七、输出格式');
  L.push('');
  L.push('只给 JSON 本体，不要解释，不要 ``` 包裹。写完把 `proofline map` 的输出也贴回来。');

  out(L.join('\n'));
  return 0;
}

/**
 * 课程地图：目标 → 能力块 → 课程 → 缺口。
 *
 * 和证据册的区别是颗粒度：证据册画「这条材料和那条材料谁先」，这张画「这个项目要哪几门课」。
 */
async function buildMapHtml(root, served = false) {
  const { knowledge, progress, knowledgeError, knowledgeShape } = await readMap(root);
  // 文件坏了要报「坏了」，不能和「还没写」混成一句。
  // 混着说的后果很具体：人会去新建一份，而原来那份（可能是手写了半天的）还在旁边躺着。
  if (knowledgeError || knowledgeShape) return { error: knowledgeError ?? knowledgeShape };
  if (!knowledge) return null;

  // 结构和进度分开读。progress.json 不在也照样出图——这是"结构独立"的验证。
  const all = await loadAllEntries(root);
  // 把库里的条目 id 交给 analyze：地图引用了不存在的条目，要在这一层就报「硬错」。
  // 不传的话 analyze 不知道库里有什么，只能由 check 事后提示——而 `map` 的退出码是 0，
  // 于是「0 个 problem 再交」这句承诺对 AI 来说是空的。
  const report = analyze({ knowledge, progress, knownIds: new Set(all.map((e) => e.id)) });
  const registry = await readSources(root);

  const entryStatus = new Map();
  for (const e of all) {
    if (e.broken) continue;
    const { shape, derived, parseError, blockingList } = assessEntry(e.entry, e.id, registry);
    if (parseError || !derived) continue;
    entryStatus.set(e.id, {
      claim: derived.claim,
      // 可引用要一起带进来：地图上「这块挂着 4 条」和「这 4 条都能引用」
      // 是两件事。挂在块上但引不了的条目，会让这一块看起来有支撑。
      citable: derived.citable && shape.status !== 'hard_fail',
      basis: derived.basis,
      decisive: derived.decisive && shape.status !== 'hard_fail',
      blockingCount: blockingList.length,
    });
  }

  // 地图挂了哪些条目、其中多少真能引用——只在这一处算。
  // 「这块挂着 4 条」和「这 4 条都能引用」是两件事：挂在块上但引不了的条目，
  // 会让这一块看起来有支撑。
  const mappedIds = new Set();
  for (const b of knowledge.blocks ?? []) {
    for (const id of b.entries ?? []) if (typeof id === 'string') mappedIds.add(id);
  }
  const mapped = [...mappedIds];
  const mapStats = {
    mapped: mapped.length,
    citable: mapped.filter((id) => entryStatus.get(id)?.citable).length,
    notCitable: mapped.filter((id) => entryStatus.get(id) && !entryStatus.get(id).citable),
    notCitableBasis: Object.fromEntries(mapped.filter((id) => entryStatus.get(id)).map((id) => [id, entryStatus.get(id).basis])),
  };

  return {
    html: renderCurriculum({
      report,
      entryStatus,
      served,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    }),
    report,
    mapStats,
  };
}

async function cmdMap(root, outPath, asJson = false) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const built = await buildMapHtml(root, false);
  if (built?.error) {
    out(`knowledge-map.json 有问题，没有出图：${built.error}`);
    return 1;
  }
  if (!built) {
    out(`没有找到 knowledge-map.json（应该在 ${root}/ 或 ${root}/../）`);
    return 2;
  }
  const r = built.report;

  if (asJson) {
    // 只出数据。地图的格式从这里开始是公开契约——
    // 锁死在 HTML 里的话，别人想用只能用你的渲染器。
    out(JSON.stringify({
      blocks: r.blocks,
      counts: r.counts,
      problems: r.problems,
      warnings: r.warnings,
      mapStats: built.mapStats ?? null,
      hasProgress: r.hasProgress,
    }, null, 2));
    return r.problems.length ? 1 : 0;
  }

  // 有硬问题就不落盘。
  //
  // 任务书里写着「0 个 problem 再交」——如果这时还生成一张图，
  // 人看到「已生成」就以为过了。坏图比没有图更糟：它看起来像成品。
  // 要强行出图就显式给 --out，那是「我知道它坏，但我要看」。
  if (r.problems.length && !outPath) {
    out(`地图有 ${r.problems.length} 个问题，没有写文件：`);
    for (const p of r.problems) out(`  ⚠ ${p}`);
    out('  修完再跑。确实要出图：加 --out <路径>。');
    return 1;
  }

  const target = outPath ? resolve(outPath) : join(root, '..', '课程地图.html');
  await writeFile(target, built.html, 'utf8');
  // 缺口只在一处算：页面抬头和这里必须同一个数，否则又是「同一事实两处计算」。
  const counts = r.counts;
  out(`已生成 ${target}`);
  out(`  ${r.blocks.length} 个能力块 / ${counts.subjects} 个学科 / ${counts.techs} 项技术 / ${counts.langs} 门语言`);
  out(`  缺口 ${counts.total} 处`
    + `（学科 ${counts.domainGaps} · 知识点 ${counts.pointGaps} · 技术 ${counts.techGaps}）`);
  // 地图和判定在这里接上：挂了多少条是一回事，其中多少真能引用是另一回事。
  if (built.mapStats) {
    const { mapped, citable, notCitable, notCitableBasis } = built.mapStats;
    // 「引不了」有两种：判断档是设计（推出来的不能当依据），其余是真问题。
    // 混成一句，看的人会以为判断档挂错了。
    const inferred = notCitable.filter((id) => notCitableBasis[id] === '判断');
    const others = notCitable.filter((id) => notCitableBasis[id] !== '判断');
    out(`  挂载 ${mapped} 条 · 其中可引用 ${citable} 条`
      + (inferred.length ? ` · ${inferred.length} 条是推理（判断档，本来就不能当依据）` : '')
      + (others.length ? ` · ${others.length} 条挂着但引不了` : ''));
    if (others.length > 0 && others.length <= 5) out(`    要看的：${others.join('、')}`);
  }
  if (!r.hasProgress) out('  （没有 progress.json：这是纯结构图）');
  for (const p of r.problems) out(`  ⚠ ${p}`);
  for (const w of r.warnings) out(`  · ${w}`);
  return r.problems.length ? 1 : 0;
}

/**
 * 起一个本地只读服务。
 *
 * 和 view 的差别只有一条：view 是某一刻存下来的文件，serve 是每次打开现算。
 * 不做自动刷新——正在读的时候页面跳掉，那是打断，不是帮忙。
 */
async function cmdServe(root, opts) {
  if (!(await ensureDir(root, '条目目录'))) return 2;
  const port = opts.port ? Number(opts.port) : 4321;

  const server = await startServer({
    root,
    port,
    render: async ({ root: r }, route = '/') => {
      if (route === '/map') {
        const m = await buildMapHtml(r, true);
        return m ? m.html : '<!DOCTYPE html><meta charset="utf-8"><p>没有 knowledge-map.json，画不出课程地图。</p>';
      }
      return (await buildViewHtml(r, true)).html;
    },
  });

  out(`已启动：${server.url}`);
  out(`  证据册   ${server.url}`);
  out(`  课程地图 ${server.url}map`);
  out('  刷新浏览器就是当下的库。按 Ctrl+C 停。');

  if (opts.open) {
    const ok = openBrowser(server.url);
    if (!ok) out('（没能自动打开浏览器，把上面那个地址粘到浏览器里）');
  }

  // 挂住进程，直到被中断
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
  out('已停止。');
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    usage();
    return command ? 0 : 2;
  }

  if (command === 'fields') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { audit: { type: 'boolean', default: false } },
    });
    if (values.audit) return cmdFieldsAudit(positionals[0] ?? DEFAULT_ROOT);
    for (const [name, doc] of FIELD_DOC) out(`${name.padEnd(22)} ${doc}`);
    return 0;
  }

  if (command === 'check') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { fix: { type: 'boolean', default: false } },
    });
    return cmdCheck(positionals[0] ?? DEFAULT_ROOT, values.fix);
  }

  if (command === 'index') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    return cmdIndex(positionals[0] ?? DEFAULT_ROOT);
  }

  if (command === 'status') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    if (!positionals[0]) { usage(); return 2; }
    return cmdStatus(positionals[1] ?? DEFAULT_ROOT, positionals[0]);
  }

  if (command === 'new') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { spec: { type: 'string' } },
    });
    if (!positionals[0] || !values.spec) { usage(); return 2; }
    return cmdNew(positionals[1] ?? DEFAULT_ROOT, positionals[0], values.spec);
  }

  if (command === 'import') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        paper: { type: 'string' },
        claim: { type: 'string' },
        quote: { type: 'string' },
        kind: { type: 'string' },
        layer: { type: 'string' },
        basis: { type: 'string' },
        evidence: { type: 'string' },
        world: { type: 'string' },
        body: { type: 'string' },
        code: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
      },
    });
    if (!positionals[0] || !values.claim || !values.quote) { usage(); return 2; }
    if (!values.paper && !values.code) {
      out('要么给 --paper（论文目录），要么给 --code（代码目录）。');
      return 2;
    }
    if (values.paper && values.code) {
      out('--paper 和 --code 只能给一个。');
      return 2;
    }
    return cmdImport(positionals[1] ?? DEFAULT_ROOT, positionals[0], values.paper ?? null, values);
  }

  if (command === 'corroborate') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        source: { type: 'string' },
        uri: { type: 'string' },
        quote: { type: 'string' },
      },
    });
    if (!positionals[0] || !values.source || !values.uri || !values.quote) {
      usage();
      return 2;
    }
    return cmdCorroborate(positionals[1] ?? DEFAULT_ROOT, positionals[0], values);
  }

  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        script: { type: 'string' },
        cmd: { type: 'string' },
        output: { type: 'string' },
        expect: { type: 'string', multiple: true },
        input: { type: 'string', multiple: true },
        env: { type: 'string' },
        at: { type: 'string' },
      },
    });
    if (!positionals[0] || !values.script || !values.output || !values.expect?.length) {
      out('用法：proofline run <id> --script <脚本> --output <输出文件> --expect 键=值 [--expect 键=值 ...] [--cmd "..."] [--env "..."] [--at YYYY-MM-DD] [目录]');
      return 2;
    }
    const expect = {};
    for (const pair of values.expect) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        out(`--expect 要写成 键=值：${JSON.stringify(pair)}`);
        return 2;
      }
      expect[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    }
    return cmdRun(positionals[1] ?? DEFAULT_ROOT, positionals[0], { ...values, expect });
  }

  if (command === 'guard') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        action: { type: 'string', default: 'write' },
        target: { type: 'string' },
        content: { type: 'string' },
        root: { type: 'string', default: DEFAULT_ROOT },
        workspace: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    if (!values.target) {
      out('用法：proofline guard --target <路径> [--action write|delete|publish] [--content <文件>] [--root entries] [--json]');
      return 2;
    }
    return cmdGuard(values);
  }

  if (command === 'draft') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    if (!positionals[0]) { usage(); return 2; }
    return cmdDraft(positionals[1] ?? DEFAULT_ROOT, positionals[0], values.json);
  }

  if (command === 'set') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { patch: { type: 'string' } },
    });
    if (values.patch) {
      // --patch 模式：只给 id，字段全在 JSON 里
      if (!positionals[0]) { usage(); return 2; }
      return cmdSet(positionals[1] ?? DEFAULT_ROOT, positionals[0], null, null, values.patch);
    }
    if (positionals.length < 3) { usage(); return 2; }
    return cmdSet(positionals[3] ?? DEFAULT_ROOT, positionals[0], positionals[1], positionals[2]);
  }

  if (command === 'audit') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        strict: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
      },
    });
    return cmdAudit(positionals[0] ?? DEFAULT_ROOT, values);
  }

  if (command === 'review') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { json: { type: 'boolean', default: false }, topic: { type: 'string' } },
    });
    // 话题用 --topic：位置参数留给目录，跟其它命令一致。
    // 早先写成「位置参数依次是话题和目录」，结果 `review <目录>` 被当成话题。
    return cmdReview(positionals[0] ?? DEFAULT_ROOT, values.topic ?? null, values.json);
  }

  if (command === 'projects') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    return cmdProjects(positionals[0] ?? 'workspace', values.json);
  }

  if (command === 'inbox') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    // 第一个位置参数是 on/off 才算动作，否则当成目录——
    // 不然 `inbox <目录>` 会被误解成「动作叫这个路径」。
    const first = positionals[0];
    const isAction = first === 'on' || first === 'off';
    return cmdInbox(isAction ? (positionals[1] ?? DEFAULT_ROOT) : (first ?? DEFAULT_ROOT), isAction ? first : undefined);
  }

  if (command === 'ingest') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { into: { type: 'string' }, confirm: { type: 'boolean', default: false } },
    });
    if (!positionals[0]) { out('用法：proofline ingest <收件箱目录> [--into <entries 目录>] [--confirm]'); return 2; }
    return cmdIngest(positionals[0], values.into ?? DEFAULT_ROOT, values);
  }

  if (command === 'doctor') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    return cmdDoctor(positionals[0] ?? DEFAULT_ROOT);
  }

  if (command === 'trace') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { adopt: { type: 'boolean', default: false }, reseal: { type: 'boolean', default: false }, confirm: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    });
    return cmdTrace(positionals[0] ?? DEFAULT_ROOT, values);
  }

  if (command === 'stats') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    return cmdStats(positionals[0] ?? 'workspace', values.json);
  }

  if (command === 'sources') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    return cmdSources(positionals[0] ?? DEFAULT_ROOT, values.json);
  }

  if (command === 'deprecate') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        reason: { type: 'string' },
        status: { type: 'string' },
        confirm: { type: 'boolean', default: false },
      },
    });
    if (!positionals[0]) { usage(); return 2; }
    return cmdDeprecate(positionals[1] ?? DEFAULT_ROOT, positionals[0], values);
  }

  if (command === 'retire') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        reason: { type: 'string' },
        by: { type: 'string' },
        at: { type: 'string' },
        undo: { type: 'boolean', default: false },
        confirm: { type: 'boolean', default: false },
      },
    });
    if (!positionals[0]) { usage(); return 2; }
    return cmdRetire(positionals[1] ?? DEFAULT_ROOT, positionals[0], values);
  }

  if (command === 'restore') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    if (!positionals[0]) { usage(); return 2; }
    return cmdRestore(positionals[1] ?? DEFAULT_ROOT, positionals[0]);
  }

  if (command === 'view') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { out: { type: 'string' }, md: { type: 'boolean', default: false } },
    });
    return cmdView(positionals[0] ?? DEFAULT_ROOT, values.out, values.md);
  }

  if (command === 'map') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: { out: { type: 'string' }, brief: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    });
    if (values.brief) return cmdMapBrief(positionals[0] ?? DEFAULT_ROOT);
    return cmdMap(positionals[0] ?? DEFAULT_ROOT, values.out, values.json);
  }

  if (command === 'serve' || command === 'open') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        port: { type: 'string' },
        open: { type: 'boolean', default: command === 'open' },
      },
    });
    return cmdServe(positionals[0] ?? DEFAULT_ROOT, values);
  }

  if (command === 'rules') {
    out(`内置规则 ${RULES.length} 条：`);
    for (const r of RULES) {
      out(`  ${r.id.padEnd(26)} ${r.level}${r.reversible === false ? ' · 不可逆' : ''}`);
      out(`    ${r.action}`);
    }

    const fromLib = await entryRulesOf(DEFAULT_ROOT);
    for (const b of fromLib.broken) out(`注意：${b.entry} 的检查 #${b.index} 用不了——${b.reason}`);
    out();
    out(`库里长出来的规则 ${fromLib.rules.length} 条：`);
    if (fromLib.rules.length === 0) {
      out('  （没有。条目里写 checks 字段，这里就会多出一条）');
    }
    for (const r of fromLib.rules) {
      out(`  ${r.id}`);
      out(`    ${r.claim ?? ''}`);
      out(`    ${r.level}${r.reversible === false ? ' · 不可逆' : ''} → ${r.action}`);
    }
    return 0;
  }

  if (command === 'scan') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        advise: { type: 'boolean', default: false },
        commit: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        now: { type: 'string' },
        'no-library': { type: 'boolean', default: false },
      },
    });
    if (!positionals[0] || !values.project) { usage(); return 2; }
    // --commit 隐含 --advise：不带判定就没有可记的东西，
    // 静默不做等于让他以为记下了。
    if (values.commit) values.advise = true;
    return cmdScan(positionals[1] ?? DEFAULT_ROOT, positionals[0], values);
  }

  if (command === 'advise') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        candidates: { type: 'string' },
        commit: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        now: { type: 'string' },
      },
    });
    if (!values.project || !values.candidates) { usage(); return 2; }
    return cmdAdvise(positionals[0] ?? DEFAULT_ROOT, values);
  }

  if (command === 'log') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    if (!positionals[0]) { usage(); return 2; }
    return cmdLog(positionals[1] ?? DEFAULT_ROOT, positionals[0], values.json);
  }

  out(`未知命令：${command}`);
  usage();
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  // 用法错误（未知参数、缺参数值）按约定退出 2，别让 CI 把它当成「数据有问题」
  if (err && typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) {
    process.stderr.write(`用法错误：${err.message}\n`);
    usage();
    process.exit(2);
  }
  // 3 = 内部错误。1 只留给「检查过、确实有数据问题」，
  // 否则 CI 会把崩溃当成数据毛病，重试和告警全部指错方向。
  process.stderr.write(`内部错误：${err.stack || err.message}\n`);
  process.exit(3);
});
