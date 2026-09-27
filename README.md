# 从头到脚 · 组织根站

公开访问：**https://dpenglish-com.github.io/**

三个产品站的上层入口。左边一具 1px 细线画的人形——脑袋管思辨，
嘴巴管语言，身体管训练——点一处，出管着它的那个产品。

- 单文件静态站：`index.html` 就是全部（CSS/JS 内联，词标子集 base64 内联）
- **零依赖、零构建、零外部请求**：没有 CDN、没有字体外链、没有分析脚本
- 直接改 `index.html`，改完跑下面的验收

## 三个子站

| 部位 | 产品 | 站点 |
|---|---|---|
| 脑袋 | 问辩 Wenbian | https://dpenglish-com.github.io/wenbian-site/ |
| 嘴巴 | PaperEcho 纸上回声 | https://dpenglish-com.github.io/paperecho-site/ |
| 身体 | WorkoutLoop | https://dpenglish-com.github.io/workoutloop-site/ |

## 改完必须跑

```bash
cd /Users/ywlukiya/Projects/hub-preview

python3 tools/contrast-audit.py index.html      # 静态令牌对比度
node tools/render-audit.mjs index.html          # 真实渲染：12 组合
node tools/map-interact.mjs index.html /tmp/i 1440 dark   # 图版交互
node tools/map-anim.mjs index.html /tmp/a dark            # 动画时序
node tools/edge-cases.mjs index.html            # 移动端 / reduce / 禁用 JS

# design-stack 检测器
bash "$DSH_HOME/skills/design-stack/scripts/design-check" index.html
```

全部退出码 0 才算过。设计约定见 `DESIGN.md`。

## 部署

```bash
git add -A && git commit -m "站点更新" && git push
```

GitHub Pages 从 `main` 根目录发布（legacy build，与三个子站一致）。
`.nojekyll` 保留：关掉 Jekyll 处理。

`robots.txt` 与 `sitemap.xml` 里的地址与 `index.html` 的
canonical / og:url 必须一致，改地址时三处一起改。
