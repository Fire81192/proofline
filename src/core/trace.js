/**
 * 操作留痕。
 *
 * ## 它解决什么问题
 *
 * 工具的所有校验都发生在「通过工具写入」这条路上。但 AI 有文件写权限，
 * 它可以直接改 `entry.md`——顺手把 frontmatter 里的哈希也改掉，`validate` 看不出来。
 * 这不是恶意，是「手边有更快的路」。
 *
 * 所以这里不做拦截（拦不住），做**留痕**：每次合法写入追加一行，
 * 每行含上一行的哈希。改一行、删一行，后面全断——断链本身就是证据。
 *
 * ## 它防不住什么（必须写在这里，否则就是自我安慰）
 *
 * 防不住「全量重写」：把整个文件删掉重生成一遍，链是自洽的。
 *
 * 这一层交给版本库，但要说清版本库给的是什么：
 * **不是「改不了」，是「改一次就多一次 commit」**。正常写入的 diff 是
 * 「一行 trace + 一条 entry」；某次 diff 里 trace 整份变了，那次就可疑。
 *
 * 而且它也有边界：只有本地仓库时，reset + reflog expire + gc 能把历史抹掉；
 * 有远程副本，改写才需要 force push——那是显式动作，不是不可能。
 *
 * 所以两道合起来给的不是「防住」，是**成本递增**：
 * 链保证「局部没被动过」，版本库保证「整份被换掉时你能看见是哪一次换的」。
 * 前提是：你真的 commit，而且有远程副本。没有这两样，这条就只是设计承诺。
 */

import { readFile, mkdir, appendFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './snapshot.js';

export const TRACE_FILE = '.trace.jsonl';

/**
 * 链头。
 *
 * 链本身有个先天缺陷：**最后一行没有后继**，所以改末行、或者往末尾追加一行，
 * 都不会让任何 prev 对不上——两份外部审核都指到了这里。
 *
 * 这里加一个独立锚：每次写入后，把「最后一行」的哈希和总行数记到 .trace.head。
 * 改末行 → 哈希对不上；追加一行 → 行数对不上。
 *
 * 它防不住「连 .trace.head 一起改」，也防不住整份重写。
 * 那两种情况的痕迹只能由版本库留下——而且版本库给的是「多一次 commit」，不是「不许改」。
 * 目标是提高成本，不是绝对安全。
 */
export const HEAD_FILE = '.trace.head';

/** 整行的哈希：字段顺序由我们自己固定，保证同一份记录算出来一样。 */
export function lineHash(rec) {
  return sha256(JSON.stringify([rec.v, rec.at, rec.op, rec.id, rec.after, rec.prev ?? '']));
}

/**
 * 读全部记录。
 *
 * 坏行不跳过——跳过等于把「被改坏」当成「没有」。
 * 整个文件读不了，返回 empty + error，调用方要区分「没有留痕」和「留痕坏了」。
 */
export async function readTrace(root) {
  let text;
  try {
    text = await readFile(join(root, TRACE_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], error: null, exists: false };
    return { lines: [], error: `读不了 ${TRACE_FILE}：${err.message}`, exists: true };
  }

  const lines = [];
  const raw = text.split('\n').filter((l) => l.trim() !== '');
  for (let i = 0; i < raw.length; i += 1) {
    try {
      const rec = JSON.parse(raw[i]);
      if (!rec || typeof rec !== 'object') throw new Error('不是对象');
      lines.push(rec);
    } catch (err) {
      return { lines, error: `第 ${i + 1} 行不是合法记录：${err.message}`, exists: true };
    }
  }
  return { lines, error: null, exists: true };
}

/** 链校验：第 i 行的 prev 必须等于第 i-1 行的整行哈希。 */
export function verifyChain(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const want = i === 0 ? '' : lineHash(lines[i - 1]);
    const got = lines[i].prev ?? '';
    if (got !== want) {
      return { ok: false, brokenAt: i + 1, reason: i === 0 ? '第一行的 prev 应该是空' : `第 ${i} 行之后被改动或插入` };
    }
  }
  return { ok: true, brokenAt: null, reason: null };
}

/**
 * trace 的写锁。
 *
 * ## 为什么需要
 *
 * `appendTrace` 的流程是「读全链 → 算 prev → 追加」。读和写之间隔着 await，
 * 两个调用同时进来会读到同样的 lines、算出同样的 prev，于是两条记录指向同一个
 * 前驱——链被拆成一堆孤立节点。
 *
 * 实测：并发 20 次，20 条全落盘（appendFile 是 O_APPEND，单行写入原子），
 * 但相邻重复 prev 有 19 处，`verifyChain` 直接判「第 1 行之后被改动或插入」。
 *
 * 注释原本写着「每次重读一遍不缓存，缓存会让别人刚写过一行变成断链」——
 * 那是只考虑了**顺序**写，没考虑**同时**写。
 *
 * ## 为什么不复用 store.js 的 entries/.lock
 *
 * commit 持着 entries 锁调 appendTrace，再拿同一把会死锁。
 * 两把独立的锁、获取顺序固定（先 entries 后 trace），不会成环。
 *
 * 为什么不把两边抽成一个公共函数：store.js 那把已经被 520 个测试覆盖，
 * 为了省 20 行去动它，风险大于收益。
 */
