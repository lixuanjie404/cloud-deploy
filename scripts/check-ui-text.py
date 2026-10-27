#!/usr/bin/env python3
"""按 CLAUDE.md「UI 文字两档暴露规则」检查站点文案。

规则来源：CLAUDE.md -> 网站定位与风格 -> UI 文字暴露规则（两档）

  第一档（任何位置都禁止）：股/股票/交易/盯盘/选股/两融/龙虎/盘前/盘中/尾盘/盘后
  第二档（只允许交互后才可见）：涨停/跌停/复盘/竞价/连板

检查项：
  1. index.html 首屏可见区域不出现第二档字样
  2. index.html 其余 HTML 中，第二档字样必须落在允许区域
     （#toolPanel 工具集菜单 / 时间轴 popover / <script> 内的弹窗配置）
  3. 第一档字样全站零命中
  4. 其他页面（下钻页）仅统计，不计入违规

用法：
    python scripts/check-ui-text.py            # 只输出结论与违规
    python scripts/check-ui-text.py --verbose  # 额外列出每条命中的位置
    python scripts/check-ui-text.py --list     # 列出所有命中（含合规项）

退出码：0 通过，1 存在违规
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "workers" / "stock"
INDEX = SITE / "index.html"

TIER1 = ["股", "股票", "交易", "盯盘", "选股", "两融", "龙虎",
         "盘前", "盘中", "尾盘", "盘后"]
TIER2 = ["涨停", "跌停", "复盘", "竞价", "连板"]

GATE_MARK = 'id="panelGate"'  # 历史标记，规则已不要求下钻页必带

# 首屏可见区域（正则，按顺序取内容）
VISIBLE_REGIONS = [
    ("顶栏", r'<header class="topbar">.*?</header>'),
    ("工作台卡片", r'<section class="hero-card">.*?</section>'),
    ("panel 标题与说明", r'<h3>[^<]*</h3>\s*<p>[^<]*</p>'),
    ("时间轴列头", r'<div class="timeline-head">.*?</div>'),
    ("时间轴节点标签", r'class="timeline-label">[^<]*<'),
    ("时间轴角色格", r'<div class="timeline-role">.*?</div>'),
    ("panel 正文", r'<section class="panel[^"]*">.*?</section>'),
]

# 允许出现第二档字样的区域
ALLOWED_REGIONS = [
    ("工具集菜单", r'<aside class="tool-panel".*?</aside>'),
    ("时间轴 popover", r'<div class="timeline-popover">.*?</div>'),
    ("脚本内弹窗配置", r'<script>.*?</script>'),
]

POPOVER = re.compile(r'<div class="timeline-popover">.*?</div>', re.S)
TAG = re.compile(r'<[^>]+>')


def tier_re(words):
    """按词长倒序拼正则，避免「股」抢先匹配「股票」。"""
    return re.compile("|".join(re.escape(w) for w in sorted(words, key=len, reverse=True)))


RE1 = tier_re(TIER1)
RE2 = tier_re(TIER2)


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def plain(fragment):
    """去标签与 popover（popover 属交互后可见，不算首屏文本）。"""
    return TAG.sub(" ", POPOVER.sub(" ", fragment))


def read(path):
    return path.read_text(encoding="utf-8", errors="replace")


def check_first_screen(text):
    problems = []
    for name, pattern in VISIBLE_REGIONS:
        for m in re.finditer(pattern, text, re.S):
            visible = plain(m.group(0))
            for hit in RE2.finditer(visible):
                problems.append((name, hit.group(0), line_of(text, m.start())))
    return problems


def check_index_context(text):
    """第二档字样落在允许区域之外即为违规（这些位置通常首屏可见）。"""
    allowed = []
    for name, pattern in ALLOWED_REGIONS:
        for m in re.finditer(pattern, text, re.S):
            allowed.append((m.start(), m.end(), name))

    def owner(pos):
        for start, end, name in allowed:
            if start <= pos < end:
                return name
        return None

    problems, ok = [], []
    for hit in RE2.finditer(text):
        where = owner(hit.start())
        item = (hit.group(0), line_of(text, hit.start()), where)
        (ok if where else problems).append(item)
    return problems, ok


def scan_tier1():
    problems = []
    for path in sorted(SITE.rglob("*")):
        if path.suffix not in {".html", ".js", ".css"}:
            continue
        text = read(path)
        for hit in RE1.finditer(text):
            problems.append((path.relative_to(ROOT), hit.group(0), line_of(text, hit.start())))
    return problems


def check_pages():
    """其他页面不受两档规则约束，仅统计供参考。"""
    stats = []
    for path in sorted(SITE.glob("*.html")):
        if path.name == INDEX.name:
            continue
        text = read(path)
        hits = list(RE2.finditer(text))
        if hits:
            stats.append((path.name, len(hits)))
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true", help="列出合规命中的位置")
    ap.add_argument("--list", action="store_true", help="列出全部命中（含合规项）")
    args = ap.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if not INDEX.exists():
        print(f"找不到入口文件: {INDEX}")
        return 1

    index_text = read(INDEX)
    errors = 0

    print("【1】index.html 首屏可见区域 × 第二档字样")
    first = check_first_screen(index_text)
    if first:
        errors += len(first)
        for name, word, ln in first:
            print(f"  ✗ {name}  L{ln}  «{word}»")
    else:
        print("  ✓ 零命中（顶栏/卡片/panel 标题说明/时间轴列头与节点）")

    print("\n【2】index.html 其余位置 × 第二档字样（须在允许区域内）")
    ctx_bad, ctx_ok = check_index_context(index_text)
    if ctx_bad:
        errors += len(ctx_bad)
        for word, ln, _ in ctx_bad:
            print(f"  ✗ L{ln}  «{word}» 不在允许区域（菜单/弹窗/popover/脚本）内")
    else:
        print(f"  ✓ 全部落在允许区域，共 {len(ctx_ok)} 处")
    if args.verbose or args.list:
        seen = {}
        for word, ln, where in ctx_ok:
            seen[where] = seen.get(where, 0) + 1
        for where, n in sorted(seen.items()):
            print(f"    · {where}: {n} 处")

    print("\n【3】第一档字样 × 全站（任何位置都禁止）")
    t1 = scan_tier1()
    if t1:
        errors += len(t1)
        for path, word, ln in t1:
            print(f"  ✗ {path}:{ln}  «{word}»")
    else:
        print("  ✓ 零命中")

    print("\n【4】其他页面（不受限，仅统计）")
    pages = check_pages()
    if pages:
        for name, n in pages:
            print(f"  · {name}：第二档 {n} 处（打开即显示，按规则允许）")
    else:
        print("  · 无")

    print()
    if errors:
        print(f"结果：违规 {errors} 处，未通过。")
        return 1
    print("结果：全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
