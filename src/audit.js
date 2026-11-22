/**
 * 隐私自查。
 *
 * 这个工具天生会存别人的东西：引文、原件快照、佐证网页。所以它自己就是
 * 一个可能的泄露点。最常见的四类是：
 *
 *   绝对路径   暴露机器布局、用户名、装了哪些工具
 *   邮箱       原件里的第三方联系方式（论文 LaTeX 里经常整段作者邮箱）
 *   手机号     转录稿、聊天截图里最常见
 *   身份证号   截图或表格里偶发
 *
 * ## 为什么是「查」不是「改」
 *
 * 因为改了哈希就废。快照参与 sha256，删掉一个字，那条证据立刻失效。
 * 所以脱敏只能发生在**入库之前**，入库之后只能检查、只能整条作废。
 *
 * 这条约束不是缺陷，是这套东西的代价：**可核与可删，只能选一个。**
 * 选可核，那就得在选择的那一刻就想清楚要不要存。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const PATTERNS = [
  {
    kind: 'abs-path',
    label: '绝对路径',
    // \b 是关键：没有它，https:// 里的 s:/ 会被当成盘符
    re: /\b[A-Za-z]:[\\/][^\s"'),\]]{2,}|\/(?:home|Users)\/[^\s"'),\]]{2,}/g,
  },
  {
    kind: 'email',
    label: '邮箱',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: 'phone',
    label: '手机号',
    re: /\b1[3-9]\d{9}\b/g,
  },
  {
    kind: 'id-number',
    label: '身份证号',
    re: /\b\d{17}[\dXx]\b/g,
  },
  {
    // README 里承诺过 guard 会查「密钥」，但那时候 PATTERNS 只有四类，
    // 一个 sk- 开头的 key 走过两个检查器都不响。承诺了就得有，
    // 否则「文档说会拦」本身就是一种虚假安全感。
    //
    // 只认各家的固定前缀 + 足够长的随机串，宁可漏也不误报——
    // 把 `sk-learn` 这种当成密钥，会让人很快学会忽略这一条。
    kind: 'secret',
    label: '疑似密钥',
    // `sk-proj-` / `sk-ant-api03-` 这类带中缀的必须吃得下：
    // 最早的写法只允许一个可选的中缀词，`sk-proj-AbCd…` 会在 proj 后被 `-` 截断，
    // 结果最常见的 OpenAI 项目密钥一个都查不到，而报告照样说「干净」。
    // 中缀最多两段，每段 2–12 位；真正的随机串要 16 位以上才算。
    re: /\b(?:sk|pk|rk)[-_](?:[a-z0-9]{2,12}[-_]){0,2}[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/g,
  },
];

// 代码也要扫：送审、分享时最先出去的就是代码，里面写死一行本机路径很常见。
//
// .html / .htm 必须在内：这个库自己生成的「证据册」「课程地图」正是要发出去的东西，
// 旧清单里没有它们，于是 audit 对最该查的文件完全盲，还报「没有发现」。
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.jsonl', '.yaml', '.yml',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1',
  '.csv', '.tsv', '.ini', '.conf', '.cfg', '.properties', '.log',
  '.html', '.htm', '.ipynb', '.tex', '.xml', '.env',
]);

/** 无扩展名但常存敏感信息的文件。 */
const TEXT_NAMES = /^(?:\.env(?:\..+)?|\.gitconfig|\.npmrc|id_rsa|credentials)$/;

/** 单个文件上限：不设上限就是「大文件可能把进程撑死，而你以为扫过了」。 */
const MAX_BYTES = 4 * 1024 * 1024;

// 原文快照 / 原始材料：默认不参与隐私扫描（它们本来就不该被改）。
// 只认路径段，不认文件名——`entries/sources.json` 是登记表，不匹配这个。
const SNAPSHOT_RE = /(^|\/)(raw|sources)\//;

