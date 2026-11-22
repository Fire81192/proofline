/**
 * 扁平 frontmatter 读写。
 *
 * 刻意只支持 `key: value` 一层，不支持嵌套。
 * 理由不是懒：嵌套 YAML 一进来，就得引 yaml 库；引了库，这个工具就不能
 * 零依赖跑在裸 Node 上。而且嵌套字段对读文件的 agent 没有任何好处。
 *
 * 多值字段写成一行 JSON 数组：
 *   quotes: ["第一句", "第二句"]
 *
 * 解析顺序（值部分）：
 *   以 " 开头   -> JSON 字符串
 *   以 [ 开头   -> JSON 数组
 *   true/false/null -> 字面量
 *   纯数字      -> number
 *   其余        -> 原样字符串（去掉首尾空白）
 *
 * 写回时，凡是会被误读成上面几种的字符串，自动加引号。
 */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class FrontmatterError extends Error {}

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch (err) {
      throw new FrontmatterError(`引号开头的值不是合法 JSON 字符串：${v.slice(0, 60)}（${err.message}）`);
    }
  }
  // 以 [ 开头有两种可能：JSON 数组，或者主张本身以方括号开头（`[实验] 结论…`）。
  // 只有「[ 开头且以 ] 结尾」才当数组解析；否则就是普通字符串。
  // 这样 `[实验] 某结论` 不会被误判成坏数组。
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      return JSON.parse(v);
    } catch (err) {
      throw new FrontmatterError(`数组值不是合法 JSON：${v.slice(0, 60)}（${err.message}）`);
    }
  }
  // 同一条道理用在对象上：首尾都是 {} 才试着当结构解析。
  // 存在的理由和数组一样——一组相关的字段如果拆成三个平级 key，
  // 就会出现「有 at 没 reason」这种中间态，而那些中间态没有校验就只能靠约定。
  // 结构挡得住，约定挡不住。
  //
  // 但**解析失败必须退回字符串，不能抛错**。第一版是抛错的，
  // 于是 `claim: {A}+{B}` 这种普通文本会让整个条目读不了——
  // 为一个字段加的功能，代价是所有字段都变脆。这条是外部审核抓到的。
  if (v.startsWith('{') && v.endsWith('}')) {
    try {
      const parsed = JSON.parse(v);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 不是 JSON 就是普通文本，原样返回
    }
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function needsQuote(str) {
  if (str === '') return true;
  if (/^\s|\s$/.test(str)) return true;
  if (/^["\[{]/.test(str)) return true;
  if (['true', 'false', 'null'].includes(str)) return true;
  if (/^-?\d+(\.\d+)?$/.test(str)) return true;
  if (/[\r\n]/.test(str)) return true;
  return false;
}

function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  // 普通对象序列化成一行 JSON。字段顺序由调用方保证（JSON.stringify 保插入序），
  // 所以同一份数据写出来仍然字节一致。
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return needsQuote(value) ? JSON.stringify(value) : value;
  if (value === null) return 'null';
  return String(value);
}

/**
 * @returns {{data: Record<string, any>, body: string}}
 * 没有 frontmatter 时 data 为空对象，body 是全文。
 */
export function parseFrontmatter(raw) {
  // Windows 编辑器常给 UTF-8 加 BOM。不去掉的话 `---` 匹配不上，
  // 整份文件会被当成「没有 frontmatter」而拒绝——错得很像数据坏了。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text };

  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      throw new FrontmatterError(`第 ${i + 1} 行有缩进，扁平格式不支持嵌套`);
    }
    const at = line.indexOf(':');
    if (at === -1) {
      throw new FrontmatterError(`第 ${i + 1} 行没有冒号：${line.slice(0, 40)}`);
    }
    const key = line.slice(0, at).trim();
    if (!key) throw new FrontmatterError(`第 ${i + 1} 行 key 为空`);
    if (key in data) throw new FrontmatterError(`重复的 key：${key}`);
    data[key] = parseValue(line.slice(at + 1));
  }
  return { data, body: text.slice(m[0].length) };
}

/** 按固定顺序渲染 frontmatter，保证同一份数据写出来字节一致。 */
export function renderFrontmatter(data, keyOrder = []) {
  const keys = [
    ...keyOrder.filter((k) => k in data),
    ...Object.keys(data).filter((k) => !keyOrder.includes(k)),
  ];
  const lines = keys.map((k) => `${k}: ${formatValue(data[k])}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function joinFrontmatter(data, body, keyOrder = []) {
  const fm = renderFrontmatter(data, keyOrder);
  const trimmed = body.replace(/^\r?\n+/, '');
  return trimmed ? `${fm}\n${trimmed}` : fm;
}

/**
 * 只替换一个字段的文本，不碰其余任何字节。
 * 对应 MasterVault 的 surgical_replace_field：修一个字段不该重排整个文件。
 * 字段不存在时追加到最后一行。
 */
export function replaceField(text, key, value) {
  const m = FM_RE.exec(text);
  if (!m) throw new FrontmatterError('文件没有 frontmatter，无法定点替换');
  const rendered = `${key}: ${formatValue(value)}`;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((line) => {
    const colon = line.indexOf(':');
    return colon > 0 && line.slice(0, colon).trim() === key;
  });
  if (at === -1) lines.push(rendered);
  else lines[at] = rendered;
  const rest = text.slice(m[0].length);
  return `---\n${lines.join('\n')}\n---\n${rest}`;
}
