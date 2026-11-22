/**
 * 从别的工具接过来。
 *
 * 为什么要有这一层：采集不是这个工具该干的事。
 * 论文已经有 Agentero 在解析（PDF -> 文本，带质量标注），
 * 视频有别的工具在转录。proofline 不重做这些，只负责把它们产出的
 * 文本接住，变成可核的条目。
 *
 * 这也是 `source_extraction` 存在的意义：
 * 接过来的文本是二手的，得把「怎么来的」记下来。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

/**
 * Agentero 的 body_source -> 我们的 source_extraction。
 *
 * latex 算「原文」：它本身就是作者的源文件，不是对原件的识别结果。
 * ocr / pdf 都是抽取，中间隔着一道有损转换。
 */
function mapExtraction(bodySource) {
  // 只认字符串。以前用 String() 强转，["pdf"] 会被转成 "pdf" 然后当合法来源类型，
  // 类型不符却碰巧命中，等于替上游掩盖了结构错误。
  if (typeof bodySource !== 'string') return undefined;
  switch (bodySource.toLowerCase()) {
    case 'latex':
    case 'tex':
    case 'code':      // 直接读到源码，跟「原文」同一档
    case 'source':
      return '原文';
    case 'ocr':
      return 'OCR';
    case 'pdf':
    case 'text':
    case 'markdown':
      return 'PDF抽取';
    default:
      return undefined;
  }
}

/**
 * 把 source/*.tex 拼成一份快照。
 *
 * 用 `%% file: xxx.tex` 做分隔——这行在 LaTeX 里就是注释，
 * 所以拼出来的东西仍然是一份合法的 tex，不是凭空插进去的假内容。
 * 顺带一个好处：引文命中之后，能看出它来自哪个文件。
 */
async function concatTex(sourceDir) {
  let names;
  try {
    // 扩展名大小写不敏感；排序用数字感知，避免 1.tex / 10.tex / 2.tex 这种字典序错位
    names = (await readdir(sourceDir))
      .filter((n) => n.toLowerCase().endsWith('.tex'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (names.length === 0) return null;
  const parts = await Promise.all(
    names.map(async (n) => {
      const text = await readFile(join(sourceDir, n), 'utf8');
      // 单个 tex 文件可能带 BOM；留在快照里会变成 U+FEFF，影响引文匹配
      const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      return `%% file: ${n}\n${clean}`;
    }),
  );
  return parts.join('\n\n');
}

/**
 * 读一个 Agentero 论文目录，返回一份 spec（不含 claim / quotes / 判定）。
 *
 * @param {string} paperDir
 * @returns {Promise<object>}
 */
/**
 * 从代码目录建快照。
 *
 * 存在的理由：这个项目最要紧的事实来自代码，而不是论文。
 * 之前要把代码入库，得手搓一个假论文目录（metadata.json + PAPER.md 拼接），
 * 八次里有三次拼错文件名。那一层不该由人来做。
 *
 * 只收源码与依赖清单，不收编译产物、虚拟环境、图片。
 * 超大文件跳过但**记下来**——静默跳过等于假装读过。
 */

/** 认的源码扩展名。加上依赖清单的文件名，覆盖常见语言的工程。 */
const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.java', '.kt', '.go', '.rs', '.jl', '.r', '.sh', '.ps1',
]);

/** 没有扩展名但值得收的文件（依赖清单、构建脚本）。 */
const CODE_NAMES = new Set([
  'requirements.txt', 'environment.yml', 'pyproject.toml', 'setup.py',
  'package.json', 'tsconfig.json', 'cargo.toml', 'go.mod',
  'cmakelists.txt', 'makefile', 'dockerfile',
]);

/** 不收的目录：第三方依赖、缓存、构建产物、IDE。 */
const CODE_SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.idea', '.vscode', '.pytest_cache', 'site-packages',
]);

const CODE_MAX_BYTES = 512 * 1024;

async function collectCode(dir, root = dir, out = [], skipped = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    skipped.push({ path: dir, reason: `读不了：${err.code ?? err.message}` });
    return out;
  }

  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (CODE_SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
      await collectCode(full, root, out, skipped);
      continue;
    }
    if (!e.isFile()) continue;

    const lower = e.name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const ext = dot === -1 ? '' : lower.slice(dot);
    const picked = CODE_EXT.has(ext) || CODE_NAMES.has(lower);
    if (!picked) continue;

    const rel = full.slice(root.length + 1).replace(/\\/g, '/');
    let buf;
    try {
      buf = await readFile(full);
    } catch (err) {
      skipped.push({ path: rel, reason: `读不了：${err.code ?? err.message}` });
      continue;
    }
    if (buf.length > CODE_MAX_BYTES) {
      skipped.push({ path: rel, reason: `超过 ${Math.round(CODE_MAX_BYTES / 1024)} KB（${Math.round(buf.length / 1024)} KB），未收` });
      continue;
    }
    out.push({ rel, text: buf.toString('utf8') });
  }
  return out;
}

/**
 * @param {string} dir  代码目录
 * @param {{url?:string, title?:string}} [opts]
 */
