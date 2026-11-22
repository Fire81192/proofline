import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateEntry } from '../src/core/validate.js';
import { parseFrontmatter, joinFrontmatter } from '../src/core/frontmatter.js';
import { buildEntry, buildCorroborated, SNAPSHOT, CORROB_TEXT, DEFAULT_ID } from './helpers.js';

const check = (text, opts = {}) => validateEntry({
  dirName: opts.dirName ?? DEFAULT_ID,
  text,
  snapshotText: 'snapshotText' in opts ? opts.snapshotText : SNAPSHOT,
  fix: opts.fix ?? false,
});

test('合规条目 -> pass', () => {
  const r = check(buildEntry());
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('没有 frontmatter -> hard_fail', () => {
  const r = check('就是一段普通文本，没有头部');
  assert.equal(r.status, 'hard_fail');
});

test('id 与目录名不一致 -> dirty，修完变 fixed，且以目录名为准', () => {
  const text = buildEntry({ id: '2026-01-01-wrong-name' });
  const dirty = check(text);
  assert.equal(dirty.status, 'dirty');
  assert.ok(dirty.autofixes.some((a) => a.includes('id')));

  const fixed = check(text, { fix: true });
  assert.equal(fixed.status, 'fixed');
  assert.match(fixed.text, /id: 2026-11-21-xml-tag-prompt/);
});

test('引文在快照里找不到 -> hard_fail，且不写回', () => {
  const text = buildEntry({ quotes: ['这句话原文里根本没有'] });
  const r = check(text, { fix: true });
  assert.equal(r.status, 'hard_fail');
  assert.equal(r.text, null);
  assert.ok(r.hardFails.some((h) => h.includes('定位不到')));
});

test('快照哈希对不上 -> hard_fail', () => {
  const text = buildEntry({ source_sha256: 'a'.repeat(64) });
  const r = check(text);
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('哈希')));
});

test('判定写成中文 -> hard_fail，不会被猜成 supported', () => {
  const text = buildEntry({ evidence_status: '支持' });
  const r = check(text, { fix: true });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('evidence_status')));
});

test('判定只有大小写不对 -> 自动降成小写', () => {
  const text = buildEntry({ evidence_status: 'Supported' });
  const fixed = check(text, { fix: true });
  assert.equal(fixed.status, 'fixed');
  assert.match(fixed.text, /evidence_status: supported/);
});

test('缺口动作是 fetch 却没给 locator -> hard_fail', () => {
  const text = buildEntry({ gaps: [{ question: '原文完整版在哪', action: 'fetch' }] });
  const r = check(text);
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('locator')));
});

