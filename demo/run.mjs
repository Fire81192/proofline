/**
 * 60 秒看懂这个工具在做什么。
 *
 * 三步：
 *   1. 三条主张，全部合规——check 全 pass
 *   2. 手改一条 entry.md（模拟「绕开工具改文件」）
 *   3. 再 check——它被标成「未受控」，status 不给引用
 *
 * 演示用的是 demo/entries 下的假数据，不动任何真实库。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'entries');
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const TARGET = '2026-01-01-demo-altitude';
const ENTRY = join(ROOT, TARGET, 'entry.md');

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

const line = (s = '') => console.log(s);
const head = (s) => {
  line();
  line('─'.repeat(64));
  line(s);
  line('─'.repeat(64));
  line();
};

line();
line('proofline — 每条主张都要能在原文里定位到。');
line('下面三步，看它怎么处理「有人绕过工具改了文件」。');

head('① 现在这个库是干净的');
const first = run(['check', ROOT]);
line(first.out.split('\n').filter((l) => l.includes('扫描')).join('\n') || first.out.trim());

head('② 模拟一次绕过：直接改 entry.md 里的一个数字');
line(`目标：${TARGET}`);
line('把「约 300 米」改成「约 350 米」——不动 frontmatter，不动哈希。');

const before = readFileSync(ENTRY, 'utf8');
const after = before.replace('约 300 米', '约 350 米');
if (before === after) {
  line('（这条里没找到要改的字，demo 数据可能被改过了）');
  process.exit(1);
}
writeFileSync(ENTRY, after, 'utf8');
line('已改。');

head('③ 再 check 一次');
const second = run(['check', ROOT]);
for (const l of second.out.split('\n')) {
  if (/扫描|未受控|与最后一次|在工具之外/.test(l)) line(l);
}

line();
line('注意「pass=3」和「未受控 1 条」同时出现——这不矛盾：');
line('  pass 说的是「三个文件的形状都合规」；');
line('  未受控说的是「有一条的内容和它入库时不一样了」。');
line('两件事分开报，是因为它们的处理方式完全不同：');
line('  形状不对 → 改字段；内容对不上 → 回到原文重新核对。');

line();
line('再看这条本身还能不能引用：');
const st = run(['status', TARGET, ROOT]);
for (const l of st.out.split('\n')) {
  if (/受控|能引用|能下判断/.test(l)) line(l);
}

head('④ 恢复原样');
writeFileSync(ENTRY, before, 'utf8');
const third = run(['check', ROOT]);
line(third.out.split('\n').filter((l) => l.includes('扫描')).join('\n'));

line();
line('结论：');
line('  它拦不住你改文件——你有写权限。');
line('  但它记得住每条内容是什么时候、以什么方式进来的。');
line('  改了之后，那条不会「变成假的」，只会「不算数」——');
line('  它仍在库里，能读、能查，但不再被当成依据。');
line();
line('下一步：npm run demo 里的 view 和 map，看它给谁看、给 AI 看什么。');
line();
