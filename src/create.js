/**
 * 建条目：把「原文 + 引文 + 判定」钉成一条。
 *
 * 从 CLI 里抽出来，因为有两个入口要共用：
 *   new     手填 spec
 *   import  从别的工具（目前是 Agentero）接过来
 *
 * 两个入口走同一条校验，所以「接过来的」和「手填的」不会有两套标准。
 */

import { readFile, mkdir, stat, rm, readdir } from 'node:fs/promises';

import { ENTRY_FILE, resolveInside, withinReal } from './core/store.js';
import { join, resolve } from 'node:path';

import { joinFrontmatter } from './core/frontmatter.js';
import { KEY_ORDER } from './core/schema.js';
import { validateEntry } from './core/validate.js';
import { commit, loadSnapshotMap } from './core/store.js';
import { writeSnapshot, SNAPSHOT_REL } from './core/snapshot.js';

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.id
 * @param {object} args.spec
 * @param {string} [args.spec.snapshot_from]  快照来源文件
 * @param {string} [args.spec.snapshot_text]  直接给快照内容（import 用）
 * @returns {Promise<{ok:boolean, code?:string, hash?:string, warnings?:string[], hardFails?:string[], autofixes?:string[]}>}
 */
/**
 * createEntry 认识哪些 spec 字段。
 *
 * 这张表漏一个字段，那个字段就会被静默丢掉——只留一条 warning，
 * 而 warning 很容易没人看。历史上漏过三次：basis、topic/checks/runs、deprecated。
 * 每次都补了字段，没补的是「怎么防止下次再漏」。
 *
 * 现在由测试盯着：KEY_ORDER 里除 create 自己算的那几个之外，
 * 每个字段都必须在这张表里。加字段忘了接，测试直接挂。
 */
export const CREATE_HANDLED = new Set([
  'snapshot_from', 'snapshot_text', 'source_sha256', 'body',
  'claim', 'kind', 'layer', 'basis', 'topic', 'source_kind', 'source_uri',
  'source_published_at', 'source_available_basis', 'source_extraction',
  'source_original', 'evidence_status', 'world_status',
  'value', 'not_for', 'quotes', 'checks', 'corroborations', 'runs', 'prereq', 'derived_from', 'gaps',
  'deprecated', 'added_at',
]);

/** create 自己算出来的字段，spec 给了也不该生效。 */
export const CREATE_SELF_COMPUTED = new Set(['schema', 'id', 'source_snapshot', 'source_sha256']);

