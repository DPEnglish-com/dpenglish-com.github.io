# 从头到脚 · 组织根站

公开访问：**https://dpenglish-com.github.io/**

一本「身体目录」：首屏是一具 1px 人形 + 六帧片花，往下是从头到脚的目录，再往下是六章产品——
脑袋（问辩）、眼睛（课蒸馏）、嘴巴（PaperEcho / SE English）、身体（WorkoutLoop）、着装（外在）。
读到哪一章，左侧脊柱上的人形就亮到哪一层。

- 单文件静态站：`index.html` 是全部产物（CSS / JS / display 字体子集全部内联）
- **零依赖、零构建、零外部请求**：没有 CDN、没有字体外链、没有分析脚本
- 无 JS 时六章、目录、片花、外链全部可读；视频/试用旁留直链
- 深/浅两套纸墨主题，跟随系统或手动切换
- 六个产品各有一支片与一份离线在线试用，点开悬浮窗才加载

## 六个产品

| 章 | 部位 | 产品 | 站点 |
|---|---|---|---|
| 01 | 脑袋 | 问辩 Wenbian | https://dpenglish-com.github.io/wenbian-site/ |
| 02 | 眼睛 | 课蒸馏 | https://dpenglish-com.github.io/keliuzheng-site/ |
| 03 | 嘴巴 | PaperEcho 纸上回声 | https://dpenglish-com.github.io/paperecho-site/ |
| 04 | 嘴巴 | SE English | https://www.seandictation.site/ |
| 05 | 身体 | WorkoutLoop | https://dpenglish-com.github.io/workoutloop-site/ |
| 06 | 着装 | 外在 OuterStyle | https://dpenglish-com.github.io/outerstyle-site/ |

## 数据与生成

`data/products.json` 是唯一数据源，数组顺序就是章节顺序。每个产品必填：

- `part` / `k` / `accent` / `name` / `short` / `platform` / `version` / `size`
- `desc`（两行正文）、`note`（收进「边界与前提」）、`promise`（目录与章首的一句话，≤40 字）
- `links`（https，第一条是主站，第二条通常是 APK）
- `media`（可选）：`video` + `poster` 必填；`demo` + `demoNote` 可选；
  `videoTitle` / `videoMeta` / `videoNote` 覆盖弹窗文案

改完重新生成：

```bash
node tools/build.mjs          # 写 index.html + 404.html
node tools/build.mjs --check  # 只检查同步（CI 用）
```

生成区（`@generated` 标记之间）包括：首屏六帧片花、目录、脊柱锚点、六章、页脚链接、JS DATA、404。
标记之外是手写外壳（CSS / 滚动逻辑 / 悬浮窗）。

## 验收

```bash
npm ci
node tools/verify.mjs
```

十道门一次跑完，本机约 1 分钟；本机和 CI 是同一条命令。

| 门 | 查什么 |
|---|---|
| 0 | 生成物与 `data/products.json` 同步 |
| 1 | 静态令牌对比度（深浅两套 + 产品色 ≥3:1） |
| 2 | 真实渲染：6 视口 × 明暗（对比度 / 溢出 / 重叠 / sticky / 触控目标 / 禁用 JS） |
| 3 | 目录与脊柱：六章 / 五个部位锚点 / 点击跳转 / 滚动高亮 / 逐层点亮 |
| 4 | 人形逐层绘制：首屏整具人形画出来、不是一帧到位；滚动提亮；reduce 时直接到位 |
| 5 | 边界路径：390px 移动端 / reduced-motion / 禁用 JS 六章完整 |
| 6 | 设计规则检测（impeccable 引擎） |
| 7 | 间距依据复核（`.toc` / `.chapter-flow` / `.contact-grid` 的内缩） |
| 7b | 母站对课蒸馏的版本/体积/包名/哈希与子站仓库一致 |
| 8 | 悬浮窗与试用页：点开前零加载、Esc/焦点归位、每个视频入口能读、每份试用页能开且切设备 |

```bash
node tools/verify.mjs --no-browser      # 跳过需要 Chrome 的六项（2/3/4/5/7/8）
node tools/verify.mjs --target URL      # 对线上跑（2/3/4/5/8，约 5 项）
```

`tools/chrome.mjs` 解析 Chrome 位置：`$CHROME_PATH` → 各平台常见路径 → `PATH`。
CI（Ubuntu）与 macOS 因此共用同一套脚本；显式设了 `CHROME_PATH` 却指不到文件会直接报错。

## 资产

- `assets/video/*.mp4` + `*-poster.jpg`：六支片与封面。视频 `preload=none`，点开弹窗才请求
- `assets/demo/*.html`：六份离线在线试用，单文件、零外部请求、手机/平板两种布局
- `assets/fonts/README.md`：display 字体子集的来源与许可说明
- display 字体是 **Source Han Serif SC Medium** 子集（SIL OFL 1.1），只打包页面用到的字，
  base64 内联在 `index.html`；重跑见 `tools/font-subset.py`
- `assets/og.png`：分享卡片，由 `node tools/make-og.mjs` 生成

## 部署

就是仓库里的静态文件，没有构建步骤：

```bash
git push origin main   # GitHub Pages 从 main 根目录发布
```

设计约定见 `DESIGN.md`；改设计先改契约，再改代码。
