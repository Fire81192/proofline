/**
 * 来源快照与内容指纹。
 *
 * 两条规则：
 * 1. 入库时把原文存到 raw/，算 sha256。之后所有引文都对着这份快照核。
 * 2. 算指纹时**排除抓取时间**——抓取时间是观察行为，不是被观察对象的一部分。
 *    同一篇文章抓两次，指纹必须一致，否则「内容变没变」永远判断不了。
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SNAPSHOT_REL = 'raw/source.txt';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 按原始字节算指纹。
 *
 * 什么时候必须用它：目标是二进制（.keras、.h5、.npy）。`readFile(path,'utf8')`
 * 会把非法字节换成 U+FFFD，再编码回去就和文件字节不一样了——哈希看着稳定，
 * 但拿 `sha256sum` 对不上，等于「可核」变成了「只能用它自己核」。
 *
 * 对合法 UTF-8 文本，这个和 `sha256(text)` 结果相同，所以老的文本记录不用重算。
 */
export function sha256Bytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 指纹：只取会被「内容变没变」影响的部分。
 * retrievedAt 明确不参与。
 */
export function fingerprint({ uri, publishedAt, content }) {
  const material = JSON.stringify({
    uri: uri ?? '',
    publishedAt: publishedAt ?? null,
    content: content ?? '',
  });
  return sha256(material).slice(0, 16);
}

export async function writeSnapshot(entryDir, text) {
  const target = join(entryDir, SNAPSHOT_REL);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return { rel: SNAPSHOT_REL, hash: sha256(text) };
}

export async function readSnapshot(entryDir, rel = SNAPSHOT_REL) {
  try {
    return await readFile(join(entryDir, rel), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
