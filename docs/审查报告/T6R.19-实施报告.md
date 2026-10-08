# T6R.19 静态合成图片导出——实施报告

日期：2026-10-08。分支：`task/T6R-19`（自 v2 切出，**未合 v2、未发 main**）。实施子代理完成桌面自动化部分；质量闸门（/simplify、/code-review、/security-review——触及学生载荷，建议加跑）与合并归编排者。

## 1. 交付范围与提交清单

| 提交 | 内容 |
| --- | --- |
| `63c747a` | feat(web): T6R.19 单1——纯函数层：版式模型 buildReviewImageSections（页眉红线文案/题面 markdown/图片区块/缺失显式声明）、学生载荷第二道哨兵守卫、分页计划 planReviewImagePages、画布像素预算、文件名（20 单测先红后绿） |
| `9dd5538` | feat(web): T6R.19 单2——html-to-image 栅格化适配器：离屏 React 静态版式 → markdown 逐段拆块 → 测量分页 → 栅格化 → PNG 魔数+空白校验 → 统一下载；失败分类零下载（15 单测）；saveBlobAs 从 lib/api 导出复用；新增依赖 html-to-image ^1.11.13 |
| `4dae16e` | feat(web): T6R.19 单3——ExportReviewImageSection 组件并入 review-pack 面板第四出口：三态/失败回落既有出口/学生红线文案/复制图片无剪贴板降级（6 组件测试 + 面板四出口测试 1） |
| `1b8f768` | test(e2e): T6R.19 真实栅格化 E2E（review-image-export.spec.ts）——长题干驱动分页、多页下载、文件名、1440 宽 2x、页数≥2、泄露监控零告警；**修 markdown 整段成块缺陷**（长题干恒超画布兜底上限）并加回归断言 |
| `5c47a8f` | docs: 架构 §5.9 / 页面功能清单 / 进度表同步（T6R.19 保持 ☐，注明桌面自动化已合分支、真机待用户、R4 未宣称交付） |
| （本次） | 本报告 |

新增/修改文件：
- 新增 `apps/web/src/features/notes/export-review-image.ts`（核心模块：纯函数层 + 栅格化适配器层）
- 新增 `apps/web/src/features/notes/export-review-image.test.ts`（20）、`export-review-image-dom.test.ts`（15）、`ExportReviewImageSection.tsx` + `.test.tsx`（6）
- 修改 `apps/web/src/features/export/review-pack-panel.tsx`（第四出口挂载）+ `.test.tsx`（四出口在场断言；一处既有断言收紧为「本包不含参考答案与对错判定」避免与新文案撞词）
- 修改 `apps/web/src/lib/api.ts`（仅导出 saveBlobAs——单一实现复用，不另写下载副本）
- 新增 `e2e/review-image-export.spec.ts`
- `apps/web/package.json` + `pnpm-lock.yaml`：+html-to-image ^1.11.13

未动：packages/contract、服务端、DSL 注册表、samples。

## 2. 设计与实现要点

### 2.1 材料口径（沿用 T6R.12/13，不重新实现投影）
合成图消费 review-pack 预览载荷（`ReviewPackPreviewData`）：题面 = `questionMd`（服务端 `buildStaticQuestionMaterial` 按角色装配——`::graph` 已参数化为文字说明、fold/steps 已加静态标记）；图片 = `attachments`（媒体/证据/笔迹，各自已授权 downloadUrl）；缺失附件 → 合成图内显式「缺失：路径——原因」区块。

### 2.2 学生红线（答案不进渲染树）
- 服务端结构性投影是第一道（学生包无答案/判定/评语/解析）；
- 客户端第二道（纵深防御）：`buildReviewImageSections` 对学生载荷做三重守卫——①`stemMdLeaksAnswers(questionMd)`（与 assert-no-stem-leak 同一 md-dsl oracle：[[答案]] 标记/选项任务列表）；②教师模板节标记（`**参考答案**`/`**详解**`/`**判定**`/`**老师评语**`——服务端拼节用的固定标记）；③`answersIncluded === true` 不变量。任一命中即拒绝生成（kind=forbidden）——**答案内容根本不进版式模型与离屏渲染 DOM，不是 display:none 式隐藏**（单测用哨兵字符串断言页 DOM outerHTML）。
- 学生页眉红线文案：「本合成图不含参考答案与对错判定（内容只基于你自己的作答）」；未公布时追加「答案尚未公布（无判定属正常）」。

