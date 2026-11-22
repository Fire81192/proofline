/**
 * 课程地图页面。
 *
 * 一页里两个层次，视觉上分开：
 *   结构（项目需要什么）—— 灰底、细线，任何做这个项目的人都一样
 *   进度（我到哪了）    —— 只在有 progress.json 时上色
 *
 * 没有进度数据时，页面照样完整可读——那正是"结构独立"的证明。
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_CLASS = { 缺口: 'bad', 未修: 'muted', 在修: 'live', 已修: 'ok', 自学: 'muted' };
const chip = (t, c) => `<span class="chip ${c}">${esc(t)}</span>`;

function renderBlock(b, report, entryStatus) {
  const needs = (b.needs ?? []).map((id) => {
    const d = report.domainById.get(id);
    if (!d) return `<span class="dchip bad">${esc(id)}</span>`;

    // 技术/语言：有没有「到几级」比「学没学过」更有意义
    if (d.kind !== '学科') {
      const need = (b.needLevels ?? {})[id];
      const mine = report.bySkill.get(id);
      const short = need && mine ? mine.level < need : false;
      const cls = !need ? 'plain' : short ? 'bad' : mine ? 'ok' : 'plain';
      return `<span class="dchip ${cls}">${esc(d.name)}${need ? ` <b>L${need}</b>` : ''}</span>`;
    }

    const prog = report.byDomain.get(id);
    const cls = prog ? (STATUS_CLASS[prog.status] ?? 'muted') : 'plain';
    return `<span class="dchip ${cls}">${esc(d.name)}</span>`;
  }).join('');

  // 手写地图常见手滑：entries 写成字符串或数字。
  // analyze 会把它报成 problem，但渲染仍然会跑到这里——
  // 直接 .map 就是「一份坏数据把整个命令变成内部错误」，那比出一张残图更糟：
  // 残图至少能看，崩溃只能看堆栈。
  const entries = (Array.isArray(b.entries) ? b.entries : []).map((eid) => {
    const st = entryStatus.get(eid);
    const dot = !st ? 'muted' : st.blockingCount > 0 ? 'red' : st.decisive ? 'green' : 'amber';
    return `<div class="el"><span class="dot ${dot}"></span>${esc(st?.claim ?? eid)}</div>`;
  }).join('');

  return `
    <div class="block">
      <div class="block-head">
        <span class="block-name">${esc(b.name)}</span>
        ${chip(b.basis, `b-${b.basis}`)}
      </div>
      ${needs ? `<div class="dchips">${needs}</div>` : '<div class="dchips muted">不需要专门知识</div>'}
      ${b.gap ? `<div class="bgap">${esc(b.gap)}</div>` : ''}
      ${b.run ? `<div class="brun">复现脚本：${esc(b.run)}</div>` : ''}
      ${entries
        ? `<details><summary>库里 ${(b.entries ?? []).length} 条材料</summary><div class="entries">${entries}</div></details>`
        : '<div class="el muted" style="margin-top:9px">库里还没有材料</div>'}
    </div>`;
}

function renderDomain(d, report, depth, seen) {
  if (seen.has(d.id)) return '';
  seen.add(d.id);

  const prog = report.byDomain.get(d.id);
  const na = d.role === '背景';
  const kids = report.domains.filter((x) => (x.prereq ?? []).includes(d.id));
  const pts = report.points.filter((p) => p.domain === d.id);

  const tb = prog?.textbook;
  const tbLine = tb && tb.title && tb.title !== '未录'
    ? `<div class="tb">教材：${esc(tb.title)}${tb.edition ? ` · ${esc(tb.edition)}` : ''}${tb.isbn ? ` · ISBN ${esc(tb.isbn)}` : ' · ISBN 未录'}</div>`
    : '';

  const body = `
    <div class="dbody">
      ${d.why ? `<div class="dwhy">${esc(d.why)}</div>` : ''}
      ${pts.length ? `<div class="dpoints">${pts.map((p) => {
        const g = report.byPoint.get(p.id);
        // 虚线圈 = 这条要求是我按生态推的，没有原文；实线 = 论文里能定位到
        const cls = [g ? 'bad' : 'plain', p.basis === '判断' ? 'guess' : ''].filter(Boolean).join(' ');
        const tip = [p.need, p.basis ? `依据：${p.basis}` : '', g?.note].filter(Boolean).join(' ｜ ');
        return `<span class="pchip ${cls}" title="${esc(tip)}">${esc(p.name)}</span>`;
      }).join('')}</div>` : ''}
      ${na ? '<div class="dna">背景知识：对本项目不是主线，不参与出口检查</div>' : ''}
      ${prog?.note ? `<div class="dnote">${esc(prog.note)}</div>` : ''}
      ${tbLine}
      <div class="dkv">${esc(d.id)}${prog?.localName ? ` · 本校叫「${esc(prog.localName)}」` : ''}</div>
    </div>`;

  const head = `<span class="dname">${esc(d.name)}</span>
    ${prog ? chip(prog.status, STATUS_CLASS[prog.status] ?? 'muted') : ''}
    ${na ? chip('背景', 'muted') : ''}`;

  const cls = `dnode${na ? ' na' : ''}`;
  if (kids.length === 0) {
    return `<div class="${cls} leaf" style="margin-left:${depth * 20}px">${head}${body}</div>`;
  }
  return `<details class="${cls}" style="margin-left:${depth * 20}px"${depth === 0 ? ' open' : ''}>
      <summary>${head}</summary>${body}
      ${kids.map((k) => renderDomain(k, report, depth + 1, seen)).join('')}
    </details>`;
}

/**
 * 一个技术/语言域：能力刻度 + 需求位置 + 我现在的水平。
 *
 * 刻度写在结构里（这个项目怎么算「会」），我的等级写在 progress 里。
 * 两者分开，所以删掉 progress 这张卡照样显示刻度，只是没有「我到哪」。
 */
