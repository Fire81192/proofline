import { joinFrontmatter } from '../src/core/frontmatter.js';
import { sha256 } from '../src/core/snapshot.js';
import { KEY_ORDER } from '../src/core/schema.js';

/** 测试用的「原文」。故意带换行和全角字符，好测空白归一。 */
export const SNAPSHOT = `Claude 对 XML 标签很敏感。
你把 prompt 分成几段，每段用不同的标签包起来，
它就不容易漏掉后面的部分。
不过这只在多段结构化 prompt 时成立，单段短 prompt 加标签反而费 token。`;

export const DEFAULT_ID = '2026-11-21-xml-tag-prompt';

export function buildEntry(overrides = {}, body = '') {
  const data = {
    schema: 1,
    id: DEFAULT_ID,
    claim: 'XML 标签分隔 prompt 在 Claude 上比 markdown 更稳定',
    kind: '方法',
    layer: '线索',
    // 默认夹具是有快照 + 有引文的，所以依据是「条目」。
    // 实测档和判断档各自需要不同的附加字段，别在这里放默认值糊过去。
    basis: '条目',
    source_kind: '短视频',
    source_uri: 'https://example.com/v/1',
    source_published_at: '2026-11-20',
    source_available_basis: '视频页显示发布日期',
    source_extraction: '原文',
    source_snapshot: 'raw/source.txt',
    source_sha256: sha256(SNAPSHOT),
    evidence_status: 'supported',
    world_status: 'unresolved',
    quotes: ['Claude 对 XML 标签很敏感。'],
    prereq: [],
    gaps: [],
    added_at: '2026-11-21',
    ...overrides,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key];
  }
  return joinFrontmatter(data, body, KEY_ORDER);
}


/** 一条独立佐证的快照内容（用于 world_status: supported 的场景）。 */
export const CORROB_TEXT = '另一份独立实现说明：该模型不含循环结构，全部依赖注意力。';
export const CORROB_QUOTE = '该模型不含循环结构，全部依赖注意力';

/**
 * 造一条 world_status 为 supported 的条目，并附带一条可定位的佐证。
 * 不给佐证就不能声称世界为真，这是硬规则。
 */
export function buildCorroborated(overrides = {}, opts = {}) {
  const rel = opts.rel ?? 'raw/verify-1.txt';
  const snapText = opts.snapshotText ?? CORROB_TEXT;
  const quote = opts.quote ?? CORROB_QUOTE;
  return buildEntry({
    world_status: 'supported',
    // 有佐证就该能下判断——但还要写清边界。缺 not_for 的条目现在不判 decisive，
    // 所以夹具必须带上，否则测的就不是「佐证够不够」而是「边界写没写」。
    not_for: ['不能说这条已经没有争议了——只有一份佐证'],
    corroborations: [{ uri: 'https://example.org/other-impl', sha256: sha256(snapText), snapshot: rel, quote }],
    ...overrides,
  });
}

/** 给派生函数用的同步快照读取器。 */
export function readerOf(map) {
  return (rel) => (rel in map ? map[rel] : null);
}
