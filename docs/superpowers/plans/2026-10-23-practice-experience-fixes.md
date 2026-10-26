# 练习工作区体验修复计划

日期：2026-10-23。分支：`codex/practice-experience-fixes`，起点 `v2` / `b2770a02`。

范围：实际体验报告 F01–F12。用户确认后已完成三批实现与回归，验收结果见 `docs/审查报告/2026-10-24-练习体验修复验收.md`；仓库原有未跟踪的题目模型升级材料不纳入本任务。

## 第一批：反馈行为正确性（F01、F02、F03）

文件清单：
- `apps/web/src/features/attempt/AttemptSession.tsx`
- `apps/web/src/features/attempt/PracticeQuestionSubmit.tsx`
- `apps/web/src/features/attempt/QuestionFeedback.tsx`
- `apps/web/src/features/attempt/attempt-queries.ts`
- `apps/web/src/features/attempt/use-practice-question-submit.ts`
- 对应组件与查询测试，及 `e2e/practice-single-workspace.spec.ts`、`e2e/practice-feedback.spec.ts`

步骤与测试点：
1. 先补失败回归：单题＋整卷反馈不出现逐题提交、即时解析入口；Enter 与按钮采用相同动作裁决，末题可正常整卷交卷。
2. 已授权题级反馈优先显示服务端最终判定，缺省时使用已有自动判定；自动判定也为空才显示待批。测试正确、错误、最终改判优先与真正待批，不进行客户端判分。
3. 以受控计时与在途查询重现末题反馈被详情重取覆盖的问题。追踪暂停集合、QueryObserver 计时器、已有请求和页面呈现边界，再修复根因。
4. 末题提交后跨两个轮询周期、切窗与重连仍留在本题解析；点击查看结果后正常收敛，离开重入读取权威结果。
5. 不放宽普通学生接口，不改变教师私注投影；沿用现有契约字段。若调查发现必须改变数据结构，先改 contract schema，再改实现并补泄露测试。

## 第二批：工作区入口与阅读收敛（F04–F08）

文件清单：第一批相关文件，加 `PracticeWorkspace.tsx`、`AttemptBottomBar.tsx`、`AttemptQuestionCard.tsx`、`QuestionSurface.tsx`、`AttemptResultParts.tsx` 及必要对应测试。只修改实际需要的文件。

步骤与测试点：
1. 明确单题布局唯一主操作区：提交本题／下一题／查看结果持续可达；提前交卷保留为次级操作。保留离线、保存失败、冲突及缺稿确认。
2. 下一题仅保留一个；继续未提交题目仅在目标与下一题不同的时候出现。补首题、中间题、末题与跳题后的目标测试。
3. 桌面侧栏与弹层导航按可用空间互斥；手机仅一个导航入口。侧栏收起仍有恢复路径。
4. 本卷仅一套做题方式编辑器；更多菜单打开同一面板，摘要与进度合并呈现。默认偏好与开始页预选保持各自作用域。
5. 已提交选择题保留同一题面宿主，在原选项上显示授权的选择／正确项信息，删除反馈区第二份完整选项。验证未提交题不展示正确项、教师限制后不残留越权内容。
6. 320/390/768/820/1024/1440 宽度检查；长题、手写、AI 打开时主操作可达；切布局不丢输入、不重挂题面、不破坏笔迹几何。

## 第三批：说明与键盘可达性（F09–F12）

文件清单：`StudentPracticePreferenceSection.tsx`、`PracticeWorkspace.tsx`、`AttemptSession.tsx`、`features/teacher-settings/PracticeFeedbackSection.tsx` 及对应测试。

步骤与测试点：
1. 更新已启用快捷键说明；纯文案与样式可豁免 TDD，但行为改变必须先写失败测试。
2. 首次提交后明确解释节奏已锁定，区别教师限制；不在客户端猜测服务端授权。
3. 教师说明区分新卷默认值与进行中卷即时限制，保留已下发内容无法撤回的真实语义。
4. 导航记录实际打开入口；Esc 关闭恢复入口焦点；跳题则聚焦当前工作区。覆盖桌面与手机入口。

## 质量闸门与验证

1. 每批先失败测试、后实现，再运行相关测试；每个提交保持类型检查、构建与测试通过。
2. 完整 diff 依次执行 simplify、code-review；涉及答案显示与学生投影，追加 security-review。确认发现当场修复，未修逐条说明，不用测试通过代替审查。
3. 执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；相关 E2E 在独立临时数据库与 8899/5199 端口运行 Chromium/WebKit，不复用用户 5173 作答。
4. 若改契约／注册表／DSL，运行相应 `schema:export`／`gen:spec`，检查现存 samples 兼容；本计划预期不改这些领域。
5. 同步 AGENTS.md 或相关用户功能文档，记录真实命令输出、手动复现步骤与未验证真机项；不修改无关的题目模型升级材料。
6. 分支全绿并完成闸门后，按项目顺序先合入 v2，再处理 main 发布；有未完成验收时保持分支并如实报告，不提前宣称完成。

## 需人工确认

实现与自动化完成后，iPad/Pencil 舒适度、软键盘遮挡及真实 AI 回复阅读仍需真机验收。自动化通过不替代这些项目。