test('缺口动作是 search，不给 locator 也合规', () => {
  const text = buildEntry({ gaps: [{ question: '还有谁实测过', action: 'search' }] });
  const r = check(text);
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('没有原文快照时，只允许标 not_checked 且不带引文', () => {
  // 无快照的条目只能是「判断」档，且必须说明打算怎么验证。
  const ok = check(buildEntry({
    basis: '判断',
    source_sha256: undefined, quotes: [], evidence_status: 'not_checked',
    gaps: [{ question: '这条推理该怎么验', action: 'reanalyse', locator: '下一轮跑全量' }],
  }));
  assert.equal(ok.status, 'pass', ok.hardFails.join('; '));

  const bad = check(buildEntry({
    basis: '判断',
    source_sha256: undefined, quotes: [], evidence_status: 'supported',
    gaps: [{ question: '这条推理该怎么验', action: 'reanalyse', locator: '下一轮跑全量' }],
  }));
  assert.equal(bad.status, 'hard_fail');
  assert.ok(bad.hardFails.some((h) => h.includes('not_checked')));
});

test('basis=条目 却没有快照 -> hard_fail（读来的不能没有原文）', () => {
  const r = check(buildEntry({ basis: '条目', source_sha256: undefined, quotes: [], evidence_status: 'not_checked' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('读来的')));
});

test('没有快照却给引文 -> hard_fail（引文没法核）', () => {
  const r = check(buildEntry({ source_sha256: undefined, evidence_status: 'not_checked' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('没法核')));
});

test('缺 claim -> hard_fail', () => {
  const r = check(buildEntry({ claim: undefined }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('claim')));
});

test('claim 太短 -> hard_fail', () => {
  const r = check(buildEntry({ claim: '太短' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('太短')));
});

test('日期补零是机械修复', () => {
  const text = buildEntry({ added_at: '2026-1-5' });
  const fixed = check(text, { fix: true });
  assert.equal(fixed.status, 'fixed');
  assert.match(fixed.text, /added_at: 2026-01-05/);
});

test('填了发布日期却没给依据 -> hard_fail', () => {
  const r = check(buildEntry({ source_available_basis: undefined }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('available_basis')));
});

test('重复引文被去掉，且不算硬失败', () => {
  const text = buildEntry({ quotes: ['Claude 对 XML 标签很敏感。', 'Claude 对 XML 标签很敏感。'] });
  const fixed = check(text, { fix: true });
  assert.equal(fixed.status, 'fixed');
  assert.ok(fixed.autofixes.some((a) => a.includes('重复引文')));
});

test('通过两次校验结果稳定（不反复改写）', () => {
  const text = buildEntry({ added_at: '2026-1-5' });
  const once = check(text, { fix: true });
  const twice = check(once.text, { fix: true });
  assert.equal(twice.status, 'pass');
  assert.equal(twice.text, null);
});

test('claim 里带冒号也能原样读回', () => {
  const claim = '规则：先校验再写入，不要边写边算';
  const text = buildEntry({ claim });
  const { data } = parseFrontmatter(text);
  assert.equal(data.claim, claim);
});

test('frontmatter 往返不丢字段', () => {
  const text = buildEntry({ prereq: ['2026-11-20-filter-order'] });
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data.prereq, ['2026-11-20-filter-order']);
  const again = parseFrontmatter(joinFrontmatter(data, body));
  assert.deepEqual(again.data, data);
});

test('来源日期只精确到年，也合规（期刊常见）', () => {
  const r = check(buildEntry({ source_published_at: '2024' }));
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('来源日期只精确到月，也合规', () => {
  const r = check(buildEntry({ source_published_at: '2024-5' }), { fix: true });
  assert.equal(r.status, 'fixed');
  assert.match(r.text, /source_published_at: 2024-05/);
});

test('来源日期写成 2024 年 5 月这种中文 -> hard_fail，不猜', () => {
  const r = check(buildEntry({ source_published_at: '2024年5月' }));
  assert.equal(r.status, 'hard_fail');
});

test('added_at 仍然要完整日期（入库那天是确定的）', () => {
  const r = check(buildEntry({ added_at: '2024' }));
  assert.equal(r.status, 'hard_fail');
});

test('快照是 OCR 抽的，必须说清原件在哪', () => {
  const bad = check(buildEntry({ source_extraction: 'OCR' }));
  assert.equal(bad.status, 'hard_fail');
  assert.ok(bad.hardFails.some((h) => h.includes('source_original')));

  const ok = check(buildEntry({ source_extraction: 'OCR', source_original: '原PDF：xxx.pdf' }));
  assert.equal(ok.status, 'pass', ok.hardFails.join('; '));
});

test('source_extraction 是原文时不必填原件', () => {
  const r = check(buildEntry({ source_extraction: '原文' }));
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('source_extraction 取值不在集合里 -> hard_fail', () => {
  const r = check(buildEntry({ source_extraction: '截图' }));
  assert.equal(r.status, 'hard_fail');
});

// 用带佐证读取器的校验入口
const checkWithSnaps = (text, snaps) => validateEntry({
  dirName: DEFAULT_ID,
  text,
  snapshotText: SNAPSHOT,
  readSnapshot: (rel) => (rel in snaps ? snaps[rel] : null),
});

test('world_status 写 supported 却没佐证 -> hard_fail（不能空口说真）', () => {
  const r = check(buildEntry({ world_status: 'supported' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('corroborations')));
});

test('佐证完整且能定位 -> pass', () => {
  const r = checkWithSnaps(buildCorroborated(), { 'raw/verify-1.txt': CORROB_TEXT });
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('佐证的快照不在 -> hard_fail', () => {
  const r = checkWithSnaps(buildCorroborated(), {});
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('快照找不到')));
});

test('佐证的引文在自己的快照里定位不到 -> hard_fail', () => {
  const r = checkWithSnaps(buildCorroborated(), { 'raw/verify-1.txt': '这份快照里没有那句话。' });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('定位不到') || h.includes('哈希')));
});

test('佐证快照路径带 .. -> hard_fail（不许跳出条目目录）', () => {
  const text = buildCorroborated({}, { rel: '../../etc/passwd' });
  const r = checkWithSnaps(text, { '../../etc/passwd': CORROB_TEXT });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('不安全')));
});

test('非法日期不再放行（2026-13-45）', () => {
  assert.equal(check(buildEntry({ added_at: '2026-13-45' })).status, 'hard_fail');
  assert.equal(check(buildEntry({ source_published_at: '2024-02-30' })).status, 'hard_fail');
});

test('合法闰日仍然通过', () => {
  assert.equal(check(buildEntry({ added_at: '2024-02-29' })).status, 'pass');
});

test('有佐证但调用方没给读取器 -> hard_fail，不许静默放行', () => {
  const text = buildCorroborated();
  const r = validateEntry({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT }); // 故意不传 readSnapshot
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('读取器')));
});

test('world_status 写 contradicted 同样要佐证', () => {
  const r = check(buildEntry({ world_status: 'contradicted' }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('contradicted')));
});

test('引文空白归一真的改数据，不是只报不修', () => {
  const text = buildEntry({ quotes: ['Claude 对 XML 标签很敏感。 '] });
  const r = validateEntry({ dirName: DEFAULT_ID, text, snapshotText: SNAPSHOT, fix: true });
  assert.equal(r.status, 'fixed');
  assert.notEqual(r.text, text, '报了「已修」就必须真的改了');

  const again = validateEntry({ dirName: DEFAULT_ID, text: r.text, snapshotText: SNAPSHOT, fix: true });
  assert.equal(again.status, 'pass', '第二次必须收敛，不能反复报同一条');
});

test('缺 source_extraction -> hard_fail（不申报就免检是不行的）', () => {
  const r = check(buildEntry({ source_extraction: undefined }));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('source_extraction')));
});

test('文件带 BOM 也能读（Windows 编辑器常见）', () => {
  const text = `\uFEFF${buildEntry()}`;
  const r = check(text);
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('主张以方括号开头，不会被误当成 JSON 数组', () => {
  const text = buildEntry({ claim: '[实验] 随机划分会让未来样本进入训练集' });
  const r = check(text);
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('真正以 ] 结尾的坏数组仍然报错（不因为放宽就放过去）', () => {
  const text = buildEntry().replace(/^quotes: .*$/m, 'quotes: [a, b]');
  const r = check(text);
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('frontmatter')), r.hardFails.join('; '));
});

test('没闭合的方括号按普通字符串处理，最终因类型不符被拦下', () => {
  const text = buildEntry().replace(/^quotes: .*$/m, 'quotes: [a, b');
  const r = check(text);
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('quotes')), r.hardFails.join('; '));
});

test('佐证快照写成 C:/... 盘符路径 -> hard_fail（原来漏了）', () => {  // audit-ignore 夹具
  const text = buildCorroborated({}, { rel: 'C:/Windows/win.ini' });  // audit-ignore 夹具
  const r = checkWithSnaps(text, { 'C:/Windows/win.ini': CORROB_TEXT });  // audit-ignore 夹具
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('路径不安全')), r.hardFails.join('; '));
});