### 2.3 静态版式与渲染
固定 720 CSS 逻辑宽、白底、无任何交互控件；markdown 经与 RichMarkdown **同一 remark/rehype 管线**（frontmatter/math/gfm/directive/blank/directive-host + katex + sanitize），仅把三个指令宿主组件换成静态版：容器（fold/steps 等）恒展开+静态标签、`::image` 叶子降级为「见下方图片附件区块」、blank=下划线空框/mark=高亮。排版样式复用全局 `.rich-markdown` 类（与主应用同源）。

### 2.4 分页（纯几何，先测后写）
`planReviewImagePages`：块贪心装填，块序整体保持、每块恰归一页（不重不漏、无重叠——与 T6R.6 笔迹切片的跨页重叠语义不同：版式切块在块边界，无需续读）；单块超常规页高但未超画布兜底上限 → 独立成页；超兜底上限 → 显式失败（canvas-limit）。渲染侧 markdown 逐顶层元素拆块（`data-export-md-block` 薄壳，margin 穿透照常折叠）——**E2E 首轮发现的真实缺陷**：拆块曾只拆到外层包装（整段 stem 成一块 2586px），长题干恒超 1976px 兜底上限；修复后 26 段长题干正确分 3 页（E2E 断言页数≥2）。

### 2.5 失败语义（任务清单七项逐条）
| 失败项 | 分类 | 行为 |
| --- | --- | --- |
| 学生载荷哨兵命中 | forbidden | 拒绝生成（不建 DOM）、零下载 |
| 字体嵌入失败（getFontEmbedCSS 抛错） | font | 中文原因 + 回落提示，零下载 |
| 图片加载/解码失败 | media | 列出来源 URL，零下载 |
| 编码空 Blob / 非 PNG 魔数 | encode | 「不下载残缺文件」，零下载 |
| 整页空白（字体/渲染失败产白图） | encode | 64×64 采样全白判定，零下载 |
| 单块超画布兜底上限 | canvas-limit | 分页兜底仍超限的显式失败原因，零下载 |
| 栅格化本体抛错 | rasterize | 中文原因 + 回落提示，零下载 |
| 无剪贴板（clipboard/ClipboardItem 不可用） | ——（辅助出口） | copyPngBlobToClipboard 返回 false → UI 显式「不支持复制图片（常见于 HTTP 部署）——请使用已下载的 PNG 文件」，不崩溃、绝不显示「已复制」 |

**总则**：逐页先栅格化+校验、全部通过后**统一下载**（失败零下载——不存在「下载了空白图后显示成功」的路径）；离屏宿主（`data-review-image-host`）成功/失败同路径必然清理。

### 2.6 ECharts 核实结论（任务指定核实点）
题目 DSL **无 ECharts 类指令**——`echarts` 依赖仅用于教师端学情图表（features/insights），不出现在题目/讲义渲染链。题目中的函数图像是 `::graph`（function-plot），在授权静态材料（buildStaticQuestionMaterial）里已统一转为**参数化文字说明**（解析式+区间+原始指令），review-pack zip 与合成图同口径——**合成图不含任何动画/交互图表内容**，「图表停动画/导出静态图」要求以「本就无动画内容进入合成图」的方式满足；renderGraphFigurePng（::graph→PNG 原语）未接入合成图（预览载荷不携带图表 spec，回解析标记行属脆弱路径）——如真机反馈公式说明不够直观，后续可评估从材料标记行提取 spec 增强，不在本任务范围。

## 3. 新增依赖：html-to-image ^1.11.13（技术栈清单外，按规则写理由与替代方案）

