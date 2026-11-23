/**
 * 条目读写与写入保护。
 *
 * 写入只有一条路：先报「我基于哪个版本」，版本对不上就一个字都不写。
 * 这不是并发锁——单人单机没什么并发。它治的是更常见的问题：
 * 提案放了一会儿才被应用，中间文件被别人（或别的 agent）改过了。
 *
 * 加锁解决「同时写」，base_hash 解决「拿旧版本覆盖新内容」。
 */

import { readdir, readFile, writeFile, rename, mkdir, unlink, realpath, stat } from 'node:fs/promises';
import { parseFrontmatter } from './frontmatter.js';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { appendTrace, readTrace, readHead, verifyChain, verifyHead, checkTraceWritable } from './trace.js';
import { sha256 } from './snapshot.js';
import { validateEntry } from './validate.js';

export const ENTRY_FILE = 'entry.md';

/**
 * 把相对路径解析成绝对路径，并确认它**仍在 base 目录内**。
 *
 * 这是路径安全的真正保证。字符串检查（不含 `..`、不以 `/` 开头）挡得住手写，
 * 挡不住 盘符路径、网络共享路径、符号链接这些花样；
 * 只有解析之后再比一次相对路径，才知道有没有跑出去。
 *
 * @returns {string|null} 越界返回 null
 */
export function resolveInside(base, rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  const target = resolve(base, rel);
  const r = relative(base, target);
  // r 为空 = 指向 base 本身；以 .. 开头或变成绝对路径 = 跑出去了
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;
  return target;
}

/**
 * 真实路径是否仍在 base 内。
 *
 * resolveInside 只比字符串：如果 `entries/evil` 是指向库外的符号链接，
 * 它算出来是 `entries/evil/...`，字符串上在库里，实际读到的是库外。
 * 这一层补一次 realpath 比对——目标不存在时逐级退到最近的已存在祖先。
 *
 * 两道都要：字符串那道给出清楚的报错，这道堵住符号链接。
 * 单靠前一道，一个 symlink 就能把整个边界绕过去。
 */
/**
 * 一个路径的「真实形态」——即使它还不存在。
 *
 * `realpath` 遇到不存在的路径直接抛，而 `withinReal` 拿它当基准时，
 * 「新建一个库」就意味着 `entries/` 还不存在 → 基准拿不到 → 判越界。
 * 以前的表现很具体：`import --code` 到一个全新目录报 `escapes_root`，
 * 而真正该做的事是 mkdir。新库第一次导入**必然失败**，不管输入多正确。
 *
 * 做法：往上找到最近一个存在的祖先，把它的 realpath 拿到，
 * 再把还没创建的那几段按原名接回去。这样符号链接照样会被解析出来。
 */
async function realFormOf(p) {
  const abs = resolve(p);
  const missing = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return missing.length ? join(real, ...missing.slice().reverse()) : real;
    } catch {
      const up = dirname(cur);
      if (up === cur) return null;   // 到根了还是没有 → 这路径本身有问题
      missing.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * 目标在不在基准目录内——符号链接也算在内。
 *
 * 两道都要：字符串那道给出清楚的报错，这道堵住符号链接。
 * 单靠前一道，一个 symlink 就能把整个边界绕过去。
 */
export async function withinReal(base, target) {
  const absBase = resolve(base);
  const absTarget = resolve(target);

  // 先在字符串上判一次：既便宜，又对「还不存在」的两边都有效。
  const relStr = relative(absBase, absTarget);
  if (relStr !== '' && (relStr.startsWith('..') || isAbsolute(relStr))) return false;

  // 再对真实形态比一次。两边都用 realFormOf，才不会出现
  // 「基准不存在 → 直接判越界」那种把新建当成越界的情况。
  const realBase = await realFormOf(absBase);
  const realTarget = await realFormOf(absTarget);
  if (!realBase || !realTarget) return false;
  const r = relative(realBase, realTarget);
  return r === '' || !(r.startsWith('..') || isAbsolute(r));
}

/**
 * 把条目里引用到的其他快照读进内存，给同步的校验/派生用。
 * 两类字段会引用外部文件：corroborations.snapshot 与 runs.output，
 * 两者都在条目目录内，走同一套解析后边界检查。
 */
export async function loadSnapshotMap(dir, text) {
  const map = new Map();
  let data = {};
  try {
    data = parseFrontmatter(text).data;
  } catch {
    return map;
  }
  const rels = new Set();
  if (Array.isArray(data.corroborations)) {
    for (const c of data.corroborations) {
      if (c && typeof c.snapshot === 'string') rels.add(c.snapshot);
    }
  }
  if (Array.isArray(data.runs)) {
    for (const r of data.runs) {
      if (r && typeof r.output === 'string') rels.add(r.output);
    }
  }
  for (const rel of rels) {
    // 只按解析后的绝对路径判断，不在字符串上猜。越界的直接不进 map，
    // 下游 readSnapshot 会返回 null，校验就会报「找不到 / 无法核验」。
    const abs = resolveInside(dir, rel);
    if (!abs) continue;
    // 字符串上在库里、实际指向库外（符号链接）——当作读不到
    if (!(await withinReal(dir, abs))) continue;
    try {
      map.set(rel, await readFile(abs, 'utf8'));
    } catch (err) {
      // 不存在、是个目录、没权限——对调用方都是「读不到」。
      // 以前只吞 ENOENT，路径指到目录上时 status 会直接抛 EISDIR 崩掉。
      // 崩掉比报「这条核不过」更糟：整库看不了。
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'EACCES') throw err;
    }
  }
  return map;
}

