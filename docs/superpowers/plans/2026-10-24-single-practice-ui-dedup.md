# 单题专注 · 逐题反馈页面去重与流畅度重构（实施计划）

分支：`codex/practice-experience-fixes`（在 `c131b2cb` 之上继续提交）

## 现状问题（对照截图）

| # | 问题 | 位置 |
|---|------|------|
| P1 | 未作答时并排两个“提交”按钮：禁用的「提交本题」+「不会，提交并看解析」，主次不清 | `PracticeSingleActions` |
| P2 | 进度重复三处：工作区「第 1 / 20 题 · 已提交 0 题」行、题卡「第 1 题」、吸底「已填写 0/20 · 已提交 0/20」 | `SingleQuestionProgressRow` + `AttemptBottomBar` |
| P3 | 吸底区两层、卡中卡：操作条自带边框卡片，下面还有一整行进度 + 大「交卷」按钮，手机上吃掉约 170px | `SingleQuestionActionBar` / `AttemptBottomBar` |
| P4 | 逐题反馈下「交卷」与「提交本题」同等分量，容易误点；规范要求“提前交卷为次级入口” | `AttemptBottomBar` |
| P5 | 「下一题」既是右侧导航又可能是主动作，按钮位置跟着状态跳动 | `SingleQuestionActionBar` |

## 目标交互（仅 v1 卷单题模式；列表模式、legacy、讲练不变）

吸底栏合并为**一个无内嵌边框的容器**：

```
[答题卡(≤lg)]  第 1 / 20 题 · 已提交 0 题  ▁▁▁▁   提前交卷 │ ‹ 上一题   [ 主动作 ]   下一题 ›
```
- 手机宽度：上排为 `‹ 上一题  [主动作]  下一题 ›`，下排为答题卡 + 进度 + 「提前交卷」文字按钮；两排共用一个容器，不再出现卡中卡。
- **主动作只保留一个按钮**（状态机）：
  - 未提交且已作答 →「提交本题」（主色）
  - 未提交且未作答 →「不会，提交并看解析」（次要样式，替代被禁用的提交按钮；与现有空答案提交语义相同）
  - 提交中 →「正在提交…」，切题禁用（同现状）
  - 已提交 →「下一题 →」，右侧导航「下一题 ›」隐藏（不重复同目标）；仍有未提交题时追加「继续未提交题目」
  - 收尾 →「查看本次结果」
  - 整卷反馈（after_attempt）：主动作为「下一题」，末题为「交卷」（同现状）
- 左右导航改为带箭头的轻量按钮（ghost），视觉上与主动作明显区分。
- 进度文案「第 n / N 题 · 已提交 k 题」**移入吸底栏**（文字保持一致，现有单测断言不需要改）；删除工作区的独立进度行。整卷反馈下显示「第 n / N 题 · 已填写 k 题」。进度条按已提交比例显示（整卷反馈按已填写比例）。
- 「交卷」在逐题反馈的单题模式下降级为文字按钮「提前交卷」，仍弹出原交卷确认框（离线、无权限、空卷时禁用不变）。

## 已确认的选择（2026-10-24 11:01，原对话）

用户已选择方案 A。做题方式摘要行（「做题方式：单题 · 每题提交后查看 ⌄」）当前位于题目上方：
- **方案 A（推荐）**：单题模式下不再常驻，「更多 → 做题方式」改为打开弹窗，弹窗内仍是同一个编辑器组件（遵守“唯一编辑器”规则）；列表模式保持行内展示。
- 方案 B：保持现状常驻。

## 文件清单

- `apps/web/src/features/attempt/PracticeWorkspace.tsx`：`SingleQuestionActionBar` 去掉边框卡片、导航加箭头；删除 `SingleQuestionProgressRow`（或改成吸底栏内的进度片段）；（方案 A）`PracticeModeSummary` 支持在弹窗里展示
- `apps/web/src/features/attempt/PracticeQuestionSubmit.tsx`：`PracticeSingleActions` 未提交态合并为单按钮
- `apps/web/src/features/attempt/AttemptBottomBar.tsx`：新增单题紧凑布局（进度槽位 + 次级「提前交卷」）
- `apps/web/src/features/attempt/AttemptSession.tsx`：接线、移除工作区进度行、（方案 A）弹窗承载
- 测试：`practice-question-submit.test.tsx`、`practice-experience.test.tsx`、`practice-single-workspace.test.tsx`、`PracticeWorkspace.test.tsx`、`AttemptBottomBar.test.tsx`；e2e `practice-single-workspace.spec.ts`、`practice-feedback.spec.ts`
- 文档：`AGENTS.md`「作答圈画与草稿交互约定」首条、`docs/页面功能清单.md` 对应小节

## TDD 测试点（先写失败测试）

