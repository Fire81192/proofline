/**
 * 生成只读的证据册。
 *
 * ## 为什么是"产物"而不是"界面"
 *
 * 这个工具的写入方是 AI，不是人。做操作台会诱导人直接改判定，
 * 而判定恰恰是唯一必须由人负责的东西——点按钮不该等于下结论。
 *
 * 但"看"确实需要界面：一条证据天生是视觉的（一句话、一个位置、一张裁图）。
 * 所以做出来的是一份静态页面：能双击打开、能发给别人、能打印。
 *
 * ## 三条硬规矩
 *
 * 1. 只读。页面里没有任何写操作，也不连服务。
 * 2. 状态由 CLI 算好再渲染。页面不做任何计算——否则又会变成"同一事实两处算"。
 * 3. 不引入一行 JS。展开靠 <details>，坏不了、也留不住脚本。
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CHIP = {
  可判定: 'ok',
  可引用: 'warn',
  仅线索: 'muted',
  形状废: 'bad',
  在用: 'ok',
  可疑: 'warn',
  弃用: 'bad',
};

function chip(text, kind = CHIP[text] ?? 'muted') {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

function renderSourceBlock(src) {
  const items = src.claims.map((c) => `
        <li>
          <div class="cl">${esc(c.claim)}</div>
          <div class="cm">${esc(c.id)}</div>
        </li>`).join('');

  return `
    <div class="src">
      <div class="src-head">
        ${chip(src.status)}
        <span class="uri">${esc(src.uri)}</span>
      </div>
      <div class="src-meta">
        ${esc(src.extraction ?? '来源形态未填')}
        ${src.quality ? ` · 质量 ${esc(src.quality)}` : ''}
        · 支撑 ${src.count} 条
        ${src.reason ? ` · 弃用理由：${esc(src.reason)}` : ''}
      </div>
      <details>
        <summary>看它支撑的 ${src.count} 条主张</summary>
        <ul class="claimlist">${items}</ul>
      </details>
    </div>`;
}

function renderTreeNode(node) {
  // 退役的条目把「可引用 / 仅线索」这类判断换掉——那些标签描述的是
  // 它撑不撑得住，而退役说的是另一件事：撑得住，但不用了。
  const chips = node.retired
    ? chip('已退役') + chip('不可引用')
    : [
      // 用 citable 不用 evidence。
      //
      // evidence 只代表「引文还在快照里」，而 citable 还带着留痕和形状两道否决。
      // 以前这里读的是 evidence，于是留痕坏掉、或者条目被工具之外改过时，
      // HTML 上写着「可引用」，而同一个库的 status 说「不能引用」——
      // 一份本来要发出去给人看的证据册，比命令行更宽松。
      chip(node.citable ? '可引用' : (node.controlled === false ? '未受控' : '仅线索')),
      node.world === 'unresolved' ? chip('未定') : chip(node.world === 'supported' ? '已证' : node.world),
    ].join('');
  const quote = node.quotes.length
    ? `<div class="quote">「${esc(node.quotes[0])}」${node.quotes.length > 1 ? ` <span class="more">等 ${node.quotes.length} 条</span>` : ''}</div>`
    : '<div class="quote muted">没有引文</div>';
  const gap = node.blockingCount > 0
    ? `<div class="gap">卡在这：${esc(node.blockingList[0] ?? '')}${node.blockingCount > 1 ? ` （另有 ${node.blockingCount - 1} 条）` : ''}</div>`
    : '';

  return `
    <details class="node">
      <summary>
        <span class="dot ${node.retired ? 'gray' : node.blockingCount > 0 ? 'red' : node.decisive ? 'green' : 'amber'}"></span>
        <span class="claim${node.retired ? ' struck' : ''}">${esc(node.claim)}</span>
        <span class="tags">${chips}</span>
      </summary>
      <div class="node-body">
        ${quote}
        ${gap}
        ${node.retired ? `<div class="gap">已退役 · ${esc(node.retiredNote)}</div>` : ''}
        <div class="kv"><b>类型</b>${esc(node.kind)} · <b>层级</b>${esc(node.layer)} · <b>依据</b>${esc(node.basis ?? '未填')}${node.basis === '判断' ? '（推的，不可当依据）' : ''} · <b>编号</b>${esc(node.id)}</div>
        ${node.notFor && node.notFor.length ? `<div class="gap">不能用来：${node.notFor.map(esc).join('；')}</div>` : ''}
        ${node.value ? `<div class="kv"><b>数值</b>${esc(String(node.value.number))} ${esc(node.value.unit ?? '')} · ${esc(node.value.scope ?? '')}${node.value.effective_from ? `（${esc(node.value.effective_from)} 起）` : ''}</div>` : ''}
        ${node.prereq.length ? `<div class="kv"><b>前置</b>${node.prereq.map(esc).join(' → ')}</div>` : ''}
      </div>
    </details>`;
}

function dotOf(node) {
  if (node.blockingCount > 0) return 'red';
  if (node.decisive) return 'green';
  return 'amber';
}

/**
 * 一棵递归的树。有子节点的才可展开，没子节点的就是个条目行。
 * 缩进用左侧竖线表示层级——比纯空白好读，也比力导向图抗规模。
 */