/**
 * 读 runs 引用的脚本与上游产物。
 *
 * 与快照不同：这些属于**项目**，不属于某条条目（同一份 verify_fold.py
 * 会被好几条实测共用），所以路径相对 workspace 根而不是条目目录。
 *
 * 读成 Buffer 而不是字符串：上游产物可能是二进制（.keras 模型、.npy）。
 * 按 utf8 读会把非法字节换成替换字符，哈希虽然稳定，但和 `sha256sum`
 * 算出来的不是一个值——那就不是「可核」，只是「它自己说了算」。
 *
 * 只读不执行。工具的职责是冻结「跑的是哪一版、吃的是什么」，不是替人重跑——
 * 重跑要环境、要数据、可能有副作用，一旦工具自己跑起来，
 * 「可复现」就变成了「工具说它可复现」。
 */
export async function loadRunScriptMap(workspaceRoot, text) {
  const map = new Map();
  let data = {};
  try {
    data = parseFrontmatter(text).data;
  } catch {
    return map;
  }
  const rels = new Set();
  if (Array.isArray(data.runs)) {
    for (const r of data.runs) {
      if (!r) continue;
      if (typeof r.script === 'string') rels.add(r.script);
      if (Array.isArray(r.inputs)) {
        for (const inp of r.inputs) {
          if (inp && typeof inp.path === 'string') rels.add(inp.path);
        }
      }
    }
  }
  for (const rel of rels) {
    const abs = resolveInside(workspaceRoot, rel);
    if (!abs) continue;
    if (!(await withinReal(workspaceRoot, abs))) continue;
    try {
      map.set(rel, await readFile(abs));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'EACCES') throw err;
    }
  }
  return map;
}

/** 短哈希，给人看的版本号。碰撞概率在这个量级可以忽略。 */
export function contentHash(text) {
  return sha256(text).slice(0, 16);
}