1. 未作答：只有一个提交类按钮「不会，提交并看解析」，不存在禁用的「提交本题」；已作答：只有「提交本题」。
2. 单题模式下页面上「第 n / N 题 · 已提交 k 题」只出现一次且在吸底栏内（`data-slot="attempt-bottom-bar"`）；工作区不再有 `practice-progress-row`。
3. 逐题反馈单题模式：不存在主色/描边的「交卷」大按钮，存在「提前交卷」并打开交卷确认；离线时禁用。
4. 已提交：「下一题」只出现一次（主动作），收尾后只有一个「查看本次结果」。
5. 吸底栏内的操作条没有自带边框（不出现卡中卡）。
6. （方案 A）单题模式工作区无常驻摘要行；「更多 → 做题方式」打开弹窗，切换布局/节奏仍走原 PATCH CAS；关闭后焦点回到「更多」。
7. 列表模式快照不变（摘要行、底栏「交卷」、题卡 footer 提交区）。

## 验证

`pnpm lint`、`pnpm typecheck`、`pnpm test`（web 相关套件 + 全量）、`pnpm build`、`pnpm e2e e2e/practice-single-workspace.spec.ts e2e/practice-feedback.spec.ts`；手动验证 390 / 820 / 1440 宽度截图对比。完成后在分支内依次做 simplify / code-review 闸门（不涉及学生端载荷，无需 security-review），小步提交。


## 接续实施与根因

原对话在 AttemptSession 接线中断：PracticeModeDialog 与 singleProgressCount 尚未使用，旧测试仍引用已移除的 SingleQuestionProgressRow，底栏未收到新进度。接续首先复跑：相关 39 项测试 22 通过、17 失败；前端类型检查三处错误。

保留原先已写入的组件与测试改动，完成弹窗、进度、唯一操作区接线；新加 Esc 回真实入口焦点测试。旧集成与键盘测试改为断言用户实际看到的吸底进度，不用已取消的常驻摘要作为就绪标志。布局切换即卸载选择项，真实浏览器测试点击关联 label，再验证目标布局与输入保留，避免 check 等待已卸载 radio 的 checked 状态。

## 完整 diff 质量审查

按 simplify → code-review 顺序人工检查（本环境未提供同名可调用技能）：

- simplify：行内摘要与弹窗抽取同一 PracticeModeEditor，摘要文案复用 PracticeModeSummaryText；底栏进度、错误提示、答题卡入口使用共用片段，避免两套布局条件逐渐分叉。页面共用一份编辑器接线，不重复 PATCH/CAS 逻辑。
- code-review：核对逐题未答／已答／提交中／已提交／末题收尾、整卷下一题／末题交卷、离线／失权／保存失败、菜单和弹窗关闭焦点、切布局不重挂题卡。补回进度 aria-live；修复 exactOptionalPropertyTypes 下 progressValue 显式 undefined 类型问题。
- 本次仅调整 UI 呈现与对应测试，不修改学生 API、契约、答案投影、判分及 AI 出站载荷；普通泄露断言与现有浏览器泄露监控保持生效，无需新增受控出口。

## 手动验证步骤

1. 打开 v1 练习，选择单题专注与每题提交后查看：底栏只显示一份题号进度，未答时仅有「不会，提交并看解析」，选择答案后同位变成「提交本题」。
2. 提交后读原位解析，下一题入口唯一；末题自动收尾保留解析，主动「查看本次结果」才进入结果页。
3. 更多 → 做题方式，在弹窗切换布局／反馈节奏；Esc 关闭焦点回更多。列表与单题互切，原输入、草稿和题卡保留。
4. 整卷反馈下主动作为下一题／末题交卷；离线时禁止交卷，保存失败提示仍可见。
5. 390／820／1440 宽度核对底栏不溢出；iPad/Pencil 舒适度及软键盘仍需真机复核。

## 验证结果

- `pnpm lint`：`Checked 1218 files`，无错误。
- `pnpm typecheck`：contract、grading、md-dsl、server、web 与 E2E 类型检查全部完成。
- `pnpm build`：全包构建成功，前端 PWA 预缓存生成成功。
- `pnpm test ...practice-single-keyboard.test.tsx ...practice-question-submit.test.tsx ...practice-single-workspace.test.tsx`：`Test Files 3 passed (3)`，`Tests 56 passed (56)`。
- `pnpm e2e e2e/practice-single-workspace.spec.ts e2e/practice-feedback.spec.ts --workers=2`：Chromium/WebKit，`20 passed (1.7m)`。隔离临时数据库、8899/5199 端口；已有泄露监控继续断言。320–1440 八档链路通过；新增 390/820/1440 的入口唯一、无横向溢出和底栏高度断言，三档截图已目视复核。
- 全量单测：首轮默认并发出现未修改的教师 AI 路由测试超时，终止后降为 `pnpm test --maxWorkers=2` 重跑，`Test Files 481 passed (481)`、`Tests 5718 passed (5718)`，耗时 614.05s，退出码 0。教师 AI 路由测试在该次完整回归通过，无需改动无关实现。
- 本批按原对话要求提交到 `codex/practice-experience-fixes`；真机舒适度复核不由桌面模拟代签。
