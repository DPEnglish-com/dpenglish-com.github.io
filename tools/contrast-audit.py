#!/usr/bin/env python3
"""习场母站预览 —— 令牌对比度核算。

沿用 PaperEcho / Wenbian / WorkoutLoop 的惯例：配色不靠"看起来够深"，
每个比值都算出来，并且把结论写回 CSS 注释。

用法：
    python3 tools/contrast-audit.py index.html

它会从 index.html 里解析三处令牌块（深色默认、浅色、无 JS 时的浅色回退），
逐对计算 WCAG 对比度，并按阈值判定。退出码 0 = 全部达标。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 对比度数学


def _srgb_to_linear(channel: int) -> float:
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _srgb_to_linear(r) + 0.7152 * _srgb_to_linear(g) + 0.0722 * _srgb_to_linear(b)


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def blend(fg_hex: str, alpha: float, bg_hex: str) -> str:
    """把 rgba(fg, alpha) 合成到 bg 上，得到等效实色。"""
    f, b = fg_hex.lstrip("#"), bg_hex.lstrip("#")
    out = [
        round(alpha * int(f[i : i + 2], 16) + (1 - alpha) * int(b[i : i + 2], 16))
        for i in (0, 2, 4)
    ]
    return "#%02X%02X%02X" % tuple(out)


# ---------------------------------------------------------------- 令牌解析

TOKEN_RE = re.compile(r"--([a-z0-9-]+)\s*:\s*([^;]+);")


def parse_block(css: str, selector_pattern: str) -> dict[str, str]:
    """取出某个选择器块里的 --token: value。selector_pattern 只写选择器，不含大括号。"""
    m = re.search(selector_pattern + r"\s*\{(.*?)\}", css, re.S)
    if not m:
        return {}
    body = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)  # 去掉注释再解析
    return {name: value.strip() for name, value in TOKEN_RE.findall(body)}


def resolve(tokens: dict[str, str], name: str, depth: int = 0) -> str:
    """跟随 var() 引用。"""
    if depth > 8:
        raise ValueError(f"var() 循环：{name}")
    value = tokens.get(name, "")
    m = re.fullmatch(r"var\(--([a-z0-9-]+)\)", value)
    if m:
        return resolve(tokens, m.group(1), depth + 1)
    return value


def rgba_of(value: str) -> tuple[str, float]:
    """把 rgba(r,g,b,a) 拆成 (#hex, alpha)；实色则 alpha=1。"""
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)", value)
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) else 1.0
        return "#%02X%02X%02X" % (r, g, b), a
    return value, 1.0


# ---------------------------------------------------------------- 检查清单
# (标签, 前景令牌, 背景令牌, 阈值)
CHECKS: list[tuple[str, str, str, float]] = [
    ("正文 ink", "ink", "bg", 4.5),
    ("二级文字 ink-2", "ink-2", "bg", 4.5),
    ("三级文字 ink-3", "ink-3", "bg", 4.5),
    ("正文 ink on surface", "ink", "surface", 4.5),
    ("二级文字 on surface", "ink-2", "surface", 4.5),
    ("三级文字 on surface", "ink-3", "surface", 4.5),
    ("主按钮文字 on-signal", "on-signal", "signal", 4.5),
    ("强调底 vs 页面 bg（控件边界）", "signal", "bg", 3.0),
    # 产品色只以 1px 细线与 8px 色块出现 —— 非文字，按 3:1 判
    ("产品色 PaperEcho", "pe", "bg", 3.0),
    ("产品色 问辩", "wb", "bg", 3.0),
    ("产品色 WorkoutLoop", "wl", "bg", 3.0),
    ("产品色 外在", "os", "bg", 3.0),
]


def audit(label: str, tokens: dict[str, str]) -> list[str]:
    problems: list[str] = []
    print(f"\n=== {label} ===")
    for name, fg_tok, bg_tok, need in CHECKS:
        if bg_tok not in tokens or fg_tok not in tokens:
            # 令牌被改名或删除时不能静默跳过，否则审计会假装通过
            problems.append(f"{label} · {name}：令牌缺失（{fg_tok} / {bg_tok}）")
            print(f"  MISS  {name:<34} 令牌缺失：--{fg_tok} / --{bg_tok}")
            continue
        bg = resolve(tokens, bg_tok)
        raw_fg = resolve(tokens, fg_tok)
        fg, alpha = rgba_of(raw_fg)
        if alpha < 1.0:
            fg = blend(fg, alpha, bg)
        r = ratio(fg, bg)
        ok = r >= need
        if not ok:
            problems.append(f"{label} · {name}：{r:.2f}:1 < {need}:1")
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<34} {fg:<9} on {bg:<9} {r:6.2f}:1  (需 ≥{need})")
    return problems


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "index.html")
    css = target.read_text(encoding="utf-8")

    dark = parse_block(css, r":root")
    light = parse_block(css, r':root\[data-theme=["\']light["\']\]')
    # 无 JS 且系统偏好浅色时的回退块，必须与上面那块一致
    fallback = parse_block(css, r":root:not\(\[data-theme\]\)")

    if not dark or not light:
        print(f"找不到令牌块（dark={bool(dark)} light={bool(light)}）", file=sys.stderr)
        return 1

    problems = audit("深色（默认）", dark)
    problems += audit("浅色 [data-theme=light]", light)

    if fallback:
        problems += audit("浅色回退 :root:not([data-theme])", fallback)
        diff = {
            k: (light.get(k), fallback.get(k))
            for k in set(light) | set(fallback)
            if light.get(k) != fallback.get(k)
        }
        if diff:
            print("\n!! 浅色回退块与 [data-theme=light] 不一致（会漂移）：")
            for k, (a, b) in sorted(diff.items()):
                print(f"   --{k}: light={a}  fallback={b}")
            problems.append("浅色回退块与主浅色块不一致")
        else:
            print("\n浅色回退块与 [data-theme=light] 逐令牌一致。")
    else:
        print("\n注意：未找到无 JS 浅色回退块。")

    print()
    if problems:
        print(f"共 {len(problems)} 处不达标：")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("全部达标。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
