# 003 补齐批选、学生入口和筛选的触控范围

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`；无 `TOUCHES-DS`，使用已有 Button、label 和 44px 调用模式。

对应 UI-02；P2；judgement；本轮 canon 已经 MCP 获取并校验。检测器版本 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`；命中范围来自实际 DOM 矩形与关联 label 核查。

## 问题原文

以下缩写的 `pages/`、`features/` 路径均从 `apps/web/src/` 起算。

- `apps/web/src/pages/teacher/LibraryPage.tsx:986`：`aria-label={`选择讲义 ${lecture.title}`}`，输入框 `className="size-5 shrink-0 accent-primary"`；`1162` 行单元输入框为 `className="mt-3 size-5 shrink-0 accent-primary"`。逐项没有 label，实测 20×20px。
- `pages/teacher/StudentsPage.tsx:310`：`className="rounded text-base font-semibold outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"`，姓名入口实测 48×24px。
- `pages/teacher/StudentHomePage.tsx:442`：三档筛选 `className="min-h-9"`，实测 36px 高；同页两处失败重试（302、461 行）同样配置。
- `features/student/wrong-questions-ui.tsx:1054`：“清除全部筛选” `className="min-h-9 px-2 text-xs text-muted-foreground"`，需同批修正；该入口仅在筛选激活时出现，当前主批次空错题列表未渲染该状态，属于源码确认、尚待带数据复测的同类调用。

## 目标与步骤

1. 先补失败浏览器探测，选择框不仅检查 input 几何，也检查 `labels` 与实际可点击范围。用点击 44×44 热区边缘的行为断言证明可选择，不能只测试 CSS class。姓名入口与三档筛选检查实际高宽至少 44px。
2. 资源库逐项 checkbox 保持 20px 视觉，外包 `label`：`flex size-11 shrink-0 cursor-pointer items-center justify-center`；现有 grid 首列从 `1.25rem` 改为 `2.75rem`，保留 `minmax(0,1fr)`。移除 input 的 `mt-3`，需要标题对齐时只调整 label 的布局。不得把整个含编辑/删除按钮的资源行变成 label 或 button。
3. 学生姓名 Link 增加 `inline-flex min-h-11 min-w-11 items-center`；保持原路由及名字/登录名的视觉关系，不让姓名外的卡片操作触发导航。
4. 教师学生主页的三档筛选及两个重试改 `min-h-11 min-w-11`；错题本“清除全部筛选”同样处理。保留现有字号和文案，不通过缩小内容补密度。
5. 用当前宽度重新检查行高与换行；不得全局扩大 Button 默认尺寸，避免影响编辑器和已正确外扩的图标按钮。

## 验证与边界

复用 `CapabilityProfileSection.tsx` 的“视觉小控件＋大 label”惯例。全选本已有大 label，不重复修复。hidden/sr-only radio、关联整行 label 的 radio/checkbox、Chip 的伪元素热区不能以自身小矩形判为失败。

390、768、1440 下测试逐项/全选、单元展开、编辑/删除入口无误触；姓名单独导航，筛选值与 URL/请求不变；错误重试有焦点和 44px 热区。可用 `LibraryPage.test.tsx` 补 label 行为测试，但几何以真实浏览器为准。只有点击区域样式的部分可免单测；选择/导航行为仍须回归。未实测错题活跃筛选和错误重试状态须在实施阶段补齐，不能把源码检查说成浏览器已通过。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。相关规则：`KR-3`、`KR-3d`；规则强度/类别以 `CANON-REVIEW.md` 与原始主题 JSON 为准，判断方式均为 judgement。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