| 方案 | 体积 | 依赖 | 原理 | 维护 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **html-to-image 1.11.13（选用）** | ~10KB min+gz | 零依赖 | SVG foreignObject + 逐元素 computed style 克隆 + 字体/图片内嵌 | 活跃（bubkoo，star 30k+） | 真实浏览器布局（克隆计算样式），本地打包字体同源可嵌入；D6.10 已裁定为「可选合成图适配器，先真机验证、失败不阻断」——本实现把它封在可注入 deps 之后，可整体替换 |
| html2canvas 1.4.x | ~195KB min | 零依赖 | 自研 CSS 解析 → canvas 重绘（无 foreignObject） | 1.4.1 后节奏放缓 | 现代 CSS（oklch/flex/grid）保真缺口知名；体积 20 倍；自绘引擎与「真实布局」目标相悖 |
| modern-screenshot | ~12KB | 零依赖 | html-to-image 社区续作，修若干 bug | 社区较小 | API 同源可作后续替换候选；当下选原作（issue 生态与文档更全） |
| dom-to-image(-more) | ~10KB | 零依赖 | 同系前辈 | 维护弱 | 被 html-to-image 取代 |
| satori + resvg-wasm（Vercel 路线） | wasm 重 | wasm | JSX→SVG 自研排版引擎（不经浏览器布局） | 活跃 | 需在非浏览器排版范式里重实现 markdown+KaTeX 全部版式（无法复用 RichMarkdown 管线与 .rich-markdown 样式），引入 wasm——范围与风险远超收益 |

## 4. 分页与画布限制参数（全部**暂定值**，真机定标后修订——T6R.1 纪律口径）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| REVIEW_IMAGE_WIDTH_CSS | 720 | 固定逻辑宽（方案 §10） |
| REVIEW_IMAGE_PIXEL_RATIO | 2 | 导出宽恒 1440px（小字/公式可读；E2E 断言 IHDR width=1440） |
| REVIEW_IMAGE_PAGE_PADDING_CSS | 36 | 上下留白（内容宽 648） |
| REVIEW_IMAGE_PAGE_MAX_CONTENT_HEIGHT_CSS | 1500 | 常规页内容高上限 → 单页像素 1440×3144（4.5MP） |
| REVIEW_IMAGE_CANVAS_MAX_EDGE_PX | 4096 | 保守边长上限（对齐 iPad Safari 已知限制；Chrome 桌面 65535/16384） |
| REVIEW_IMAGE_CANVAS_MAX_AREA_PX | 16,777,216（16MP） | 保守面积上限 |
| SINGLE_BLOCK_MAX（派生） | 1976 CSS px | min(边长/面积约束) 推导，不手抄数；页内图片 maxHeight=1916 兜底缩放 |

## 5. 验证（真实命令输出）

### 定向单测
```
$ pnpm vitest run apps/web/src/features/notes/ apps/web/src/features/export/
 Test Files  24 passed (24)
      Tests  380 passed (380)
```
（新增 42 项：纯函数层 20 + 适配器 15 + 组件 6 + 面板 1；纯函数层为**先红后绿**——实现前运行确认 module-not-found 失败；适配器/组件测试先于实现写好，导入缺失即失败口径。）

### 相关 E2E（chromium + webkit 双绿）
```
$ pnpm e2e e2e/review-image-export.spec.ts --project=chromium --project=webkit
  ok 1 [webkit]   … 学生长题干＋草稿原稿 → 复习包合成图多页 PNG (7.1s)
  ok 2 [chromium] … 学生长题干＋草稿原稿 → 复习包合成图多页 PNG (7.0s)
  2 passed (12.3s)
```
E2E 覆盖：造数（长题干 26 段说明的选择题+草稿）→ 作答交卷 → 补分析图 → AI 复习包 → 导出合成图 → **多页下载**（页数≥2）逐张断言：文件名 `review-image-q1-student-NN.png`、可解码 PNG（魔数+IHDR）、宽恒 1440、泄露监控零告警。首轮运行曾失败并暴露 §2.4 拆块缺陷（「单块内容高 2586px 超过画布分页兜底上限 1976px」）——修复后双绿。

