/**
 * 来源：这个库到底靠哪些材料撑着。
 *
 * ## 为什么要有这一层
 *
 * 条目里有 source_uri，但那是每条各写各的字符串。两条主张来自同一篇论文，
 * 只能靠字符串相等去猜。于是回答不了两个最基本的问题：
 *   我到底依赖了几个来源？
 *   这篇不可信，它下面挂了哪几条？
 *
 * ## 为什么"删"要变成"弃用"
 *
 * 删掉一份材料，从它长出来的主张就失去证据，而且不可恢复——快照参与哈希，
 * 删了就是删了。这不是 bug，是这个工具的核心代价：可核与可删只能选一个。
 *
 * 所以这里不做删除，做"来源级判断"：
 *   在用   —— 默认
 *   可疑   —— 还没核清楚，先别拿来引用
 *   弃用   —— 判定它不适用，它下面所有主张降级
 *
 * 降级只发生在读取时，不覆盖条目里人写的判定——判定只能由人改。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { retiredOf } from './core/schema.js';

// 点开头，避免被 listEntryDirs 当成条目目录
export const SOURCES_FILE = '.sources.json';

export const SOURCE_STATUSES = ['在用', '可疑', '弃用'];

/** 会让引用失效的状态。 */
const BLOCKING_STATUSES = new Set(['可疑', '弃用']);

export function isBlockingStatus(status) {
  return BLOCKING_STATUSES.has(status);
}

/** 读来源登记表。没有就是空表，不当错误。 */
export async function readSources(root) {
  let text;
  try {
    text = await readFile(join(root, SOURCES_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 登记表坏了不该让整个库不可用：当作空表，但调用方会看到「没有登记」
    return {};
  }
}

export async function writeSources(root, map) {
  await writeFile(join(root, SOURCES_FILE), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/**
 * 把条目按来源聚起来。
 *
 * @param {Array<{id:string, data:object}>} entries
 * @returns {Map<string, {uri:string, entries:Array, extraction:string|null, quality:string|null}>}
 */
export function groupBySource(entries) {
  const map = new Map();
  for (const e of entries) {
    // 判断档没有来源，这不是「忘了登记」——别把它算成一个来源，
    // 否则来源表里会多出一行假的，把真正漏填的那些淹掉。
    if (e.data?.basis === '判断') continue;
    const uri = typeof e.data?.source_uri === 'string' && e.data.source_uri.trim()
      ? e.data.source_uri.trim()
      : '（未登记来源）';
    if (!map.has(uri)) {
      map.set(uri, { uri, entries: [], extraction: null, quality: null });
    }
    const group = map.get(uri);
    group.entries.push(e);
    if (group.extraction === null && typeof e.data?.source_extraction === 'string') {
      group.extraction = e.data.source_extraction;
    }
    if (group.quality === null && typeof e.data?.source_quality === 'string') {
      group.quality = e.data.source_quality;
    }
  }
  return map;
}

/**
 * 一个来源现在算什么状态。
 * 没登记过就是「在用」——默认信任，而不是默认怀疑。
 */
export function statusOf(registry, uri) {
  const rec = registry?.[uri];
  if (!rec || typeof rec !== 'object') return { status: '在用', reason: null, decided_at: null };
  const status = SOURCE_STATUSES.includes(rec.status) ? rec.status : '在用';
  return { status, reason: rec.reason ?? null, decided_at: rec.decided_at ?? null };
}

/**
 * 概览：每个来源挂了几条、几条能引用、几条已经废了。
 *
 * @returns {Array} 按支撑数降序
 */
export function overview(entries, registry = {}) {
  const groups = groupBySource(entries);
  const rows = [];
  for (const [uri, g] of groups) {
    const st = statusOf(registry, uri);
    rows.push({
      uri,
      status: st.status,
      reason: st.reason,
      decided_at: st.decided_at,
      extraction: g.extraction,
      quality: g.quality,
      count: g.entries.length,
      // 退役的条目还挂在来源下面（它确实来自这份材料），但不再算「在支撑」。
      // 两个数分开，是因为「读过 N 条」和「现在靠 M 条」是两个问题。
      retired: g.entries.filter((e) => retiredOf(e.data)).length,
      claims: g.entries.map((e) => ({
        id: e.id,
        claim: e.data?.claim ?? '',
        retired: Boolean(retiredOf(e.data)),
      })),
      blocking: isBlockingStatus(st.status),
    });
  }
  rows.sort((a, b) => b.count - a.count || a.uri.localeCompare(b.uri));
  return rows;
}

/**
 * 弃用某个来源会产生什么后果。
 *
 * 这段是给「AI 评估 + 人拍板」用的：工具只算事实，好坏由人说。
 */
export function impactOf(entries, registry, uri) {
  const rows = overview(entries, registry);
  const target = rows.find((r) => r.uri === uri);
  if (!target) return null;

  const others = rows.filter((r) => r.uri !== uri);
  const affected = target.claims.filter((c) => c.claim);
  const stillCitable = others.reduce((n, r) => n + (r.blocking ? 0 : r.count), 0);

  return {
    uri,
    status: target.status,
    affected,
    affectedCount: affected.length,
    // 弃用之后，库里还能引用多少条
    remainingCitable: stillCitable,
    // 有没有哪条主张只靠这一个来源
    orphaned: affected.length > 0 && stillCitable === 0,
    totalSources: rows.length,
  };
}
