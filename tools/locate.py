#!/usr/bin/env python3
"""把条目里的引文定位到 PDF 的「第几页、哪个框」，写到 raw/boxes.json。

这是可选增强，不是核心。核心（引文能否在文本里定位）由 JS 侧负责，
这里额外补一件事：**这份文本在原件 PDF 的哪一页哪个位置**。

为什么值得单独做：有了页码和框，一条证据就不只是「某段文字里有这句话」，
而是「第 3 页，左边这一块」。人一眼能核，机器也能截出来。

## 三个坑，都是踩出来的

一、不能对 page.chars 全局排序。
中文期刊 PDF 里标点常被单独摆位，按坐标排序会把「、、、」挤到句首：
    实际流：…包括公开数据集评估标准预处理方法…
    标点跑到：，，PPG 、 、 、
带标点的引文永远匹配不上。必须先用 extract_text_lines() 分组。

二、不能用 line["text"] 算字符位置。
pdfplumber 会按间隙插空格，中文行 46 行里 35 行长度和 chars 对不齐。
文本一律由 chars 拼出，保证一一对应。

三、连字会让映射漂移。
PDF 里「fi」是一个字形但 text 是两个字。按「一字框一位」扩映射，
每遇一个 fi 就错开一位，整页能漂十几位，最后框到不相干的行上。
所以按 text 实际长度重复挂同一个字框。

## 边界

- 只对**有文字层**的 PDF 有效。扫描件没有文字层，定位不到，需要 OCR。
- 拼页忽略分栏。双栏排版里一句话横跨栏缝时可能错位，命中后看一眼框宽。
- 定位不到就是定位不到，不猜。

用法：
    python tools/locate.py --entry entries/<id> --pdf <path/to.pdf>
    python tools/locate.py --entry entries/<id> --pdf x.pdf --verify   # 顺便裁图
"""

import argparse
import json
import os
import re
import sys


# ---------- 文本比较（与 src/quote.js 同一套两级策略） ----------

def fold(ch):
    code = ord(ch)
    if 0xFF01 <= code <= 0xFF5E:
        return chr(code - 0xFEE0)
    return ch


def is_space(ch):
    return ch in " \t\n\r\u3000\u00a0\f\v"


def canon(text, strip_space=False):
    """返回 (比较串, 每个比较字符 -> 原文下标)。"""
    chars, back = [], []
    pending = None
    for i, ch in enumerate(text):
        if is_space(ch):
            if strip_space:
                continue
            if pending is None:
                pending = i
            continue
        if pending is not None and chars:
            chars.append(" ")
            back.append(None)
        pending = None
        chars.append(fold(ch))
        back.append(i)
    return "".join(chars), back


def union_bbox(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return {
        "x0": round(min(b["x0"] for b in boxes), 2),
        "top": round(min(b["top"] for b in boxes), 2),
        "x1": round(max(b["x1"] for b in boxes), 2),
        "bottom": round(max(b["bottom"] for b in boxes), 2),
    }


def page_stream(lines):
    """整页文本 + 每个字符对应的字框（按 text 长度重复挂，治连字）。"""
    parts, owner = [], []
    for line in lines:
        chars = line.get("chars") or []
        if not chars:
            continue
        if parts:
            parts.append("\n")
            owner.append(None)
        for c in chars:
            t = c["text"]
            if not t:
                continue
            parts.append(t)
            owner.extend([c] * len(t))
    return "".join(parts), owner


def match_page(lines, quote):
    text, owner = page_stream(lines)
    if not text:
        return None
    for strip in (False, True):
        hay, back = canon(text, strip)
        needle, _ = canon(quote, strip)
        at = hay.find(needle)
        if at == -1:
            continue
        idxs = [back[at + k] for k in range(len(needle))]
        idxs = [i for i in idxs if i is not None]
        if not idxs:
            continue
        boxes = [owner[i] for i in idxs if owner[i]]
        tops = []
        for b in boxes:
            if not tops or abs(b["top"] - tops[-1]) > 2:
                tops.append(b["top"])
        return {
            "bbox": union_bbox(boxes),
            "lines_spanned": len(tops),
            "mode": "space-insensitive" if strip else "normalized",
        }
    return None


def locate(pdf_path, quote):
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        page_count = len(pdf.pages)
        for pno, page in enumerate(pdf.pages, start=1):
            hit = match_page(page.extract_text_lines(), quote)
            if hit:
                return {"page": pno, "page_count": page_count, **hit}
    return None


# ---------- 读条目里的 quotes ----------

def read_quotes(entry_dir):
    """只取 frontmatter 的 quotes 一行（JSON 数组）。"""
    path = os.path.join(entry_dir, "entry.md")
    with open(path, encoding="utf-8") as f:
        head = f.read(8000)
    m = re.search(r"^quotes:\s*(\[.*\])\s*$", head, re.MULTILINE)
    if not m:
        return []
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return []


def main(argv=None):
    ap = argparse.ArgumentParser(description="把引文定位到 PDF 的页码与边界框")
    ap.add_argument("--entry", required=True, help="条目目录，例如 entries/2026-11-21-xxx")
    ap.add_argument("--pdf", required=True, help="原件 PDF 路径")
    ap.add_argument("--verify", action="store_true", help="顺便把每个框裁成图片，便于肉眼核")
    ap.add_argument("--keep-path", action="store_true",
                    help="在 boxes.json 里保留完整本机路径（默认只存文件名，便于分享）")
    args = ap.parse_args(argv)

    quotes = read_quotes(args.entry)
    if not quotes:
        print("条目里没有 quotes，没什么可定位的。", file=sys.stderr)
        return 2

    # 默认只记文件名：完整路径会暴露机器布局，而这份文件是要能被分享的。
    # 需要重新定位时，路径由命令行再给一次就行，不必存在库里。
    recorded_pdf = args.pdf.replace("\\", "/") if args.keep_path else os.path.basename(args.pdf)
    out = {"pdf": recorded_pdf, "boxes": []}
    missing = 0
    for q in quotes:
        found = locate(args.pdf, q)
        out["boxes"].append({"quote": q, "found": found})
        if found is None:
            missing += 1
        else:
            print(f"命中 p{found['page']}/{found['page_count']}  跨{found['lines_spanned']}行  {found['mode']}")

    os.makedirs(os.path.join(args.entry, "raw"), exist_ok=True)
    target = os.path.join(args.entry, "raw", "boxes.json")
    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"已写 {target}（{len(quotes) - missing}/{len(quotes)} 条命中）")

    if args.verify:
        import pdfplumber

        with pdfplumber.open(args.pdf) as pdf:
            for i, item in enumerate(out["boxes"]):
                found = item["found"]
                if not found:
                    continue
                b = found["bbox"]
                page = pdf.pages[found["page"] - 1]
                img = os.path.join(args.entry, "raw", f"box-{i}.png")
                page.crop((b["x0"], b["top"], b["x1"], b["bottom"])).to_image(resolution=300).save(img)
                print(f"  裁图 {img}")

    return 0 if missing == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
