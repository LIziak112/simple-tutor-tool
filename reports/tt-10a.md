# TT-10a（QM-13）完形、配对与排序交互全链路 — 执行报告

分支 `codex/tt-10a`（基点 b3b8ded4 = TT-09c 验收合并）。六细项全落（**6/6**）。
口径与提交明细见决策记录 §23。

## 一、细项交付对照（实施清单 §QM-13）

| 细项 | 状态 | 落点 |
| --- | --- | --- |
| 1. 完形每空独立 choice；公共文章不用带答案的 [[…]] 标记充当选择槽位 | ✓ | 结构既有（材料 {{slot}} + choice 子题 ::ref{slot=} 逐空绑定）；MaterialPanel 把 {{slot-id}} 按材料槽位序渲染为编号空位（**（N）**，choice/match 同口径；未声明 id 防御性原样保留）——「第 N 空」与材料编号一一对应 |
| 2. matching 稳定 slotId/optionId + 显式可重复/不可重复与干扰项 | ✓ | optionId/slotId 即 DSL 稳定 id（导入规范化回写）；allowRepeat 服务端/客户端同口径（不可重复时已占选项在其他槽位下拉禁用）；干扰项在池内不标记可选（§6.1 调整 6）；matchingSlots 服务端按材料槽位序展开（expandSelectionIds 单源）随公开投影与结果快照下发 |
| 3. ordering 保存 itemId 顺序；固定项、未放项与干扰项语义明确 | ✓ | 板式控件：固定项预置声明位锁定（不可移/不可移除）、待排序项池「加入排序」入首空行、上下移跳固定行、移除回池；保存序列固定项仅锚定入序（上方行全满才入）；恢复保序不保距（完整作答无差异）；干扰项可放入、服务端拒绝（学生从拒绝信息得知） |
| 4. 输入只检查合法结构；参考答案仅公布后展示；不增自动判分器 | ✓ | saveDraftAnswer 经契约 inspectShapeOfAnswer 单源调度（未知槽位/选项/项、重复占用、干扰入序、固定错位 → 400 VALIDATION_ERROR）；部分作答/空清除态合法；永不比对参考答案；gradeNewKindAlwaysNull 未动；旧七型零变化（NEW_QUESTION_TYPES 集合门控） |
| 5. 键盘/按钮、移动触摸、只读、对照、静态导出、完成度 | ✓ | 原生 select（键盘/触摸原生语义）+ 原生按钮（≥44px、aria-label）；readOnly/disabled 数据流锁定；ResultAnswerComparison 通用占位转正逐项对照（占位条件 `answerKind in answerKindViews` 登记后自动消失）；静态导出走 QuestionSurface mode=export（登记表单源）；完成度 matching 按已配槽/声明槽、ordering 按已放非固定非干扰项 |
| 6. 提交后「未填写」与「未判断」不混为一类 | ✓ | 空 pairs 提交：answer 原样保留（未填写）、finalCorrect/autoCorrect 恒 null（未判断）、gradingPolicy=reference_self + selfReview.record=null（待自评）——三者投影互不替代（服务级断言）；对齐 TT-09c effectiveVerdictOfRow 体系 |

**验收行**：二十空重排不串答（答案按题 id 存储 + 槽位按 id 绑定，结构保证；
samples/qm/valid-03 语料在案）；配对约束正确（不可重复 400 + 客户端禁用 +
allowRepeat 语义）；固定项不能错移（UI 锁定 + FIXED_ITEM_OUT_OF_POSITION 400）；
三种形态完整保存/恢复/自评（服务级往返 + 结果视图/待自评断言）。

## 二、强制携带

1. **sample-rendering 守卫转正**：QM13_PENDING_TYPES 武装断言删除，完整样例
   sample-q8（matching，slots=slot-tue..slot-wed 非数字区间）/sample-q9
   （ordering）首次以真实控件断言渲染（槽位下拉数/选项池+占位、排序区行数/
   固定徽标/加入按钮数）；文件头守卫文案同步订正。
2. **DSL 四步纪律**：注册表零改动（matching/ordering/cloze 全量复用 TT-06
   既有指令），未走新增指令流程；契约改动（questionPublicSchema.matchingSlots、
   attemptResultQuestionSchema.snapshot 三键）→ `pnpm schema:export` 重跑提交；
   `pnpm gen:spec` 重跑（连跑两次零漂移，dsl-kit/tutor-lint.mjs 为 attempt.ts
   变更后的确定性再生件，随 docs 提交——CI diff 空口径满足）。
3. **samples 兼容回归**：历史样例零改动；samples/qm 既有语料（valid-03/04/05）
   继续解析渲染一致；本单未新增语料（既有八份覆盖完形/七选五/固定项排序）。

## 三、防泄露与边界

- 保存校验不比参考答案；草稿视图 assertNoLeak + 详解哨兵断言（服务级）；
  matchingOptions/orderingItems/matchingSlots 全部为公开作答面结构
  （distractor/fixedPosition 属公开结构，§6.1 调整 3/6），无答案内容。
- 判分只在服务端且新题型恒 null；教师端 UI 零改动；零新依赖；零新迁移
  （matchingOptions/orderingItems 循 §19.2-4 sourceMd 重抽口径，零专列）。

## 四、测试与验证（真实命令退出码）

| 命令 | 结果 |
| --- | --- |
| pnpm test:affected（契约兜底全量） | **6414/6415，EXIT=1**；唯一失败 apps/server/src/config.test.ts 会话密钥例 = 全套件并行下 secret.key 文件竞争偶发（TT-08b P3-5 同款形态），**单文件隔离复跑 5/5 EXIT=0** |
| pnpm typecheck:affected | Done，EXIT=0（每提交块后执行） |
| pnpm lint:changed | 清洁 EXIT=0（每提交块后执行） |
| pnpm test:quick（三档快检） | 6397→6413 全绿（分块执行） |
| pnpm gen:spec ×2 | EXIT=0，零漂移（确定性再生） |
| pnpm e2e:affected（契约兜底全量，本机 chromium 126 例） | **124 过 + 1 跳过（既有 skip）+ 1 失败 EXIT=1**；唯一失败 student-workspace「130题长作业」为性能预算断言（warm 帧 153.7ms vs ≤150ms，超 2.4%）——**隔离复跑 1/1 过 EXIT=0（50.1s）**，判定为全量并行下计时噪声（共租机器负载，记忆口径同款），非功能回归 |

## 五、遗留

- e2e:affected 唯一失败（130题长作业性能预算 153.7ms>150ms）已隔离复跑转绿；如编排者需强证据可在安静窗口背靠背复测该 spec。
- QM-14（lesson 原位适配）消费本单结构投影；题级反馈面的 matching/ordering
  对照已随 QuestionFeedback 自动获得（共用 ResultAnswerComparison）。
- 材料槽位标记在 code/math 环境内的同名 id 会被字符串替换误命中（实际
  语料不可能：槽位 id 声明于正文文本节点；防御口径已在 MaterialPanel 注释）。
