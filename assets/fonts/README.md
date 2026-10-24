# 字体资产

母站 display 字体是 **Source Han Serif SC Medium** 的子集（SIL OFL 1.1）：
词标、章节标题、产品名与 promise 用到的字被抽成 woff2，base64 内联在 index.html
的 @font-face 里。完整字体不进仓库；重跑方式见 tools/font-subset.py。