export async function fromCodeDir(dir, opts = {}) {
  const skipped = [];
  const files = await collectCode(dir, dir, [], skipped);
  if (files.length === 0) {
    throw new Error(`这个目录里没有可收的源码：${dir}`);
  }

  // 按路径做数字感知排序：1.py, 2.py, 10.py，不是 1, 10, 2
  files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }));

  const snapshotText = files
    .map((f) => `%% file: ${f.rel}\n${f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text}`)
    .join('\n\n');

  const id = basename(dir);
  const spec = {
    snapshot_text: snapshotText,
    source_uri: opts.url?.trim() || `code:${id}`,
    source_kind: '项目',
    // 直接读到源码，跟「原文」同一档：中间没有有损转换
    source_extraction: '原文',
    // body_quality 只给展示用，createEntry 不消费；放在 spec 会被当成「没用的字段」警告
    added_at: new Date().toISOString().slice(0, 10),
  };

  Object.defineProperty(spec, '_meta', {
    value: {
      title: opts.title?.trim() || `代码：${id}`,
      snapshot_origin: `${files.length} 个源码文件拼成`,
      body_source: 'code',
      body_quality: 'high',
      files: files.length,
      skipped,
      issues: skipped.map((s) => `未收 ${s.path}（${s.reason}）`),
    },
    enumerable: false,
  });

  return spec;
}

export async function fromAgentero(paperDir) {
  let meta;
  try {
    meta = JSON.parse(await readFile(join(paperDir, 'metadata.json'), 'utf8'));
  } catch (err) {
    throw new Error(`读不到 metadata.json：${err.message}`);
  }

  // id 会拼进 `${id}.pdf`，所以不能直接信外部值：
  // "../../outside" 这种会把路径解析到论文目录之外。
  const rawId = meta.id;
  const idLooksSafe = typeof rawId === 'string' && /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*$/.test(rawId);
  const id = idLooksSafe ? rawId : basename(paperDir);
  const extraction = mapExtraction(meta.body_source);
  const issues = [];
  if (!idLooksSafe && rawId !== undefined) {
    issues.push(`metadata.id 不能用作文件名（${JSON.stringify(rawId)}），已退回目录名`);
  }
  if (extraction === undefined) {
    issues.push(`metadata.body_source ${JSON.stringify(meta.body_source ?? null)} 无法映射，source_extraction 未填`);
  }

  // 正文：优先 PAPER.md；LaTeX 来源没有 PAPER.md，退回拼 source/*.tex
  let snapshotText = null;
  let snapshotOrigin = null;
  try {
    snapshotText = await readFile(join(paperDir, 'PAPER.md'), 'utf8');
    snapshotOrigin = 'PAPER.md';
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    snapshotText = await concatTex(join(paperDir, 'source'));
    snapshotOrigin = snapshotText ? 'source/*.tex' : null;
  }
  if (!snapshotText) {
    throw new Error('这个论文目录里既没有 PAPER.md，也没有 source/*.tex');
  }

  const pdfPath = join(paperDir, `${id}.pdf`);
  // 写进条目的定位信息一律不含本机目录：
  // 原文是机器相关的，条目是要能被分享的。arXiv 有公开地址就用它。
  const onArxiv = meta.type === 'arxiv' && /^\d{4}\.\d{4,5}$/.test(id);
  // metadata 里给了 url 就用它——代码仓库有确定的地址，比文件名有意义
  const publicUri = typeof meta.url === 'string' && meta.url.trim()
    ? meta.url.trim()
    : onArxiv ? `https://arxiv.org/abs/${id}` : basename(pdfPath);
  const pdfName = basename(pdfPath);

  const gaps = [];
  if (meta.body_quality === 'low') {
    gaps.push({
      question: `正文是 ${meta.body_source} 抽出来的，质量标为 low，引用前应对照 PDF 原件核一遍`,
      action: 'fetch',
      locator: pdfName,
      blocking: false,
      dimension: 'evidence',
    });
  }
  if (extraction === '原文' && snapshotOrigin === 'source/*.tex') {
    gaps.push({
      question: 'LaTeX 源码里句子常被 \\cite{} / \\ref{} 打断，只能取不含命令的片段——已核过取出的引文语义完整吗',
      action: 'search',
      blocking: false,
      dimension: 'evidence',
    });
  }

  const spec = {
    snapshot_text: snapshotText,
    // 代码仓库不是「论文」：来源类型影响「二手要不要给原件」的判断
    source_kind: ['github', 'repo', 'code'].includes(meta.type) ? '项目' : '论文',
    source_uri: publicUri,
    source_original: extraction && extraction !== '原文' ? pdfName : undefined,
    source_extraction: extraction,
    gaps,
    added_at: new Date().toISOString().slice(0, 10),
  };

  // 展示用的元数据用 defineProperty 挂成不可枚举：
  // 这样对象展开、JSON.stringify 都不会把它带进 frontmatter，
  // 不再依赖调用方记得 `delete spec._meta`。
  Object.defineProperty(spec, '_meta', {
    value: {
      title: meta.title ?? null,
      authors: Array.isArray(meta.authors) ? meta.authors : [],
      body_source: typeof meta.body_source === 'string' ? meta.body_source : null,
      body_quality: typeof meta.body_quality === 'string' ? meta.body_quality : null,
      snapshot_origin: snapshotOrigin,
      issues,
    },
    enumerable: false,
  });

  return spec;
}