async function acquireTraceLock(root, timeoutMs = 3000) {
  const p = join(root, '.trace.lock');
  const start = Date.now();
  for (;;) {
    try {
      // wx = 只在文件不存在时创建。拿不到就说明别人在写。
      await writeFile(p, String(process.pid), { flag: 'wx' });
      return async () => {
        await rm(p, { force: true }).catch(() => {});
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 僵尸锁：进程崩了没删。超过 10 秒当它失效——比一直卡住好。
      try {
        const st = await stat(p);
        if (Date.now() - st.mtimeMs > 10_000) {
          await rm(p, { force: true });
          continue;
        }
      } catch { /* 刚好被删了，下一轮能拿到 */ }
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => { setTimeout(r, 5); });
    }
  }
}

/**
 * 追加一条记录。
 *
 * 每次都要重读一遍拿上一行的哈希——不缓存。
 * 缓存会让「别人刚写过一行」变成断链，而那种断链是假警报。
 *
 * 但「重读」只解决顺序写，解决不了同时写：两个调用都在 await 里读到同样的
 * lines，就会算出同样的 prev。所以外面必须包一层锁。
 */
export async function appendTrace(root, { op, id, after, at = new Date().toISOString(), note = null }) {
  await mkdir(root, { recursive: true });
  const release = await acquireTraceLock(root);
  if (!release) {
    return { ok: false, error: '留痕正被另一个进程写（.trace.lock 超时）——稍后重试' };
  }
  try {
    const { lines, error } = await readTrace(root);
    if (error) return { ok: false, error };

    const prev = lines.length > 0 ? lineHash(lines[lines.length - 1]) : '';
    const rec = { v: 1, at, op, id, after, prev };
    if (note) rec.note = note;

    await appendFile(join(root, TRACE_FILE), `${JSON.stringify(rec)}\n`, 'utf8');

    // 同步链头。写失败不让追加失败——记录已经落盘，head 落后只会让 check 报一次
    // 「链头对不上」，那是保守的一边，不会让绕过变成通过。
    await writeHead(root, lineHash(rec), lines.length + 1).catch(() => {});

    return { ok: true, record: rec };
  } finally {
    await release();
  }
}

/** 读链头。没有文件 = 这个库从没写过留痕（老库），不是错。 */
export async function readHead(root) {
  try {
    const raw = await readFile(join(root, HEAD_FILE), 'utf8');
    const v = JSON.parse(raw);
    if (!v || typeof v.head !== 'string' || !Number.isInteger(v.count)) return { exists: true, error: '链头文件格式不对' };
    return { exists: true, head: v.head, count: v.count, error: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, error: null };
    return { exists: true, error: `读不了 ${HEAD_FILE}：${err.message}` };
  }
}

export async function writeHead(root, head, count) {
  await writeFile(join(root, HEAD_FILE), JSON.stringify({ v: 1, head, count }) + '\n', 'utf8');
}

/**
 * 链头与链是否一致。
 *
 * 三种情况分开说：
 * - 没有链头文件 → 老库，不判错（它们没有可追溯的链头）
 * - 链头对不上 → 末行被改过，或者被追加过
 * - 行数对不上 → 有增删
 */
export function verifyHead(head, lines) {
  if (!head.exists) return { ok: true, kind: 'absent' };
  if (head.error) return { ok: false, kind: 'unreadable', reason: head.error };
  if (lines.length === 0) return { ok: false, kind: 'empty', reason: '有链头但没有记录' };
  if (head.count !== lines.length) {
    return { ok: false, kind: 'count', reason: `链头记着 ${head.count} 条，实际 ${lines.length} 条——有增删` };
  }
  const actual = lineHash(lines[lines.length - 1]);
  if (actual !== head.head) {
    return { ok: false, kind: 'tail', reason: '末行与链头不符——最后一条记录被改过' };
  }
  return { ok: true, kind: 'ok' };
}

/** 每个条目最后一条记录。链断了也照给——「有记录但与当前不符」和「没有记录」是两回事。 */
export function lastByEntry(lines) {
  const map = new Map();
  for (const line of lines) {
    if (typeof line?.id === 'string') map.set(line.id, line);
  }
  return map;
}

/**
 * 一个条目受不受控。
 *
 * @param {string|null} lastAfter 该条目最后一条记录里的 after
 * @param {string|null} currentHash 当前 entry.md 的 contentHash
 */
export function controlState(lastAfter, currentHash) {
  if (!lastAfter) return { controlled: false, kind: 'no_trace', why: '没有任何入库记录' };
  if (!currentHash) return { controlled: false, kind: 'unreadable', why: '条目读不了，无法比对' };
  if (lastAfter !== currentHash) {
    return { controlled: false, kind: 'drift', why: '与最后一次入库记录不符——在工具之外被改过' };
  }
  return { controlled: true, kind: 'ok', why: null };
}