function renderMapNode(node, depth, lookup) {
  const view = lookup.get(node.id);
  const claim = view?.claim ?? node.claim;
  const dot = view ? dotOf(view) : 'amber';
  const kids = node.children;

  const body = `
      <div class="node-body">
        ${view?.quotes?.length ? `<div class="quote">「${esc(view.quotes[0])}」</div>` : '<div class="quote muted">没有引文</div>'}
        ${view && view.blockingCount > 0 ? `<div class="gap">卡在这：${esc(view.blockingList[0] ?? '')}</div>` : ''}
        <div class="kv"><b>来源</b>${esc(view?.source ?? '未登记')}</div>
        ${node.prereq.length ? `<div class="kv"><b>前置</b>${node.prereq.map((x) => esc(x)).join(' → ')}</div>` : ''}
        ${node.children.length ? `<div class="kv"><b>学完可接</b>${node.children.length} 条</div>` : ''}
      </div>`;

  const head = `<span class="dot ${dot}"></span><span class="claim">${esc(claim)}</span>`;

  if (kids.length === 0) {
    return `<div class="leaf" style="margin-left:${depth * 18}px">${head}</div>`;
  }
  return `<details class="branch-node" style="margin-left:${depth * 18}px"${depth === 0 ? ' open' : ''}>
      <summary>${head}</summary>
      ${body}
      ${kids.map((k) => renderMapNode(k, depth + 1, lookup)).join('')}
    </details>`;
}

/**
 * @param {object} args
 * @param {Array} args.entries  已算好的条目视图
 * @param {Array} args.sources  来源概览
 * @param {object} args.stats   统计
 * @param {string} args.generatedAt
 * @param {boolean} [args.served]  由服务渲染时改一下抬头，别把快照说成实时
 * @returns {string} 完整 HTML
 */