test('佐证快照写成 ~ 家目录 -> hard_fail', () => {
  const text = buildCorroborated({}, { rel: '~/.ssh/id_rsa' });
  const r = checkWithSnaps(text, { '~/.ssh/id_rsa': CORROB_TEXT });
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('路径不安全')));
});

// ---- 可检查条件 ----
const withChecks = (checks) => buildEntry({ checks });

test('合法的 checks 通过', () => {
  const r = check(withChecks([{ type: 'pattern', present: 'lfilter', level: '偏离惯例', cost: 'high', reversible: true, action: '换成 filtfilt' }]));
  assert.equal(r.status, 'pass', r.hardFails.join('; '));
});

test('checks 缺 present -> hard_fail（不说清「出现什么算踩坑」就没有规则）', () => {
  const r = check(withChecks([{ type: 'pattern', level: '偏离惯例', cost: 'high', reversible: true, action: 'x' }]));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('present')));
});

test('checks 的正则不合法 -> hard_fail', () => {
  const r = check(withChecks([{ type: 'pattern', present: '(未闭合', level: '偏离惯例', cost: 'high', reversible: true, action: 'x' }]));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('不是合法正则')));
});

test('checks 缺 action -> hard_fail', () => {
  const r = check(withChecks([{ type: 'pattern', present: 'x', level: '偏离惯例', cost: 'high', reversible: true }]));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('action')));
});

test('checks 的 reversible 必须显式写 -> 缺省 hard_fail', () => {
  const r = check(withChecks([{ type: 'pattern', present: 'x', level: '偏离惯例', cost: 'high', action: 'a' }]));
  assert.equal(r.status, 'hard_fail');
  assert.ok(r.hardFails.some((h) => h.includes('reversible')));
});

test('checks 的 level / cost 必须在允许集合里', () => {
  assert.equal(check(withChecks([{ type: 'pattern', present: 'x', level: '很严重', cost: 'high', reversible: true, action: 'a' }])).status, 'hard_fail');
  assert.equal(check(withChecks([{ type: 'pattern', present: 'x', level: '偏离惯例', cost: 'medium', reversible: true, action: 'a' }])).status, 'hard_fail');
});
