/**
 * 动作前闸门（guard）。
 *
 * 这组测试守的是「保守方向」：拿不准必须 ask，不能 allow。
 * 另外守一条容易悄悄坏掉的性质——**deny 不会被 ask 稀释**。
 * 多个检查同时命中时取最重的那个，否则一条 deny 加了条 ask 就放行了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { guardAction, DECISION_WEIGHT } from '../src/guard.js';

const WS = join('C:', 'ws');

const g = (over = {}) => guardAction({ workspaceRoot: WS, target: '复现/x.py', ...over });

test('guard：直接写条目正文 -> deny', () => {
  const r = g({ target: 'entries/2026-11-22-x/entry.md', action: 'write' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.checks.some((c) => c.code === 'protected_entry'));
});

test('guard：改条目用 modify 也拦（换个动词绕不过去）', () => {
  const r = g({ target: 'entries/2026-11-22-x/entry.md', action: 'modify' });
  assert.equal(r.decision, 'deny');
});

test('guard：写条目目录里的别的文件不算绕闸门', () => {
  const r = g({ target: 'entries/2026-11-22-x/raw/run-1.txt', action: 'write' });
  assert.equal(r.decision, 'allow');
});

test('guard：普通文件写入放行', () => {
  const r = g({ target: '复现/new.py', action: 'write' });
  assert.equal(r.decision, 'allow');
  assert.equal(r.inside_workspace, true);
});

test('guard：删除一律 ask', () => {
  const r = g({ target: '复现/old.py', action: 'delete' });
  assert.equal(r.decision, 'ask');
  assert.ok(r.checks.some((c) => c.code === 'irreversible'));
});

test('guard：目标跑出工作区 -> ask，并标出来', () => {
  const r = g({ target: '../别处/x.py', action: 'write' });
  assert.equal(r.decision, 'ask');
  assert.equal(r.inside_workspace, false);
  assert.ok(r.checks.some((c) => c.code === 'outside_workspace'));
});

test('guard：内容命中已知的坑 -> ask，并指出行号', () => {
  const rules = [{
    entry: '某条',
    action: '改用分位数裁剪',
    detect: (text) => {
      const out = [];
      text.split('\n').forEach((line, i) => {
        if (line.includes('min()')) out.push({ line: i + 1, snippet: line.trim() });
      });
      return out;
    },
  }];
  const r = g({ content: 'a = x.min()\n', rules });
  assert.equal(r.decision, 'ask');
  const hit = r.checks.find((c) => c.code === 'rule_hit');
  assert.ok(hit);
  assert.match(hit.next, /第 1 行/);
  assert.match(hit.detail, /改用分位数裁剪/);
});

test('guard：内容含本机路径 -> ask', () => {
  const r = g({ content: 'DATA = "C:\\\\Users\\\\me\\\\data.hdf5"\n' });  // audit-ignore 假路径，测隐私检查
  assert.equal(r.decision, 'ask');
  assert.ok(r.checks.some((c) => c.code === 'privacy'));
});

test('guard：删条目 -> deny，指向 deprecate 而不是让人自己删', () => {
  const r = g({ target: 'entries/2026-11-22-x', action: 'delete' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.checks.some((c) => c.code === 'protected_entry_delete'));
});

test('guard：deny 不会被同时出现的 ask 稀释', () => {
  const r = g({
    target: 'entries/2026-11-22-x/entry.md',
    action: 'write',
    content: 'C:\\Users\\me\\x',  // audit-ignore 假路径，测隐私检查
  });
  // protected_entry(deny) + privacy(ask) 同时命中，取最重的
  assert.equal(r.checks.length, 2);
  assert.equal(r.decision, 'deny');
});

test('guard：detect 抛异常的单条规则被跳过，不影响其它检查', () => {
  const rules = [{ entry: '坏', detect: () => { throw new Error('boom'); } }];
  const r = g({ content: 'x', rules, action: 'delete' });
  assert.equal(r.decision, 'ask');
  assert.ok(r.checks.some((c) => c.code === 'irreversible'));
});

test('guard：空内容不触发规则和隐私检查', () => {
  const rules = [{ entry: '某条', detect: () => [{ line: 1, snippet: 'x' }] }];
  const r = g({ content: '', rules });
  assert.equal(r.decision, 'allow');
});

test('guard：决策权重表是 allow < ask < deny', () => {
  assert.equal(DECISION_WEIGHT.allow < DECISION_WEIGHT.ask, true);
  assert.equal(DECISION_WEIGHT.ask < DECISION_WEIGHT.deny, true);
});

// ---------------------------------------------------------------- 覆盖不可再生产物

test('guard：覆盖已存在的模型文件 -> ask', () => {
  const r = g({ target: '复现/out/unet_small.keras', action: 'write', targetExists: true });
  assert.equal(r.decision, 'ask');
  assert.ok(r.checks.some((c) => c.code === 'overwrite_artifact'));
});

test('guard：覆盖普通文本文件不拦——那是正常编辑', () => {
  const r = g({ target: '复现/train_small.py', action: 'write', targetExists: true });
  assert.equal(r.decision, 'allow');
});

test('guard：新建模型文件不拦（还没有东西可丢）', () => {
  const r = g({ target: '复现/out/new.keras', action: 'write', targetExists: false });
  assert.equal(r.decision, 'allow');
});

test('guard：数据集与张量同样受保护', () => {
  for (const name of ['data/x.h5', 'data/x.npy', 'data/x.parquet', 'ckpt/x.pt']) {
    const r = g({ target: name, action: 'write', targetExists: true });
    assert.equal(r.decision, 'ask', name);
  }
});

// ---------------------------------------------------------------- 嵌套路径与误报

test('guard：entries 不在工作区根下时也要拦住（真实项目就是这样）', () => {
  // 这条是回归测试：早先正则写成 ^entries，从项目根跑时一条都拦不住，
  // 而单元测试用的是扁平路径，正好测不到。
  const r = g({ target: 'workspace/ppg2abp/entries/2026-11-22-x/entry.md', action: 'write' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.checks.some((c) => c.code === 'protected_entry'));
});

test('guard：嵌套路径下删条目目录也拦', () => {
  const r = g({ target: 'workspace/ppg2abp/entries/2026-11-22-x', action: 'delete' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.checks.some((c) => c.code === 'protected_entry_delete'));
});

test('guard：规则只对代码文件生效——文档提到 PPG 不该命中滤波规则', () => {
  const rules = [{
    entry: '某条',
    action: '先滤波',
    detect: () => [{ line: 1, snippet: 'PPG' }],
  }];
  const doc = g({ target: '论文.md', content: '本文讨论 PPG 信号的预处理', rules });
  assert.equal(doc.decision, 'allow');

  const code = g({ target: 'preprocess.py', content: 'x = load("ppg")', rules });
  assert.equal(code.decision, 'ask');
});

test('guard：认 audit-ignore 豁免，不和 audit 给出相反结论', () => {
  const content = 'p = "C://Users//me//x"  // audit-ignore 假路径';
  const r = g({ target: 'a.js', content });
  assert.equal(r.decision, 'allow');
});

test('guard：同一文件里没被豁免的行仍然照报', () => {
  const content = 'a = "C://Users//me//x"  // audit-ignore\nb = "C://Users//me//y"\n';
  const r = g({ target: 'b.js', content });
  assert.equal(r.decision, 'ask');
  assert.ok(r.checks.some((c) => c.code === 'privacy'));
});

// ---------------------------------------------------------------- 动作名归一化

test('guard：写文件的各种叫法都要拦住（edit / create / update / 不认识的动词）', () => {
  // 回归测试：早先只认 write / modify，Edit 工具一调就放行。
  for (const a of ['write', 'modify', 'edit', 'create', 'update', 'patch', 'save', 'frobnicate']) {
    const r = g({ target: 'entries/2026-11-22-x/entry.md', action: a });
    assert.equal(r.decision, 'deny', `动作 ${a} 应该被拦`);
  }
});

test('guard：发布类带空格或驼峰也要认出来', () => {
  for (const a of ['push', 'force push', 'ForcePush', 'deploy', 'publish']) {
    assert.equal(g({ target: 'a.js', action: a }).decision, 'ask', a);
  }
});

test('guard：删除类的各种叫法也认', () => {
  for (const a of ['delete', 'remove', 'rm', 'truncate', 'erase']) {
    assert.equal(g({ target: 'a/x.py', action: a }).decision, 'ask', a);
  }
});

test('guard：entries 目录名大小写不同也要拦（Windows 路径不区分大小写）', () => {
  for (const t of ['entries/x/entry.md', 'Entries/x/entry.md', 'ENTRIES/x/entry.md']) {
    assert.equal(g({ target: t, action: 'write' }).decision, 'deny', t);
  }
});

test('guard：内容里有疑似密钥 -> ask，但 sk-learn 这种不算', () => {
  assert.equal(g({ target: 'a.env', content: 'key: sk-live-abcdefghijklmnop1234' }).decision, 'ask');  // audit-ignore 测试夹具，假 key
  assert.equal(g({ target: 'a.md', content: 'sk-learn 是一个库' }).decision, 'allow');
});

// ---------------------------------------------------------------- 删除语义的动作名

test('guard：各种删除叫法都要拦住条目目录（purge / wipe / clear / destroy）', () => {
  // 回归测试：早先判的是 kind === 'delete'，而 DELETE_RE 只认出
  // delet/remov/unlink/eras/truncat/drop/rm。purge、wipe、clear、destroy
  // 落到 write 分支，而 write 分支只管 entry.md、不管目录——
  // 于是四个删除语义的动词全部 allow，整条主张就这么没了。
  for (const a of ['delete', 'purge', 'wipe', 'clear', 'destroy', 'remove', 'rm', 'unlink', 'truncate']) {
    const r = g({ target: 'entries/2026-11-21-a', action: a, targetExists: true });
    assert.equal(r.decision, 'deny', `动作 ${a} 删条目应该被拦`);
  }
});

test('guard：读条目不该被拦——一个总在误伤的闸门会被关掉', () => {
  // 回归测试：classify 没有 read 这一档时，read 被归进 write，
  // 而 entry.md 的保护条件是 kind === 'write'，于是「读」也会 deny。
  for (const a of ['read', 'list', 'stat', 'grep', 'inspect', 'cat']) {
    const r = g({ target: 'entries/2026-11-21-a/entry.md', action: a });
    assert.equal(r.decision, 'allow', `动作 ${a} 是只读，不该拦`);
  }
});

test('guard：写条目仍然拦（read 这一档不能把写放走）', () => {
  for (const a of ['write', 'edit', 'create', 'update', 'patch', 'save', 'frobnicate']) {
    assert.equal(g({ target: 'entries/2026-11-21-a/entry.md', action: a }).decision, 'deny', a);
  }
});
