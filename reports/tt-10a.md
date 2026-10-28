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
  （~~distractor/fixedPosition 属公开结构，§6.1 调整 3/6~~ **2026-10-25
  审查 P1 裁定修订：distractor 学生侧逐项剥离、sortableCount 计数替代，
  见 §六**；fixedPosition 仍属公开结构），无答案内容。
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

## 六、修复附录（审查修复轮 + 两轮截断执行史，2026-10-25）

主交付（§一–§五）后编排者审查：P0 无、P1×1 裁定收紧、P2×2、P3 处置
清单（见文末）。修复历三轮会话、**两轮截断**，执行史如实记档：

- **主交付轮**：5 feat + docs 记档（14ced83a）；e2e:affected 因会话截断
  分两段收口（9172907f 中期补记 83/126 例 0 失败 → 74decb6f 收口补记
  124 过 + 1 skip + 1 挂）——**截断一**。
- **尾单修复轮**：完成 P1（7a6db3bc）与 P2-1（35becee6）两提交；P2-2
  （matchingSlots 行附材料槽位序）与「验证单部分符项转正」（二十空翻序
  用例）推进至 14 文件 WIP（+572/−192，横跨 contract content/attempt、
  server attempt-service、web prepare-question/matching 视图、qm13 测试
  与 gen:spec 三件套）时于 101 轮截断——**截断二**。
- **尾二轮（收口单）**：读全 diff 判定 WIP 完成度——无逻辑半成品，仅翻序
  用例存两处 TS 错误（`DOC_SLOTS as const` 收窄 `indexOf(string)` 参数
  TS2345、未用参数 TS6133）与 4 处格式偏差 + CRLF 行尾（typecheck:
  affected / lint:changed 揭出），当场修复并入提交；按内聚面分两块落盘
  （P2-2 全链 c669167c 14 文件 / 翻序用例 709d562f）；gen:spec 重跑
  零漂移亲测；三档快检 + test:affected 全绿留痕；验收记录 / 总清单 /
  本附录记档。

### 修复明细

1. **P1 裁定收紧（7a6db3bc，两决策修订之一——修订决策记录 §23.2-3 与本
   报告 §三口径）**：原口径按 §6.1 调整 3/6 把 distractor 当公开结构逐项
   下发；审查裁定 ordering 干扰项由参考序列推导，**逐项下发 distractor 键
   = 公布前枚举答案成员，触硬规则 3 底线**。修法：契约新增
   matchingOptionsStudentSchema / orderingItemStudentSchema 学生面变体
   （逐项剥离 distractor），questionPublicSchema 与结果快照改携带
   sortableCount（非干扰且非固定项数）替代计数；publicOfSnapshot /
   resultQuestionOf 两投影走学生面变体，保存校验（structuresOfSnapshot）
   继续用快照全量结构（干扰入序 / 固定错位 400 不回归）；web PreparedOf
   ordering 以 sortableCount 派生板行数与完成度，matching 选项模型去
   distractor（呈现零消费已证）。教师全量结构不变。服务级断言：公布前
   草稿 / 公布后结果载荷逐项无 distractor 键 + sortableCount=4。
2. **P2-1 旧冻结快照 sourceMd 兜底重抽（35becee6）**：QM-13 前冻结的旧
   快照无 matchingOptions/orderingItems/materialRefs 三键，原投影直接
   降级「结构不完整」——学生对新题型旧卷无法作答。修法：
   effectiveStructureOfSnapshot 三键全缺且题型属新题型时，从快照自身
   sourceMd 重抽（qmStructureOfSourceMd 同款管线、行内冻结 unitId 作
   解析语境；不引活库、不回写库，冻结语义不变）；部分缺键 = 真脏数据
   不兜底。publicOfSnapshot / resultQuestionOf / structuresOfSnapshot 三
   投影入口接入；保存校验用重抽全量结构——旧快照干扰入序 / 固定错位
   照旧 400，服务端校验不因旧快照放宽。四 publicOfSnapshot 调用方（草稿
   视图 / 取卷 / 讲练开卷 / 题目笔记本）传 unitId。