export async function listEntryDirs(root) {
  let names;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

export async function readEntry(root, id) {
  // id 来自命令行参数时是不可信的。没有这一步，`status ../something`
  // 会读到条目库外面的文件——读到的内容还会被当成一条条目来渲染。
  const dir = resolveInside(root, id);
  if (!dir) return null;
  // 同样是符号链接：路径看着在库内，真实位置可能在库外
  if (!(await withinReal(root, dir))) return null;
  // 目录层查过 withinReal，文件层也要查：
  // `raw` 是个指向库外的 junction 时，目录检查通过，而 source.txt 读到的是库外文件。
  // 反过来 entry.md 本身也可能是符号链接。
  const entryPath = join(dir, ENTRY_FILE);
  const snapPath = join(dir, 'raw', 'source.txt');
  if (!(await withinReal(dir, entryPath))) return null;
  if (!(await withinReal(dir, snapPath))) return null;

  let text;
  try {
    text = await readFile(entryPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // 是个目录、没权限——都算「读不到这条」，不能让整条命令崩。
    // loadSnapshotMap 早就这么处理了，主路径以前没有，一条坏条目能让 check 全崩。
    if (err.code === 'EISDIR' || err.code === 'EACCES' || err.code === 'EPERM') return null;
    throw err;
  }
  let snapshotText = null;
  try {
    snapshotText = await readFile(snapPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
  }

  // 可选增强：tools/locate.py 生成的页码与边界框。没有就是没有，不当错误。
  let boxes = null;
  try {
    boxes = JSON.parse(await readFile(join(dir, 'raw', 'boxes.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }

  const snapshots = await loadSnapshotMap(dir, text);
  const readSnapshot = (rel) => (snapshots.has(rel) ? snapshots.get(rel) : null);

  // 实测脚本相对 workspace 根（= entries 的上一级）。同一条目可能引用
  // 项目里共用的一份脚本，所以不能按条目目录去解析。
  const workspaceRoot = resolve(root, '..');
  const scripts = await loadRunScriptMap(workspaceRoot, text);
  const readRunScript = (rel) => (scripts.has(rel) ? scripts.get(rel) : null);

  return { id, dir, workspaceRoot, text, snapshotText, boxes, snapshots, scripts, readSnapshot, readRunScript, hash: contentHash(text) };
}

/**
 * 原子写：先写临时文件再改名。中途崩了不会留下半截 entry.md。
 */
async function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** 原子写 entry.md。给需要绕过 commit 的场景用（比如 check --fix）。 */
export async function writeEntryText(dir, text) {
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, ENTRY_FILE), text);
}


/**
 * 条目库级的写锁。
 *
 * commit 的「读当前版本 → 比对 expect → 写」不是原子的：两个进程同时进来，
 * 都会读到同一个旧版本、都比对通过、然后各自写入——后写的覆盖先写的，而且
 * 两次都报成功。实测 12 轮里 7 轮两个都成功。
 *
 * 锁用 O_EXCL 创建（writeFile 带 flag:'wx'），这是文件系统层面的原子操作。
 * 超时 8 秒，僵尸锁 30 秒后视为失效（进程崩了没删）。
 */
const LOCK_FILE = '.lock';

async function acquireLock(root, timeoutMs = 8000) {
  const lock = join(root, LOCK_FILE);
  const start = Date.now();
  for (;;) {
    try {
      await writeFile(lock, `${process.pid} ${Date.now()}`, { flag: 'wx' });
      return async () => { await unlink(lock).catch(() => {}); };
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 30000) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
    }
  }
}

/**
 * 这条内容是不是和留痕里记的上次入库状态一致。
 *
 * 单独抽出来是因为它不只服务 commit：`check --fix` 不走 commit
 * （它只做机械修复，不走整轮校验），于是那条路上一个「手改 + 恰好有个
 * 格式小毛病」的条目会被 fix 原样写回并盖上一个 fix 章——手改内容变成了
 * 受控基线，而 trace 里看不出它和一次正常修复有什么区别。
 *
 * 所有写入路径都要问同一个问题：**你这次写，是接着上次记录来的吗**。
 *
 * @returns {Promise<{ok:boolean, code?:string, hint?:string}>}
 */
export async function checkUntrackedChange(root, id, currentText) {
  const trace = await readTrace(root).catch(() => ({ lines: [], error: null }));
  const lines = trace.lines ?? [];

  // 留痕本身不可信的时候，任何基于它的判断都不作数。
  //
  // 以前这里只比「这一条的 after」，于是四种篡改都能过：
  //   改中间某行的字段      → 这一条的 after 没变，照过（可链早断了）
  //   改最后一行的 after    → 改成手改内容的哈希，直接对上
  //   调低 head.count 再删行 → 只拦 count > lines.length，相等就放行
  //   删掉某条记录          → 「没有记录」被当成「新条目」
  //
  // 四种的共同点：**留痕已经不可信，而判断还在拿它当依据**。
  // 所以先验留痕本身，再谈这一条。
  if (trace.error) {
    return {
      ok: false,
      code: 'trace_unreadable',
      hint: `留痕读不了：${trace.error}。读不出来就判断不了这条有没有被改过，所以不写。`
        + '先 git checkout -- <entries>/.trace.jsonl 恢复，或者 trace --reseal 承认现状。',
    };
  }

  const chain = verifyChain(lines);
  if (!chain.ok) {
    return {
      ok: false,
      code: 'trace_broken',
      hint: `留痕链在第 ${chain.brokenAt} 行断了（${chain.reason}）——断点往后都不能当依据。`
        + '先看 git diff 确认是谁改的，再 git checkout -- <entries>/.trace.jsonl 恢复。',
    };
  }

  const head = await readHead(root).catch(() => null);
  const headChk = verifyHead(head, lines);
  if (!headChk.ok && headChk.kind !== 'absent') {
    // 三种情况要分开说，因为「怎么办」不一样：
    //   count  条数对不上 → 有增删
    //   tail   末行哈希不符 → 末行被改（这时链是完整的，只有链头能发现）
    //   empty  记录被清空，但链头还在
    // 以前三种都报成 trace_shrunk「记录比链头少」，
    // 而「末行被改」跟「被删」完全是两回事，照着提示去做出路会走错。
    const isTail = headChk.kind === 'tail';
    const why = headChk.kind === 'count' ? '条数和链头对不上（有增删）'
      : isTail ? '末行与链头不符（最后一条记录被改过）'
        : headChk.kind === 'empty' ? '记录被清空，但链头还在'
          : headChk.reason;
    return {
      ok: false,
      code: isTail ? 'trace_tail_changed' : 'trace_shrunk',
      hint: `留痕${why}——${headChk.reason}。`
        + (isTail
          ? '链本身是完整的，只有链头能发现末行被改，所以别只看链。'
          : '')
        + '确认是自己做的：trace --reseal 重建链头；放弃改动：git checkout -- <entries>/.trace.jsonl',
    };
  }

  const lastRec = lines.filter((l) => l && l.id === id).pop();

  if (!lastRec || typeof lastRec.after !== 'string') {
    // 到这一步，留痕本身是完整可信的（链通过、链头对得上）。
    // 「这条没有记录」现在只剩一种解释：它确实还没入过库（老库、adopt 之前）。
    // 记录被删的情况已经被上面的 count 比对拦掉了。
    return { ok: true };
  }
  if (contentHash(currentText) === lastRec.after) return { ok: true };
  return {
    ok: false,
    code: 'untracked_change',
    hint: '文件内容和上次入库记录不符——在工具之外被改过。'
      + '接受现状：proofline trace --adopt；放弃改动：git checkout 这个文件',
  };
}

/**
 * 提交一次写入。
 *
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.id
 * @param {string} args.text          新全文
 * @param {string|null} args.expect    期望的当前版本哈希；null 表示「这是新建」
 * @param {boolean} args.allowCreate   id 不存在时是否允许新建
 * @returns {Promise<{ok:boolean, code?:string, hash?:string, result?:object}>}
 */
export async function commit({ root, id, text, expect = null, allowCreate = false, op = 'write' }) {
  // 同 readEntry：id 必须落在 root 内。写比读更要紧——
  // 读错了只是显示错，写错了是把内容留在别人目录里。
  //
  // 早先这里只靠 join(root, id)，越界能否写成取决于下游还有哪些检查
  // （比如「快照必须存在」恰好会挡住大半）。那是偶然安全，不是有意安全。
  const dir = resolveInside(root, id);
  if (!dir) return { ok: false, code: 'bad_id' };
  // 写比读更要紧：符号链接指向库外时，这一笔会落到别人的目录里
  if (!(await withinReal(root, dir))) return { ok: false, code: 'escapes_root' };

  // 从这里开始进入临界区：读当前版本、比对 expect、落盘，三步必须连成一片。
  const release = await acquireLock(root);
  if (!release) return { ok: false, code: 'locked' };
  try {
  // 留痕写不了就别开始写。
  //
  // 放在这里而不是等 appendTrace 报错：那时 entry.md 已经落盘，
  // 结果是「一条本来合规的写入把条目变成未受控」——比干脆不写更糟。
  const traceWritable = await checkTraceWritable(root);
  if (!traceWritable.ok) return traceWritable;

  let current = null;
  try {
    current = await readFile(join(dir, ENTRY_FILE), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (current === null && !allowCreate) {
    return { ok: false, code: 'not_found' };
  }
  if (current !== null && expect === null) {
    return { ok: false, code: 'expect_required', currentHash: contentHash(current) };
  }
  if (current !== null && contentHash(current) !== expect) {
    return { ok: false, code: 'drift', expected: expect, currentHash: contentHash(current) };
  }

  // 留痕基准：这条上次入库时是什么内容。
  //
  // `expect` 是调用方给的，而 `set` / `run` / `corroborate` 都拿「当前文件的哈希」
  // 当 expect——自己跟自己比，永远相等，那一关形同虚设。
  //
  // 真正该比的是 trace 里记的 `after`：它是上次入库那一刻的内容。
  if (current !== null) {
    const untracked = await checkUntrackedChange(root, id, current);
    if (!untracked.ok) return untracked;
  }

  let snapshotText = null;
  try {
    snapshotText = await readFile(join(dir, 'raw', 'source.txt'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const snapshots = await loadSnapshotMap(dir, text);
  const readSnapshot = (rel) => (snapshots.has(rel) ? snapshots.get(rel) : null);
  const result = validateEntry({ dirName: id, text, snapshotText, readSnapshot, fix: false });
  if (result.status === 'hard_fail') {
    return { ok: false, code: 'hard_fail', hardFails: result.hardFails };
  }
  if (result.status === 'dirty') {
    return { ok: false, code: 'dirty', autofixes: result.autofixes };
  }

  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, ENTRY_FILE), text);

  const hash = contentHash(text);

  // 留痕在写成功之后。
  // 记在写之前会出现「记录了但没写成」的幽灵条目；记在写之后最坏是「写成了但没记上」，
  // 那种情况 check 会报「未受控」——错在保守的一边。
  //
  // 留痕失败不让写入失败：文件已经落盘了，回滚只会制造更坏的状态。
  // 但要把它带回去，让调用方说出来。
  const traced = await appendTrace(root, { op, id, after: hash }).catch((err) => ({
    ok: false,
    error: err.message,
  }));

  return {
    ok: true,
    hash,
    status: result.status,
    traceError: traced.ok ? null : traced.error,
  };
  } finally {
    // 无论走哪条 return，锁都要放——包括 throw。
    await release();
  }
}