export async function createEntry({ root, id, spec }) {
  // 先把 id 钉死在 root 内。
  //
  // 这一步以前没有，代价是实测撞出来的：`id: '../important'` 会让
  // dir = join(root, id) 落到 entries 的同级目录，然后在**失败清场**时
  // `rm(dir, {recursive:true})` 把那个目录连同里面的文件一起删掉。
  // 一个手滑的 id 就能删掉条目库外面的东西，而且删完还看不出来。
  //
  // resolveInside 做的是解析后比较，不是字符串检查——盘符、`..`、
  // 网络路径都在这里被挡住。宁可建不成，不可删错。
  const dir = resolveInside(root, id);
  if (!dir) {
    return { ok: false, code: 'bad_id', detail: `id 必须落在条目库内：${JSON.stringify(id)}` };
  }

  // 符号链接：路径看着在库内，真实位置可能在库外。mkdir 不会报错（它已存在），
  // 然后 raw/source.txt 就写进别人的目录了。resolveInside 只看字符串，挡不住这个。
  if (!(await withinReal(root, dir))) {
    return { ok: false, code: 'escapes_root', detail: `id 解析到条目库外的真实路径：${JSON.stringify(id)}` };
  }

  // 先看「条目」原本在不在——不是看目录。
  // 空目录（上次失败的残留、手工建的空壳）不该被当成有条目：
  // 那会让失败清场跳过它，留下一个 check 永远报错的空壳。
  let existed = true;
  try {
    await stat(join(dir, ENTRY_FILE));
  } catch {
    existed = false;
  }

  // 目录存在、没有 entry.md、但里面有别的东西——这不是「空壳」，是别人的目录。
  // 以前这里会照样 mkdir 然后失败时 `rm -rf` 整个目录，把里面的文件一起删掉。
  // 宁可建不成，不可删错。
  if (!existed) {
    const leftovers = await readdir(dir).catch(() => []);
    if (leftovers.length > 0) {
      return {
        ok: false,
        code: 'dir_not_empty',
        detail: `目录 ${dir} 已存在且有 ${leftovers.length} 个文件，但没有 entry.md。不在这里建，也不删它。`,
      };
    }
  }

  // 已有条目就直接拒绝，一格都不写。
  // 否则下面的 writeSnapshot 会先把人家的 raw/source.txt 覆盖掉，
  // 然后 commit 才因为 expect 为空而拒绝——entry.md 没变、快照已换，
  // 原证据的哈希对不上，且没有备份。
  if (existed) {
    return { ok: false, code: 'exists', dir };
  }

  await mkdir(dir, { recursive: true });

  // 清场清的是「条目库里的空壳」——上次失败的残留，不删会让 check 永远报错。
  // 安全性不靠这里的判断，靠上面的 resolveInside：dir 一定在 root 内，
  // 所以删到的最多是条目库自己的一块空地，不会是别人的目录。
  //
  // 早先想过再收紧成「只删本次 mkdir 出来的」，实测发现那是过头的：
  // 空壳正是「上次建的、这次不是我建的」，收紧之后它们会永久留下。
  const cleanup = async () => {
    if (!existed) await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const fail = async (payload) => {
    await cleanup();
    return payload;
  };

  const warnings = [];

  let snapshotText = null;
  let sourceSha = spec.source_sha256 ?? null;

  if (spec.snapshot_from) {
    try {
      snapshotText = await readFile(resolve(spec.snapshot_from), 'utf8');
    } catch (err) {
      // 读不到快照源文件是「输入有问题」，不是未处理异常。
      // 抛出去会绕过清场，留下一个空目录。
      return fail({ ok: false, code: 'snapshot_unreadable', message: err.message, warnings });
    }
    sourceSha = (await writeSnapshot(dir, snapshotText)).hash;
  } else if (typeof spec.snapshot_text === 'string') {
    snapshotText = spec.snapshot_text;
    sourceSha = (await writeSnapshot(dir, snapshotText)).hash;
  }

  // 判断档没有原文，这是它的定义。要求它必须有快照，等于把这条路堵死——
  // 实测时撞到的：手写 entry.md 能过校验，用 new 建却被 no_source 拦住。
  // 两个入口对同一件事给出不同答案，而人只会走能走通的那条。
  if (!sourceSha && spec.basis !== '判断') return fail({ ok: false, code: 'no_source' });
  if (!sourceSha && spec.basis === '判断') {
    warnings.push('判断档：没有原文快照，evidence_status 必须是 not_checked，且必须给 gaps');
  }

  const data = {
    schema: 1,
    id,
    claim: spec.claim,
    kind: spec.kind,
    layer: spec.layer,
    basis: spec.basis,
    topic: spec.topic,
    source_kind: spec.source_kind,
    source_uri: spec.source_uri,
    source_published_at: spec.source_published_at,
    source_available_basis: spec.source_available_basis,
    source_extraction: spec.source_extraction,
    source_original: spec.source_original,
    source_snapshot: sourceSha ? SNAPSHOT_REL : undefined,
    source_sha256: sourceSha,
    evidence_status: spec.evidence_status ?? 'unresolved',
    world_status: spec.world_status ?? 'unresolved',
    value: spec.value,
    not_for: spec.not_for,
    quotes: spec.quotes ?? [],
    checks: spec.checks,
    corroborations: spec.corroborations,
    runs: spec.runs,
    prereq: spec.prereq ?? [],
    derived_from: spec.derived_from,
    deprecated: spec.deprecated,
    gaps: spec.gaps ?? [],
    added_at: spec.added_at ?? new Date().toISOString().slice(0, 10),
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key];
  }

  // spec 里带了、但这里根本没接的字段，要报出来。
  // 静默丢弃等于「他以为给了，实际没给」——比报错难查得多。
  // 这张表要跟着 schema 的 KEY_ORDER 走，否则每加一个字段就漏一次。
  const HANDLED = CREATE_HANDLED;
  const ignored = Object.keys(spec).filter((k) => !HANDLED.has(k));
  if (ignored.length > 0) {
    warnings.push(`spec 里这些字段没有被使用：${ignored.join(', ')}`);
  }

  if (spec.basis === undefined) {
    warnings.push('没给 basis，这条会被拒绝入库——依据三档必填（条目 / 实测 / 判断）');
  }
  if (spec.evidence_status === undefined) {
    warnings.push('没给 evidence_status，按 unresolved 入库（判定不许猜，只能由你写）');
  }
  if (spec.world_status === undefined) {
    warnings.push('没给 world_status，按 unresolved 入库');
  }

  const text = joinFrontmatter(data, spec.body ?? '', KEY_ORDER);
  // new / import 一般不带佐证，但带上了就要一起核
  let readSnapshot = null;
  if (Array.isArray(data.corroborations) && data.corroborations.length > 0) {
    const map = await loadSnapshotMap(dir, text);
    readSnapshot = (rel) => (map.has(rel) ? map.get(rel) : null);
  }
  const result = validateEntry({ dirName: id, text, snapshotText, readSnapshot, fix: false });

  if (result.status === 'hard_fail') {
    return fail({ ok: false, code: 'hard_fail', hardFails: result.hardFails, warnings });
  }
  if (result.status === 'dirty') {
    return fail({ ok: false, code: 'dirty', autofixes: result.autofixes, warnings });
  }

  const written = await commit({ root, id, text, expect: null, allowCreate: true, op: 'create' });
  if (!written.ok) {
    // commit 会再校验一次，这次拿得到全部快照，所以 runs 的输出也可能在这里才被核。
    // 拒绝理由必须原样带出去——上一版只带了 code，cli 里 `for (const h of result.hardFails)`
    // 直接 TypeError，用户看到的是崩溃而不是「哪一条对不上」。
    return fail({
      ok: false,
      code: written.code,
      hardFails: written.hardFails,
      autofixes: written.autofixes,
      warnings,
      currentHash: written.currentHash,
    });
  }
  // 留痕失败不能静默：entry.md 已经落盘，但没有记录，之后会被判未受控。
  // 用户必须知道这一条「写进去了，但不算数」。
  if (written.traceError) {
    warnings.push(`留痕失败（${written.traceError}）：条目已写入，但没有入库记录，之后会被判未受控`);
  }
  return { ok: true, hash: written.hash, warnings, traceError: written.traceError ?? null };
}