function renderTech(d, report) {
  const need = report.requiredLevels.get(d.id) ?? 0;
  const mine = report.bySkill.get(d.id);
  const na = d.role === '备选';

  const ladder = (d.levels ?? []).length === 0
    ? '<div class="tempty">暂无刻度——现在没有任何来源需要它，列在这里只为占位。</div>'
    : `<ol class="ladder">${d.levels.map((lv) => {
      const met = mine && mine.level >= lv.n;
      const cur = mine && mine.level === lv.n;
      const isNeed = need === lv.n;
      const cls = [met ? 'met' : 'unmet', cur ? 'cur' : '', isNeed ? 'need' : ''].filter(Boolean).join(' ');
      // 同一级的「具体要会什么」，来自 points 里 level 相同的那些
      const at = report.points.filter((p) => p.domain === d.id && p.level === lv.n);
      return `<li class="${cls}">
          <span class="ln">L${lv.n}</span>
          <span class="lt">${esc(lv.text)}</span>
          ${isNeed ? '<span class="mark need-mark">项目要到这里</span>' : ''}
          ${cur ? '<span class="mark cur-mark">我在这</span>' : ''}
          ${at.length ? `<div class="lp">${at.map((p) => `<span class="pchip ${p.basis === '判断' ? 'guess' : 'plain'}" title="${esc([p.need, p.basis ? `依据：${p.basis}` : ''].filter(Boolean).join(' ｜ '))}">${esc(p.name)}</span>`).join('')}</div>` : ''}
        </li>`;
    }).join('')}</ol>`;

  const mineLine = !mine
    ? '<div class="tunknown">没填等级——判断不了够不够</div>'
    : `<div class="tmine${mine.level < need ? ' short' : ''}">
        我现在 L${mine.level}${mine.estimated ? '（估）' : ''}${need ? ` · 需要 L${need}` : ''}
        ${mine.level < need ? ` · 差 ${need - mine.level} 级` : need ? ' · 够了' : ''}
        ${mine.note ? `<div class="tnote">${esc(mine.note)}</div>` : ''}
       </div>`;

  return `<div class="tech${na ? ' na' : ''}">
    <div class="tech-head">
      <span class="tname">${esc(d.name)}</span>
      ${chip(d.kind, 'muted')}
      ${na ? chip('备选', 'muted') : ''}
      ${need ? chip(`需要 L${need}`, 'live') : ''}
    </div>
    ${d.why ? `<div class="twhy">${esc(d.why)}</div>` : ''}
    ${ladder}
    ${mineLine}
    <div class="tbase">依据：${esc(d.basis ?? '判断')}${d.basisNote ? ` · ${esc(d.basisNote)}` : ''}</div>
  </div>`;
}