### G（完整命令）
```
$ pnpm lint
Checked 741 files in 645ms. No fixes applied.
Found 18 warnings. Found 2 infos.        ← 与 v2 基线零差距（0 error）

$ pnpm typecheck                          ← e2e + 五包全部 Done
apps/server typecheck: Done
apps/web typecheck: Done

$ pnpm test
 Test Files  267 passed (267)
      Tests  3381 passed (3381)           ← v2 基线 3339 → +42

$ pnpm build
server esbuild ✓ + 迁移/规范拷贝 OK；web vite ✓ built in 2.02s + PWA 348 entries
```
未跑 gen:spec / schema:export：本任务未触及 contract/注册表/linter/CLI（CI 校验对象），无产物变化。

全量 `pnpm e2e` 由编排者验收时执行（勿与本任务或其他任务并发）。

## 6. 遗留风险与已知取舍

1. **foreignObject 保真度**：html-to-image 不承诺像素级一致（方案 §10 原文口径）；桌面 chromium/webkit 已验证，**iPad Safari 真机未验证**——这是 R4 不宣称交付的根本原因。
2. **画布上限是保守暂定值**：若真机 iOS 版本上限低于 4096 边长，超限内容会显式失败（不产残图）；参数按真机结果修订。
3. **单段超长块**：单个 markdown 顶层元素 >1976px（约 60 行连续无分段文字）仍显式失败——当前教材维度极难出现；真机若反馈需要，可按行内元素加深层拆分。
4. **先全部物化再统一下载**：多页 PNG 同时驻内存（几十 MB 级）——换取「失败零下载」不变量；超大题不适用（有 zip 出口兜底）。
5. **`.rich-markdown` 全局样式耦合**：合成图排版复用主应用样式类——样式类变更合成图随之变化（单一来源同变化，可接受取舍）。
6. **复制图片仅第一张**：多页时其余走下载文件（UI 已说明）；ClipboardItem 需安全上下文+浏览器支持，降级路径已测。
7. webkit E2E ≠ iPad Safari 真机（方案 §6.4-6 纪律）；触控目标/横竖屏/分屏属真机验收面。
8. 面板第四出口挂在预览成功之后（`preview !== null` 分支内）——预览失败时合成图出口同不可见（与既有三出口同语义，材料来源本就是预览载荷）。

## 7. 建议的 🧑 真机检查清单（R4 交付判据，用户执行）

1. **公式与小字**：iPad Safari（HTTP 与 HTTPS 各一遍）打开含草稿的已交卷结果页 → AI 复习包 → 导出合成图 → 在「文件」中打开 PNG：根号/分数/上下标渲染正确，中文小字（页眉说明、图注）可读。
2. **长题多页**：找一道长题（或造一题长题干）导出：页数≥2、翻页内容连续不缺不重、文件名 -01/-02 递增。
3. **横竖屏与分屏**：各导出一次——版式应恒为 720 宽白底（不受视口影响；受影响即缺陷）。
4. **失败回落**：断网/登出后点导出——应见中文错误与「请继续使用既有出口」提示，**绝无空白 PNG 下载或「已导出」字样**。
5. **复制图片**：HTTPS 点「复制第一张图片」→ 备忘录粘贴确认是图片；HTTP 确认显示「不支持复制图片」提示且无「已复制」。
6. **教师视角**：教师详情页同面板导出一份——确认含参考答案/判定/评语，页眉注明教师视角。
7. ECharts 无需真机检查（§2.6 结论：题目链路无 ECharts，::graph 为文字参数说明）。
8. 照片证据或导出文件按任务条目入验收记录（PNG 魔数不能替代视觉验证）。

## 8. 编排者验收提示

- 触及学生端载荷消费与答案防泄露面 → 质量闸门建议 /simplify + /code-review + **/security-review**（与 assertNoLeak 型单测互补：本任务的泄露防线是客户端哨兵守卫+服务端既有结构性投影，双层）。
- 全量 `pnpm e2e`（chromium+webkit，~3 分钟，勿并发）；`pnpm gen:spec`+`pnpm schema:export` 二跑零 diff 属例行确认（本任务无产物变化）。
- 合并口径：分支全绿后先合 v2；进度表 T6R.19 保持 ☐ 直至真机检查完成（当前行内已注明「桌面自动化部分已合 task/T6R-19 分支；🧑 真机导出检查待用户；R4 未宣称交付」——合并后请把「已合 task/T6R-19 分支」改为「已合 v2 <哈希>」口径）。