async function walk(dir, out = [], errors = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 读不了的目录要记账。静默跳过等于「扫过了，没问题」——
    // 而实际上根本没看，这是隐私自查里最坏的一种错。
    errors.push({ path: dir, code: err.code ?? 'UNKNOWN' });
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walk(full, out, errors);
      continue;
    }
    const dot = e.name.lastIndexOf('.');
    const ext = dot === -1 ? '' : e.name.slice(dot).toLowerCase();
    if (TEXT_EXT.has(ext) || TEXT_NAMES.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * @param {string} dir 要查的目录（通常是 entries）
 * @param {object} [opts]
 * @param {boolean} [opts.includeRaw] 连原文快照一起扫（默认跳过）
 * @returns {Promise<{findings:Array, stats:object}>}
 */
export async function auditDir(dir, { patterns = PATTERNS, maxSamples = 3, includeRaw = false } = {}) {
  const errors = [];
  const files = await walk(dir, [], errors);
  const findings = [];
  let scanned = 0;
  let skippedLarge = 0;
  let skippedRaw = 0;
  let ignoredTotal = 0;
  let unreadableFiles = 0;

  // 一处判定，两处使用：找 findings，以及判断「这一行被豁免，是不是真救了一条」。
  // 分开写就会打架——豁免数按原始正则算、命中按过滤后算，报出来的数对不上实际。
  //
  // 占位符不算泄漏：`C:\Users\<用户名>`、`D:/...` 这种本来就是给人看的模板。
  // 不放过它们，报告里会混进一堆「示范用的假路径」，真正那条本机路径反而被淹掉。
  const hitsIn = (text) => {
    const found = [];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m = text.match(p.re);
      if (!m) continue;
      if (p.kind === 'abs-path') {
        m = m.filter((x) => !/[<>{]|\.\.\./.test(x));
        if (m.length === 0) continue;
      }
      found.push({ pattern: p, matches: m });
    }
    return found;
  };

  for (const file of files) {
    let text;
    try {
      const buf = await readFile(file);
      if (buf.length > MAX_BYTES) { skippedLarge += 1; continue; }
      text = buf.toString('utf8');
    } catch {
      unreadableFiles += 1;
      continue;
    }
    const rel = relative(dir, file).replace(/\\/g, '/');

    // 原文快照和原始材料默认不扫。
    //
    // 这不是放过——是概念错位：快照的全部意义就是「原封不动」，
    // 里面出现作者邮箱、机构地址都是正常的，而它「改一个字哈希就废」，
    // 意味着你根本不能改。对着一份不能改的东西报「发现邮箱」，
    // 只能训练人忽略这份报告。
    //
    // 但它们确实会在整个库被打包带走时一起走，所以跳过要报数，并留 --all。
    if (!includeRaw && SNAPSHOT_RE.test(rel)) { skippedRaw += 1; continue; }

    scanned += 1;

    // 豁免必须写成**注释形式**，而且注释符前面只能是行首或空白：
    //   `// audit-ignore`、`# audit-ignore`、`<!-- audit-ignore`
    //
    // 两次收紧过：
    // 一、原来只要行里出现这个词就跳过，一句「…详见 audit-ignore 说明」的正文
    //    会把它自己和同一行的邮箱一起放过去 → 要求注释前缀。
    // 二、只要求前缀还不够：`const s = "# audit-ignore"; 联系 x@y.com` 里，
    //    引号内的 `#` 也被当成注释，照样能豁免同一行的真泄漏。
    //    现在要求注释符前面是行首或空白，字符串里的 `"# audit-ignore"` 不成立。
    const allLines = text.split('\n');
    const isIgnored = (line) => /(^|\s)(?:\/\/|#|<!--)\s*audit-ignore\b/.test(line);

    // 「本来会命中、被豁免掉」的行才算豁免。
    // 判据和 findings 用同一套命中函数（含占位符过滤）——
    // 拿原始正则单独判，会把只有占位符的模板行也算成豁免，报出一个虚高的数。
    let ignoredHere = 0;
    const kept = [];
    for (const line of allLines) {
      if (!isIgnored(line)) { kept.push(line); continue; }
      if (hitsIn(line).length > 0) ignoredHere += 1;
    }
    ignoredTotal += ignoredHere;
    const scannable = kept.join('\n');

    for (const { pattern: p, matches } of hitsIn(scannable)) {
      const uniq = [...new Set(matches)];
      findings.push({
        file: rel,
        kind: p.kind,
        label: p.label,
        count: matches.length,
        samples: uniq.slice(0, maxSamples),
      });
    }
  }

  // 同一个文件同一类问题合并成一行，按严重度排。
  // secret 必须有权重——漏了它，比较器得到 NaN，排序对新种类整体失效。
  const weight = { 'id-number': 0, secret: 1, phone: 2, email: 3, 'abs-path': 4 };
  findings.sort((a, b) => ((weight[a.kind] ?? 9) - (weight[b.kind] ?? 9)) || a.file.localeCompare(b.file));

  return {
    findings,
    stats: {
      files: scanned,
      hitFiles: new Set(findings.map((f) => f.file)).size,
      kinds: [...new Set(findings.map((f) => f.kind))],
      skippedLarge,
      skippedRaw,
      ignoredLines: ignoredTotal,
      unreadableFiles,
      unreadableDirs: errors.length,
      // 只要有一项没扫到，「没发现」就不能等同于「干净」
      complete: errors.length === 0 && unreadableFiles === 0 && skippedLarge === 0,
    },
  };
}