export function renderCurriculum({ report, entryStatus, generatedAt, served = false }) {
  const subjects = report.domains.filter((d) => d.kind === '学科');
  const techs = report.domains.filter((d) => d.kind === '技术');
  const langs = report.domains.filter((d) => d.kind === '语言');
  // 树的根只从学科里找；技术与语言有各自的前置，但不和学科混排
  const roots = subjects.filter((d) => (d.prereq ?? []).every((p) => !report.domainById.has(p)));
  const seen = new Set();
  const gapPoints = report.points.filter((p) => report.byPoint.has(p.id));
  const gapDomains = report.domains.filter((d) => report.byDomain.get(d.id)?.status === '缺口');
  // 这些数只在 analyze() 里算一次，页面直接读
  const c = report.counts;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>课程地图 · ${esc(report.goal)}</title>
<style>
  :root{
    --bg:#fbfaf7; --panel:#fff; --ink:#1b1a17; --ink2:#57534b; --ink3:#8e897f;
    --line:#e6e2d8; --ok:#3f6f52; --warn:#a8762a; --bad:#9c3d3d; --live:#3d5a80; --muted:#8e897f;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#141413;--panel:#1c1c1a;--ink:#eeece6;--ink2:#aca79d;--ink3:#79746b;
          --line:#2d2c28;--ok:#7fb894;--warn:#d9a85e;--bad:#e08b8b;--live:#8fb0d8;--muted:#79746b;}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:56px 26px 110px}
  .goal{font-size:13px;letter-spacing:.18em;color:var(--ink3);text-transform:uppercase;margin-bottom:14px}
  h1{font-size:33px;line-height:1.3;letter-spacing:-.02em;margin:0 0 10px;font-weight:660}
  .sub{color:var(--ink3);font-size:14px;margin-bottom:14px}
  .split{font-size:13px;color:var(--ink3);border-left:2px solid var(--line);padding-left:14px;margin:0 0 36px;line-height:1.7}
  .split b{color:var(--ink2)}
  h2{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3);
     margin:56px 0 18px;padding-bottom:9px;border-bottom:1px solid var(--line)}

  .chip{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;
        border:1px solid currentColor;line-height:1.7;white-space:nowrap}
  .chip.ok{color:var(--ok)} .chip.warn{color:var(--warn)} .chip.bad{color:var(--bad)}
  .chip.muted{color:var(--muted)} .chip.live{color:var(--live)}
  .b-判断{color:var(--bad)} .b-条目{color:var(--ok)} .b-实测{color:var(--live)}
  .brun{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:6px}

  .blocks{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
  .block{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:15px 16px}
  .block-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .block-name{font-size:15.5px;font-weight:650}
  .dchips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px}
  .dchip{font-size:11.5px;padding:1px 7px;border-radius:4px;background:var(--line);color:var(--ink2)}
  .dchip.bad{border:1px solid var(--bad);color:var(--bad);background:transparent}
  .dchip.live{border:1px solid var(--live);color:var(--live);background:transparent}
  .dchip.ok{border:1px solid var(--ok);color:var(--ok);background:transparent}
  .dchip.plain{background:var(--line);color:var(--ink2)}
  .bgap{font-size:12.5px;color:var(--ink3);line-height:1.6;border-left:2px solid var(--line);padding-left:9px}
  details summary{cursor:pointer;font-size:12.5px;color:var(--ink3);list-style:none;margin-top:9px}
  details summary::-webkit-details-marker{display:none}
  details summary::before{content:"▸ ";color:var(--ink3)}
  details[open] summary::before{content:"▾ "}
  .entries{margin-top:8px;display:flex;flex-direction:column;gap:5px}
  .el{font-size:12.5px;color:var(--ink2);display:flex;gap:7px;align-items:flex-start;line-height:1.55}
  .el.muted{color:var(--ink3)}
  .dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;margin-top:7px}
  .dot.green{background:var(--ok)} .dot.amber{background:var(--warn)}
  .dot.red{background:var(--bad)} .dot.muted{background:var(--muted)}

  .dnode{margin:7px 0;background:var(--panel);border:1px solid var(--line);border-radius:8px;
         padding:12px 14px;border-left:2px solid var(--line)}
  .dnode.na{opacity:.62}
  .dnode > summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-size:15px;color:var(--ink)}
  .dname{font-weight:640}
  .dbody{margin-top:9px;font-size:12.5px;color:var(--ink3);line-height:1.7}
  .dwhy{color:var(--ink2)}
  .dpoints{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .pchip{font-size:11.5px;padding:1px 7px;border-radius:4px;background:var(--line);color:var(--ink2)}
  .pchip.bad{border:1px solid var(--bad);color:var(--bad);background:transparent}
  .pchip.guess{border:1px dashed var(--ink3);background:transparent;color:var(--ink2)}
  .dna{margin-top:6px;color:var(--ink3);font-style:italic}
  .dnote{margin-top:6px;color:var(--warn)}
  .tb{margin-top:6px;font-family:var(--mono);font-size:11.5px;color:var(--ink3)}
  .dkv{margin-top:6px;font-family:var(--mono);font-size:11px;color:var(--ink3)}

  .dchip b{font-weight:700;opacity:.85}
  .techgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
  .tech{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:15px 16px}
  .tech.na{opacity:.7}
  .tech-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px}
  .tname{font-size:15.5px;font-weight:650}
  .twhy{font-size:12.5px;color:var(--ink2);line-height:1.65;margin-bottom:11px}
  .ladder{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
  .ladder li{position:relative;padding:5px 0 5px 14px;font-size:12.5px;color:var(--ink3);line-height:1.6}
  .ladder li::before{content:"";position:absolute;left:-5px;top:11px;width:8px;height:8px;
    border-radius:50%;background:var(--bg);border:1px solid var(--line)}
  .ladder li.met::before{background:var(--ok);border-color:var(--ok)}
  .ladder li.met{color:var(--ink2)}
  .ladder li.cur{color:var(--ink)}
  .ladder li.cur::before{box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent)}
  .lp{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
  .lp .pchip{font-size:11px}
  .ladder li.met .lp .pchip{opacity:.72}
  .ladder li.need .lt{text-decoration:underline;text-decoration-color:var(--live);
    text-underline-offset:3px;text-decoration-thickness:1px}
  .ln{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-right:7px}
  .mark{font-size:10.5px;padding:0 6px;border-radius:99px;margin-left:6px;white-space:nowrap}
  .need-mark{color:var(--live);border:1px solid var(--live)}
  .cur-mark{color:var(--ok);border:1px solid var(--ok)}
  .tmine{margin-top:11px;padding-top:9px;border-top:1px solid var(--line);font-size:12.5px;color:var(--ok)}
  .tmine.short{color:var(--bad)}
  .tunknown{margin-top:11px;padding-top:9px;border-top:1px solid var(--line);font-size:12.5px;color:var(--warn)}
  .tnote{color:var(--ink3);margin-top:4px;line-height:1.6}
  .tbase{margin-top:8px;font-size:11.5px;color:var(--ink3);line-height:1.55}
  .tempty{font-size:12.5px;color:var(--ink3);font-style:italic}
  .gapcard.techgap{border-left-color:var(--warn)}
  .warnbox{border:1px solid var(--warn);border-radius:8px;padding:14px 16px;margin-top:14px;
           font-size:13px;color:var(--ink2);line-height:1.7}
  .warnbox b{color:var(--warn)}
  .badbox{border:1px solid var(--bad);border-radius:8px;padding:14px 16px;margin-top:14px;
          font-size:13px;color:var(--ink2)}
  .badbox ul{margin:8px 0 0;padding-left:18px}
  .gapgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
  .gapcard{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--bad);
           border-radius:8px;padding:13px 15px}
  .gapcard .t{font-size:14.5px;font-weight:640;margin-bottom:5px}
  .gapcard .l{font-size:12.5px;color:var(--ink3);line-height:1.65}
  .note{font-size:13px;color:var(--ink3);border-left:2px solid var(--line);padding-left:14px;margin-top:18px}
  code{font-family:var(--mono);font-size:.88em;background:var(--line);padding:1px 5px;border-radius:3px}
  footer{margin-top:60px;padding-top:20px;border-top:1px solid var(--line);
         font-size:12.5px;color:var(--ink3);line-height:1.8}
  @media (max-width:680px){ h1{font-size:25px} .wrap{padding:36px 18px 80px} }