3. **P2-2 matchingSlots 行附材料槽位序（c669167c，两决策修订之二——修订
   决策记录 §23.2-1 口径）**：原口径 matchingSlots 为纯 slotId 列表，学生
   端「第 N 空」按下标 +1——子集选择（slots=slot-3..slot-5）显示
   「第 1/2/3 空」与材料面板编号空位（3）（4）（5）错位。修法：契约
   matchingSlots 由 string[] 改 `{id, ordinal}[]`（ordinal = 槽位材料
   文档位 1 起），服务端 matchingSlotsProjection 展开时按材料槽位序附
   序（显式单点未知 id 防御形态回落题内行序保证恒正）；保存结构校验仍
   只认槽位 id 集合（ordinal 呈现专用、校验零消费）；web
   PreparedQuestion matching.slots 携带行，matchingView 标签 / 对照 /
   完成度全部改用 ordinal；新增子集配对夹具 pd-2 断言（序号 3/4/5 沿用
   材料编号）；gen:spec 三件套（content.json ×2 + tutor-lint.mjs）随
   契约再生，重跑零漂移亲测（CI diff 空口径满足）。
4. **验证单部分符项转正（709d562f）**：主交付验收行「二十空重排不串答」
   原为 samples 语料 + 结构论证的人工核对项——转正为服务级回归用例：
   二十空翻序夹具（材料槽位文档序与 id 数值序整体错位：s-13 居首…s-15
   居末；mt-1 翻序声明显式单点 + 区间；15 道逐空 choice 子题列举序与
   空位文档序错位，第 1 道子题绑定材料第 6 位空）。两断言：①展开按
   材料文档序带出未点名槽位（s-7..s-9 带出 s-1/s-20）且 ordinal 沿用
   文档位；②逐题保存 → 交卷 → 结果回读，答案恒挂本题 id 不串位。

### 修复复验（尾二轮收口，全分支终态，真实命令退出码）

| 命令 | 结果 |
| --- | --- |
| 定向 vitest（contract qm-answers / server qm13 / web 四文件） | 24/24、16/16（含子集断言与翻序两例）、64/64 全绿 |
| pnpm test:quick | 树已提交 → 空集 EXIT=0（符合设计） |
| pnpm typecheck:affected | 首轮 EXIT=1（翻序用例 TS2345/TS6133 两处）→ 随 709d562f amend 修正后 **EXIT=0** |
| pnpm lint:changed | 首轮 EXIT=1（CRLF 行尾 + 4 处格式）→ biome format 收口后 **EXIT=0**（1319 files，migrations 兜底全量口径） |
| pnpm test:affected | **EXIT=0（215.35s）：528 文件 / 6423 用例全绿**（较主交付轮 §四 6414 净增 9 = P1 + P2-1 + P2-2 + 翻序用例；主交付轮唯一失败 config.test.ts 未复现，系并行 secret.key 竞争偶发） |
| pnpm gen:spec | 重跑 diff 不变（零漂移） |

### P3 处置清单

- 130 题长作业性能预算（满载 153.7ms > 150ms）：隔离复跑过判计时噪声，
  安静窗口背靠背复测选项留编排者；预算口径待拍板（同 TT-09c P3-4 项）。
- 材料槽位 code/math 环境同名 id 字符串替换误命中：实际语料不可能（槽位
  id 声明于正文文本节点），防御口径注释在案，不修。
- 重排不串答人工核对项：本单已转正为服务级用例（709d562f），闭环。
- QM-14 对本单结构投影的消费：随 TT-10b 第二单，不属缺陷。

**验收结论**：TT-10a（QM-13 部分）验收通过——验证单 7/8 全符 + 1 部分
符（环境噪声项）；QM-13 实施清单已勾选；TT-10 完成框不勾（QM-14 待
TT-10b）。裁定与复验数字详见[验收记录](docs/题目模型与练习适配/验收记录.md)
TT-10a 编排者验收加注。
