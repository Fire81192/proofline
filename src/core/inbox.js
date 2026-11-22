/**
 * 收件箱。
 *
 * ## 它是什么
 *
 * 一道「多出来的门」：开着的库，`new` / `import` 不能直接写正式区，
 * 得先把原料（一段原文 + 一句引文 + 一句话）放进 `_inbox/`，再由 `ingest` 搬进去。
 *
 * ## 它不是什么
 *
 * **不是物理隔离。** 工具和 AI 用的是同一套文件权限，`doctor` 会直接告诉你
 * 「正式区可写：是」。收件箱拦的是「手边有更快的路」，拦不住存心绕的人——
 * 那种情况由留痕兜底（未受控 = 不给引用）。
 *
 * ## 为什么可以开关
 *
 * 开着 = 多一道人工可介入的环节；关着 = 快，但 `check` 和证据册会一直写着
 * 「本库未启用收件箱」。**关掉是合法的，但关掉的事实要一直挂在墙上**——
 * 这是它和 `--no-trace` 那种「一关等于删立场」的区别。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INBOX_DIR = '_inbox';
export const DONE_DIR = '_done';

/** project.json 在 entries 的同级。没有就返回空对象——不能编一个出来。 */
export async function readProject(root) {
  try {
    return JSON.parse(await readFile(join(root, '..', 'project.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function isInboxOn(root) {
  const p = await readProject(root);
  return p?.inbox === true;
}

/** 只改 inbox 一个字段，其余原样写回。顺序按原文件的键序，不做重排。 */
export async function setInbox(root, on) {
  const cur = await readProject(root);
  const next = { ...(cur ?? {}), inbox: on };
  await writeFile(join(root, '..', 'project.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