</style>
</head>
<body>
<div class="wrap">
  <div class="goal">目标</div>
  <h1>${esc(report.goal)}</h1>
  <div class="sub">
    ${served ? '<b>现算</b> · 每次刷新重新读 · ' : ''}生成于 ${esc(generatedAt)}
    · ${report.blocks.length} 个能力块 · ${c.subjects} 个学科 · ${c.techs} 项技术 · ${c.langs} 门语言
    · ${c.total} 处缺口
  </div>
  <div class="split">
    <b>结构</b>来自项目：做这件事需要哪几块能力、每块靠什么知识。任何做这个项目的人都一样。<br>
    <b>颜色</b>${report.hasProgress ? '来自 progress.json：我这门课学到哪、卡在哪' : '没有——现在是一张纯结构图'}。
    ${report.hasProgress ? '删掉 progress.json 这张图照样画得出来，只是没有颜色。' : ''}
  </div>

  ${report.problems.length ? `<div class="badbox"><b>数据有问题（先修好再看图）：</b><ul>${report.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
  ${report.warnings.map((w) => `<div class="warnbox">${esc(w)}</div>`).join('')}

  <h2>一 · 这个项目要哪几块能力</h2>
  <div class="blocks">${report.blocks.map((b) => renderBlock(b, report, entryStatus)).join('')}</div>
  <div class="note">
    依据分三档：<b>条目</b>＝库里有能定位的原文；<b>实测</b>＝自己跑出来的，脚本在下面；
    <b>判断</b>＝我按项目推的，既没原文也没跑过。
  </div>

  <h2>二 · 学科（原理那一边）</h2>
  <div class="note" style="margin:0 0 14px">
    缩进＝先修关系。灰底是结构，有色标签是个人进度。<br>
    这些是「为什么」——滤波器为什么这么设计、误差怎么算。<br>
    知识点<b>实线</b>＝原文能定位到，<b>虚线</b>＝我按生态推的、还没核（鼠标停上去看具体要会什么）。
  </div>
  ${roots.map((d) => renderDomain(d, report, 0, seen)).join('') || '<div class="note">还没有学科数据。</div>'}

  <h2>三 · 技术（动手那一边）</h2>
  <div class="note" style="margin:0 0 14px">
    这些不是「学过哪门课」能回答的，所以用等级而不是状态：<br>
    <b>L1 认得</b> → <b>L2 会用</b> → <b>L3 会调</b> → <b>L4 会选</b>。
    刻度写在结构里，我的等级写在 <code>progress.json</code> 的 <code>skills</code> 里。
  </div>
  <div class="techgrid">${techs.map((d) => renderTech(d, report)).join('') || '<div class="note">还没有技术域。</div>'}</div>

  <h2>四 · 语言（读得动原文那一边）</h2>
  <div class="note" style="margin:0 0 14px">
    语言不是「顺便会一点」的事：读不动原文，就只能读别人的转述，而转述无法核对。
  </div>
  <div class="techgrid">${langs.map((d) => renderTech(d, report)).join('') || '<div class="note">还没有语言域。</div>'}</div>

  <h2>五 · 卡在哪</h2>
  ${c.total === 0
    ? '<div class="note">没有记录缺口。有 progress.json 的 gaps 才会出现在这里。</div>'
    : `<div class="gapgrid">
    ${gapDomains.map((d) => `
      <div class="gapcard">
        <div class="t">${esc(report.byDomain.get(d.id)?.localName || d.name)}</div>
        <div class="l">整门课是缺口${report.byDomain.get(d.id)?.note ? ` · ${esc(report.byDomain.get(d.id).note)}` : ''}</div>
      </div>`).join('')}
    ${report.techGaps.map((g) => `
      <div class="gapcard techgap">
        <div class="t">${esc(g.name)} · 差 ${g.delta} 级</div>
        <div class="l">需要 L${g.need}，我在 L${g.mine}${g.estimated ? '（估）' : ''}${g.note ? ` · ${esc(g.note)}` : ''}</div>
      </div>`).join('')}
    ${gapPoints.map((p) => `
      <div class="gapcard">
        <div class="t">${esc(p.name)}</div>
        <div class="l">${esc(report.domainById.get(p.domain)?.name ?? p.domain)}${report.byPoint.get(p.id)?.note ? ` · ${esc(report.byPoint.get(p.id).note)}` : ''}</div>
      </div>`).join('')}
  </div>`}
  <div class="note">
    缺口按「现在就卡着」算，不是「没学过」。没有 progress.json 就一个缺口都不会有——因为缺口是人的事，不是项目的事。<br>
    技术缺口的判据是「项目要求几级 vs 我现在几级」，不是「学过没学过」——学过课但到不了 L3，照样是缺口。
  </div>

  <footer>
    专业代理层 · 课程地图<br>
    结构在 <code>knowledge-map.json</code>，个人进度在 <code>progress.json</code>。
  </footer>
</div>
</body>
</html>`;
}
