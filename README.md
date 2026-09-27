# 从头到脚 · 组织根站

公开访问：**https://dpenglish-com.github.io/**

三个产品站的上层入口。左边一具 1px 细线画的人形——脑袋管思辨，
嘴巴管语言，身体管训练——点一处，出管着它的那个产品。

- 单文件静态站：`index.html` 就是全部产物（CSS/JS/词标子集内联）
- **零依赖、零构建、零外部请求**：没有 CDN、没有字体外链、没有分析脚本
- `404.html` 与 `index.html` 的四处产品内容都由 `data/products.json` 生成

> `package.json` 里的依赖**只给审计工具用**，不进线上产物。
> 部署的就是仓库里那几个静态文件，没有构建步骤。

## 三个子站

| 部位 | 产品 | 站点 |
|---|---|---|
| 脑袋 | 问辩 Wenbian | https://dpenglish-com.github.io/wenbian-site/ |
| 嘴巴 | PaperEcho 纸上回声 | https://dpenglish-com.github.io/paperecho-site/ |
| 身体 | WorkoutLoop | https://dpenglish-com.github.io/workoutloop-site/ |

## 改产品：只改一处

`data/products.json` 是唯一数据源。改完重新生成：

```bash
node tools/build.mjs          # 写入 index.html（四处）+ 404.html
node tools/build.mjs --check  # 只检查是否同步（CI 用）
```

生成器会在写盘前拦下这些错误，并说清怎么修：

| 会拦下的 | 为什么 |
|---|---|
| 改了 JSON 但忘了重新生成 | 页面会安静地显示旧数据 |
| `id` / `accent` / `slot` 撞车 | 它们是人形区域、颜色、栅格位置的键 |
| 用了新的 `accent` 但 CSS 里没这个令牌 | 页面不报错，只是少一块颜色 |
| 用了新的 `slot` 但 CSS 里没这条规则 | 页面不报错，只是错一个位置 |
| 链接不是 `https:` / 缺字段 / `id` 格式不对 | 上线后才发现就晚了 |

**`index.html` 里 `@generated` 标记之间的内容不要手改**，下次生成会覆盖。
标记之外的部分（样式、结构、脚本）照常手改。

## 验收

```bash
npm ci            # 只为审计工具装依赖（impeccable）
node tools/verify.mjs
```

八道门一次跑完，约 40 秒；本机和 CI 是同一条命令。

| 门 | 查什么 |
|---|---|
| 0 | 生成物与 `data/products.json` 同步 |
| 1 | 静态令牌对比度 |
| 2 | 真实渲染：8 视口 × 明暗 = 12 组合（对比度/溢出/重叠/sticky/触控目标/禁用 JS） |
| 3 | 图版交互：点部位出应用、人形跟随、面包屑退回 |
| 4 | 动画时序：人形逐条绘制（不是一帧到位）、取消选中不重播 |
| 5 | 边界路径：390px 移动端 / reduced-motion / 禁用 JS |
| 6 | 设计规则检测（impeccable 引擎） |
| 7 | `cramped-padding` 豁免依据复核 |

```bash
node tools/verify.mjs --no-browser      # 跳过需要 Chrome 的四项，约 1 秒
node tools/verify.mjs --target URL      # 对线上跑（渲染/交互/动画/边界四项）
```

`tools/chrome.mjs` 解析 Chrome 位置：`$CHROME_PATH` → 各平台常见路径 → `PATH`。
CI（Ubuntu）与 macOS 因此共用同一套脚本。**显式设了 `CHROME_PATH`
却指不到文件会直接报错**，不会静默换一个浏览器跑。

设计约定见 `DESIGN.md`。

## 部署

```bash
git add -A && git commit -m "站点更新" && git push
```

GitHub Pages 从 `main` 根目录发布（legacy build，与三个子站一致）。
`.nojekyll` 保留：关掉 Jekyll 处理。

`robots.txt` 与 `sitemap.xml` 里的地址与 `index.html` 的
canonical / og:url 必须一致，改地址时三处一起改。

