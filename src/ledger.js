/**
 * 插话日志：append-only 的 JSONL。
 *
 * 为什么不存一份「当前状态」的 json：
 * 状态会撒谎。写了 status: open，实际早就解决了，后面所有判断都建在错的假设上。
 * 所以只追加事件，每次读的时候重放（见 interrupt.replay）。
 *
 * 跟 entries 一个道理：**状态读时算，不存。**
 *
 * 不能删记录。删了就查不出「这句话到底说没说过」，
 * 而这正是「同一条不重复」唯一依赖的事实。
 */

import { readFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256 } from './core/snapshot.js';

const EVENT_TYPES = new Set(['said', 'listed', 'noted', 'resolved']);

// 点开头，避免被 listEntryDirs 当成条目目录
export const LOG_DIR = '.log';

/**
 * 项目名 -> 文件名。
 *
 * 只做字符清洗会让不同项目撞到同一个文件（`alpha beta` 与 `alpha@beta`
 * 都变成 `alpha-beta`），日志串了之后「同一条不重复」就失效。
 * 所以清洗改变了原名时，追加一小段原名的哈希，保证一一对应。
 * 名字本来就干净的（ppg-demo、study-desk）不会被改动。
 */
function logPath(root, project) {
  const raw = String(project);
  const safe = raw.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-');
  const suffix = safe === raw ? '' : `-${sha256(raw).slice(0, 6)}`;
  return join(root, LOG_DIR, `${safe}${suffix}.jsonl`);
}

/** 读一个项目的事件流。没有就返回空数组，不当错误。 */
export async function readLog(root, project) {
  let text;
  try {
    text = await readFile(logPath(root, project), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let evt;
    try {
      evt = JSON.parse(t);
    } catch {
      bad += 1; // 坏行跳过，但计数：部分日志不能伪装成完整事件流
      continue;
    }
    // 语法合法不等于事件可信。结构不对的当作坏行，不让它影响重放。
    if (!evt || typeof evt.key !== 'string' || !evt.key
        || !EVENT_TYPES.has(evt.type)
        || Number.isNaN(Date.parse(evt.ts))) {
      bad += 1;
      continue;
    }
    records.push(evt);
  }
  // 数组上挂计数，调用方可以据此区分「空日志」和「日志有坏行」
  records.bad = bad;
  return records;
}

/** 追加事件。一条一行，永不覆写。 */
export async function appendLog(root, project, records) {
  if (!records.length) return null;
  const path = logPath(root, project);
  await mkdir(join(root, LOG_DIR), { recursive: true });
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(path, payload, 'utf8');
  return path;
}

/** 列出已有日志的项目名。 */
export async function listProjects(root) {
  try {
    const names = await readdir(join(root, LOG_DIR));
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
