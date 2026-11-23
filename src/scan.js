/**
 * 扫一个项目目录，把规则命中变成候选提醒。
 *
 * 它只做一件事：**从产出物里读出风险，交给判定层。**
 * 不判断人懂不懂，也不猜意图——只看代码里写了什么。
 *
 * 注意：不再无条件跳过名为 `raw` 的目录。真实项目里 `src/raw/` 也可能放代码，
 * 静默跳过等于无提示漏扫。数据目录体积大也只是慢，不会错。
 *
 * ## 为什么要聚合
 *
 * 同一条坑出现在五个文件里，是「一个问题」而不是「五个问题」。
 * 所以按规则聚合成一条候选，evidence 里列出位置。
 * 这样判定层的「同一条不重复说」才有意义：说一次，位置都给他。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

import { RULES } from './rules.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.log', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.idea', '.vscode', '.cache',
]);

const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.ps1', '.m', '.r', '.jl',
]);

const MAX_BYTES = 512 * 1024;

async function walk(dir, root, out = [], errors = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 读不了的目录要记下来。静默跳过等于「扫过了，没问题」——
    // 而实际上根本没看。这是最坏的一种错。
    errors.push({ dir, code: err.code ?? 'UNKNOWN' });
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(full, root, out, errors);
      continue;
    }
    if (!CODE_EXT.has(extname(e.name).toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

/**
 * @param {string} dir  要扫的目录
 * @param {object} [opts]
 * @param {Array} [opts.rules]
 * @param {number} [opts.maxEvidence] 每条最多列几个位置
 * @returns {Promise<{candidates:Array, stats:object}>}
 */
export async function scanProject(dir, { rules = RULES, maxEvidence = 5 } = {}) {
  const errors = [];
  const files = await walk(dir, dir, [], errors);
  const byRule = new Map();
  let scanned = 0;
  let skippedLarge = 0;
  let unreadableFiles = 0;
  let ruleErrors = 0;

  for (const file of files) {
    const rel = relative(dir, file).replace(/\\/g, '/');
    let text;
    try {
      // 先看大小再读，和 audit 同一条规矩：判在读取之后，保护的就是已经发生的事。
      const info = await stat(file);
      if (info.size > MAX_BYTES) { skippedLarge += 1; continue; }
      const buf = await readFile(file);
      text = buf.toString('utf8');
    } catch {
      // 读不了也要报数。
      //
      // 以前这里直接 continue，于是「3 个文件里 1 个读不了」和
      // 「3 个都扫过、没有命中」在输出上是同一句话——
      // 扫描结果看起来完整，其实少了一份材料，而人以为「没有候选」。
      unreadableFiles += 1;
      continue;
    }
    scanned += 1;

    for (const rule of rules) {
      let hits;
      try {
        // 传相对路径：带 scope 的规则靠它决定「这条文件该不该扫」。
        hits = rule.detect(text, rel);
      } catch {
        // 一条规则炸了不影响别的，但要计数——否则「规则失效」和「没有命中」
        // 也长一个样，而这两件事的后果完全不同。
        ruleErrors += 1;
        continue;
      }
      if (!hits || hits.length === 0) continue;

      if (!byRule.has(rule.id)) {
        byRule.set(rule.id, {
          key: rule.id,
          level: rule.level,
          cost: rule.cost,
          reversible: rule.reversible,
          action: rule.action,
          actionable: true,
          origin: rule.entry ? `entry:${rule.entry}` : `builtin:${rule.id}`,
          // 来自条目的规则，把主张与引文一起带出来：
          // 他要能一眼看到「这条为什么算坑」，而不是一个规则名。
          claim: rule.claim ?? null,
          quote: rule.quote ?? null,
          evidence: [],
          hits: 0,
        });
      }
      const cand = byRule.get(rule.id);
      // hits 是数组，但带 total：真实命中数不受「每文件最多列几个」限制
      cand.hits += hits.total ?? hits.length;
      for (const h of hits) {
        if (cand.evidence.length < maxEvidence) {
          cand.evidence.push({ file: rel, line: h.line, snippet: h.snippet });
        }
      }
    }
  }

  return {
    candidates: [...byRule.values()],
    stats: {
      files: scanned, skippedLarge,
      unreadable: unreadableFiles, unreadableDirs: errors,
      ruleErrors,
      rules: rules.length, fired: byRule.size,
    },
  };
}