export function renderView({ entries, sources, stats, generatedAt, served = false, forest = null }) {
  // 地图节点只有 id/claim/prereq，状态与引文从 entries 里查
  const lookup = new Map(entries.map((e) => [e.id, e]));

  const bySource = new Map();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }

  const tree = [...bySource.entries()].map(([uri, list]) => {
    const src = sources.find((s) => s.uri === uri);
    return `
    <div class="branch">
      <div class="branch-head">
        ${src ? chip(src.status) : chip('在用')}
        <span class="uri">${esc(uri)}</span>
        <span class="count">${list.length} 条</span>
      </div>
      ${list.map(renderTreeNode).join('')}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>proofline · 证据册</title>
<style>
  :root{
    --bg:#fbfaf7; --panel:#fff; --ink:#1b1a17; --ink2:#57534b; --ink3:#8e897f;
    --line:#e6e2d8; --ok:#3f6f52; --warn:#a8762a; --bad:#9c3d3d; --muted:#8e897f;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#141413;--panel:#1c1c1a;--ink:#eeece6;--ink2:#aca79d;--ink3:#79746b;
          --line:#2d2c28;--ok:#7fb894;--warn:#d9a85e;--bad:#e08b8b;--muted:#79746b;}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:56px 26px 100px}
  h1{font-size:30px;letter-spacing:-.02em;margin:0 0 8px;font-weight:660}
  .sub{color:var(--ink3);font-size:14px;margin-bottom:34px}
  .live{display:inline-block;color:var(--ok);font-weight:600}
  .live::before{content:"● ";font-size:10px;vertical-align:2px}
  h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3);
     margin:52px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
        background:var(--line);border:1px solid var(--line);margin:26px 0 0}
  .nums div{background:var(--panel);padding:16px 18px}
  .nums .n{font-size:26px;font-weight:660;line-height:1.15}
  .nums .l{font-size:12px;color:var(--ink3);margin-top:2px}

  .chip{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;
        border:1px solid currentColor;line-height:1.7;white-space:nowrap}
  .chip.ok{color:var(--ok)} .chip.warn{color:var(--warn)}
  .chip.bad{color:var(--bad)} .chip.muted{color:var(--muted)}

  .src{background:var(--panel);border:1px solid var(--line);border-radius:8px;
       padding:16px 18px;margin-bottom:10px}
  .src-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .uri{font-family:var(--mono);font-size:13px;word-break:break-all;color:var(--ink2)}
  .src-meta{font-size:12.5px;color:var(--ink3);margin-top:6px}
  details summary{cursor:pointer;font-size:13px;color:var(--ink3);margin-top:10px;list-style:none}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▸ ";color:var(--ink3)}
  details[open] summary::before{content:"▾ "}
  .claimlist{margin:10px 0 0;padding-left:18px;font-size:13.5px;color:var(--ink2)}
  .claimlist li{margin-bottom:8px}
  .cl{line-height:1.6}
  .cm{font-family:var(--mono);font-size:11.5px;color:var(--ink3)}

  .branch{margin-bottom:22px}
  .branch-head{display:flex;align-items:center;gap:10px;padding:8px 0;flex-wrap:wrap}
  .count{font-size:12px;color:var(--ink3)}

  .node{background:var(--panel);border:1px solid var(--line);border-radius:8px;
        padding:12px 14px;margin:8px 0 8px 14px;border-left:2px solid var(--line)}
  .node > summary{display:flex;align-items:flex-start;gap:9px;margin:0;color:var(--ink);font-size:14.5px}
  .dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;margin-top:8px}
  .dot.red{background:var(--bad)} .dot.green{background:var(--ok)} .dot.amber{background:var(--warn)}
  .dot.gray{background:var(--muted)}
  /* 退役的条目划掉主张，一眼能看出这条已经不用了——不是靠读状态行判断。 */
  .claim.struck{text-decoration:line-through;text-decoration-thickness:1px;opacity:.62}
  .claim{flex:1;line-height:1.55}
  .tags{flex:0 0 auto;display:flex;gap:5px}
  .node-body{margin-top:12px;font-size:13.5px;color:var(--ink2);line-height:1.7}
  .quote{border-left:2px solid var(--line);padding-left:12px;color:var(--ink2);font-style:normal}
  .quote.muted{color:var(--ink3)}
  .more{color:var(--ink3);font-size:12px}
  .gap{margin-top:8px;color:var(--bad);font-size:13px}
  .kv{margin-top:10px;font-size:12px;color:var(--ink3);font-family:var(--mono)}
  .kv b{font-family:inherit;font-weight:600;color:var(--ink3);margin-right:3px}

  .note{font-size:13px;color:var(--ink3);border-left:2px solid var(--line);padding-left:14px;margin-top:14px}

  .legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12.5px;color:var(--ink3);margin:0 0 18px}
  .legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:1px}
  .legend .sep{color:var(--line)}
  .map{margin:6px 0 8px}
  .map .leaf,.map summary{display:flex;align-items:flex-start;gap:9px;font-size:14.5px;line-height:1.6;
    padding:7px 10px;border-radius:6px;background:var(--panel);border:1px solid var(--line);
    border-left:2px solid var(--accent);margin:6px 0;color:var(--ink);list-style:none;cursor:default}
  .map summary{cursor:pointer}
  .map summary::-webkit-details-marker{display:none}
  .map summary::after{content:"展开";margin-left:auto;font-size:11px;color:var(--ink3);flex:0 0 auto}
  .map details[open] > summary::after{content:"收起"}
  .branch-node{margin-left:0}
  .branch-node > .leaf,.branch-node > details{margin-left:0}
  .orphan-box{margin-top:22px;padding:16px 18px;border:1px dashed var(--line);border-radius:8px}
  .orphan-title{font-size:13.5px;font-weight:640;color:var(--warn);margin-bottom:4px}
  .orphan-sub{font-size:12.5px;color:var(--ink3);margin-bottom:10px;line-height:1.6}
  code{font-family:var(--mono);font-size:.88em;background:var(--line);padding:1px 5px;border-radius:3px}
  footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);
         font-size:12.5px;color:var(--ink3);line-height:1.8}
  @media (max-width:680px){
    h1{font-size:24px} .wrap{padding:36px 18px 70px}
    .node{padding:10px 12px}
    .node > summary{flex-wrap:wrap}
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>证据册</h1>
  <div class="sub">
    ${served ? '<span class="live">现算</span> · 每次刷新都重新读库 · ' : '只读快照 · '}
    这一页生成于 ${esc(generatedAt)} · 所有状态由命令行算好，本页不做任何计算
  </div>

  <div class="nums">
    <div><div class="n">${stats.entries}</div><div class="l">条主张</div></div>
    <div><div class="n">${stats.sources}</div><div class="l">个来源</div></div>
    <div><div class="n">${stats.citable}</div><div class="l">条可引用</div></div>
    <div><div class="n">${stats.decisive}</div><div class="l">条可判定</div></div>
    <div><div class="n">${stats.blocking}</div><div class="l">条卡住</div></div>
    <div><div class="n">${stats.rules}</div><div class="l">条检查规则</div></div>
    ${stats.uncontrolled > 0 ? `<div><div class="n" style="color:#b42318">${stats.uncontrolled}</div><div class="l">条未受控</div></div>` : ''}
  </div>
  ${stats.uncontrolled > 0 ? `<p style="color:#b42318"><b>有 ${stats.uncontrolled} 条未受控。</b>
  它们的内容没经过入库闸门（没有留痕记录，或与记录不符），所以不计入「可引用」——
  这条账上写着「可引用」，但引用它的那一刻它已经不是原来那条了，这比没有更糟。</p>` : ''}

  <h2>一 · 知识地图</h2>
  ${forest ? `
  <div class="legend">
    <span><i class="dot green"></i>可判定</span>
    <span><i class="dot amber"></i>只到「有人说过」</span>
    <span><i class="dot red"></i>有阻塞缺口</span>
    <span class="sep">·</span>
    <span>缩进 = 前置关系：上面学完才轮到下面</span>
  </div>
  ${forest.cycles.length ? `<div class="gap">发现循环依赖：${forest.cycles.map((c) => c.map(esc).join(' → ')).join('；')}</div>` : ''}
  ${forest.broken.length ? `<div class="gap">断链（前置指向不存在的条目）：${forest.broken.map((b) => `${esc(b.from)} → ${esc(b.to)}`).join('；')}</div>` : ''}
  <div class="map">
    ${forest.roots.filter((r) => !forest.orphans.includes(r.id)).map((r) => renderMapNode(r, 0, lookup)).join('') || '<div class="note">还没有任何前置关系。</div>'}
  </div>
  ${forest.orphans.length ? `
  <div class="orphan-box">
    <div class="orphan-title">还没接线：${forest.orphans.length} 条</div>
    <div class="orphan-sub">这些条目既没有前置、也没有人依赖它。它们不是错的，只是还没被放进任何一条学习路径里。</div>
    <div class="map">${forest.orphans.map((id) => {
      const v = lookup.get(id);
      return `<div class="leaf"><span class="dot ${v ? dotOf(v) : 'amber'}"></span><span class="claim">${esc(v?.claim ?? id)}</span></div>`;
    }).join('')}</div>
  </div>` : ''}
  <div class="note">实线 ${forest.edges} 条。孤点比连着的内容多，说明这张图现在还是一堆散件——填 prereq 就是在把它接起来。</div>
  ` : ''}

  <h2>二 · 这个库靠什么撑着</h2>
  ${sources.map(renderSourceBlock).join('')}
  <div class="note">
    弃用一份材料会让它支撑的主张全部失去证据，且不可恢复。先看后果：
    <code>proofline deprecate "&lt;来源&gt;" --reason "为什么"</code>
  </div>

  <h2>三 · 按来源看</h2>
  <div class="note" style="margin:0 0 14px">
    按来源分组。绿点＝可判定，黄点＝只到「有人这么说过」，红点＝有阻塞缺口。
    点开任何一条，能看到它的引文和卡在哪。
  </div>
  ${tree || '<div class="note">还没有条目。</div>'}

  <h2>四 · 进度</h2>
  <div class="src">
    <div class="src-meta" style="font-size:13.5px;line-height:2">
      条目 ${stats.entries} 条，其中 ${stats.citable} 条可引用、${stats.decisive} 条可判定、${stats.blocking} 条有阻塞缺口。<br>
      来源 ${stats.sources} 个，${stats.deprecated} 个被标为可疑或弃用。<br>
      检查规则 ${stats.rules} 条（内置 ${stats.builtinRules} + 库里 ${stats.libraryRules}）。
    </div>
  </div>
  <div class="note">
    这些数字都是现场算的，不是人工填的。手维护的进度表两周后就没人更新了。
  </div>

  <footer>
    专业代理层 · proofline<br>
    本页是快照，重新生成请跑 <code>proofline view</code>
  </footer>
</div>
</body>
</html>`;
}
