# 题卡容器对齐修复

用户已要求继续修复，并明确禁止用固定统一数值遮盖布局问题。

状态：实现与验证完成，分支 `codex/question-card-container-alignment`。

## 根因与范围

实际页面第 41、43 题外框为 872px，第 42 题为 768px。`AttemptQuestionCard` 按草稿分栏资格选择外框最大宽度，导致计算题与客观题不对齐。上一版 `QuestionSurface` 与标画容器的 720px 上限只压缩内部题面，没有修复外框。

## 文件与步骤

1. 在 `AttemptQuestionCard.test.tsx` 添加题型、草稿布局偏好切换不影响外框规则的失败回归；在 `QuestionSurface.test.tsx` 和 `QuestionAnnotationOverlay.test.tsx` 添加无历史布局不限制父列宽度的失败回归。
2. `AttemptQuestionCard.tsx` 外框跟随所在列表可用宽度，移除按题型或草稿偏好选择最大宽度的逻辑；卡内草稿仍按原有布局策略排列。
3. `QuestionSurface.tsx` 移除固定宽度；`QuestionAnnotationOverlay.tsx` 仅在存在保存布局时使用其逻辑尺寸，保持历史标画排版与整体缩放语义。
4. 新增隔离 Playwright 回归，比较混合题型外框与父列的真实几何，覆盖宽窄屏、草稿布局切换及 AI 助教开合。

## 审查记录

- 简化：移除题型分支与固定 720px 常量，使用列表 → 题卡 → 当前题列的自然宽度传递，不新增测宽状态或 ResizeObserver。
- 正确性：历史底图仍保留保存的 cssWidth、逻辑 frame 与整体缩放；当前没有历史布局时才完全跟随父列，未改变笔迹文档或底图校验。
- 回归修正：Chromium 中新布局会让第二题题面略微进入原 400px 测试视口，后台预备次数因此包含第二题。将只验证第一题预备复用的测试视口改为 350px，保留原次数断言，双浏览器通过。
- 全量检查发现旧 AI 测试仍预期全局入口等待滚动绑定，已同步为题卡入口直接绑定本题的现有交互；生产 AI 逻辑未改。
- 本次无学生接口或载荷改动，不涉及答案授权、安全投影或数据迁移。

## 已完成验证

- 修复前新增 3 项单元回归失败；真实 Chromium 回归复现外框差 104px。
- 修复后相关 Vitest：5 个文件、47 项测试通过。
- `pnpm e2e e2e/question-card-alignment.spec.ts e2e/annotation-paper-interaction.spec.ts e2e/question-inline-annotation.spec.ts --workers=2`：`22 passed (2.0m)`，Chromium 与 WebKit，包含标画像素与原尺寸保留。
- `pnpm typecheck`：所有工作区包通过；`pnpm lint`：退出码 0，仅有既有演练脚本的 2 条警告与 1 条提示；`pnpm build`：退出码 0；`git diff --check`：退出码 0。
- 原用户页面热更新实测：第 41、42、43 题左边缘均 228px，外框均跟随父列为 872px，题面均为 830.4px。该值是当前窗口下的测量结果，不是代码中的固定宽度。
- `pnpm test --maxWorkers=2`：`Test Files 435 passed (435)`、`Tests 5181 passed (5181)`，退出码 0。
- 最终在原练习通过答题卡定位第 42 题，目视确认与第 43 题左右边框对齐，测量右边缘均为 1100px。

## 手动复验

打开学生练习「1.1.2.极限」，从答题卡定位第 42 题，比较它与第 41、43 题的左右边框。展开、收起草稿及 AI 助教，切换上下排列、左右分栏、自动布局后再次比较；调整窗口宽度，题卡应始终跟随所在列表。已有标画应与题面一起缩放，不能因边框对齐改变旧笔迹位置。

## 验证

先确认新回归失败，再实现。运行相关 Vitest、真实 Chromium/WebKit E2E、类型检查、构建与格式检查。依次对完整 diff 做简化及正确性审查；本次不修改接口、载荷、判分或答案授权。同步 AGENTS.md 中题卡宽度约定。只提交本任务文件，保留工作区已有改动。
