# TT-10b（QM-14）讲练原位适配 — 执行报告

分支 `codex/tt-10b`（基点 bd73bc10 = TT-10a 验收合并）。六细项全落（**6/6**），
TT-10 收官。口径与提交明细见决策记录 §24。

## 一、细项交付对照（实施清单 §QM-14）

| 细项 | 状态 | 落点 |
| --- | --- | --- |
| 1. 新材料/组通过安全 blocks 与冻结子题呈现，讲练整篇原文仍不下发 | ✓ | md-dsl：parseLessonDocument 接入 extractMaterialsAndGroups + resolveQmReferences（与 practice/mixed 同构；组用 ::ref 表达不物理包含子题，不触碰嵌套安全前提）；splitLessonBlocks 把材料/组容器行区间整块剔除出 md 段（容器围栏/{{slot}} 槽位标记/::ref 指令文本不外漏）。web：LessonGroupBlock（讲练单列流式组头+MaterialPanel 共享材料）渲染在首个成员题卡之前，作答/完成两视图经 useAttemptContext 取冻结上下文、groupSegmentsOfUnit 单源解释；context 失败非阻断+重试；legacy 卷空投影渲染零变化 |
| 2. 当题提交保存证据、锁定输入、释放本题，主观类进入自评或教师处理 | ✓ | 既有链路打通验证（服务实现零改动）：证据行落库、已提交行答案 PUT 409、released 当题释放恒题级；reference_self/manual_only 行判定恒 null 进自评（TT-09 链路，LessonQuestionCard SelfReviewSection 既有） |
| 3. 最后一题自动收尾，不等待学生逐题自评；已提交行不重判 | ✓ | autoFinishPerQuestionAttempt 既有：三 reference_self 行全部提交、零自评 → attempt 离开 draft；重复提交已提交题 409 QUESTION_ALREADY_SUBMITTED；完形 choice（auto）与 reference_self 混合汇总 correct=1/pending=3 口径在案 |
| 4. 开卷幂等，已完成刷新不增加 attemptNo；仅显式 restart 新开 | ✓ | startLessonAttempt create-or-return 既有：完成后 start 同卷同 attemptNo=1；restart attemptNo=2 空白卷（released 空） |
| 5. 公共解析不提前透露兄弟题答案，嵌套 question 仍为错误 | ✓ | 当题释放后兄弟题详解/参考答案不出现（哨兵断言）；QUESTION_NESTED_IN_LESSON 在材料容器内嵌题块同样 error（lint 层走查链不豁免 material/group 语境，测试锁定）；材料含答案指令 MATERIAL_CONTAINS_ANSWER、未知材料 UNKNOWN_MATERIAL_REF 在 lesson 语境同样 error |
| 6. 重导后的孤儿冻结题继续可见，原位跳转/阅读与旧嵌入单元过滤正常 | ✓ | 重导换全套 id 后旧冻结题仍在 questions（孤儿不丢）、blocks 只含新题槽（孤儿页尾分组既有）；课程目录无嵌入单元条目（lesson-embedded 过滤面不变） |

**验收行**：全部新题型可进入讲练闭环——服务级用例夹具为「材料（slot-1/slot-2）
+ 组（matching + 完形 choice 子题 + ordering）+ 组外 response」讲练页，导入 →
开卷（matchingSlots/matchingOptions/orderingItems/sortableCount 投影 + context
冻结投影）→ 草稿保存 → 当题提交（证据/锁定/释放）→ 末题自动收尾 → 幂等/重开 →
孤儿/过滤，全链断言通过；无任何「lesson 暂不支持」占位。

## 二、修复与实现要点

1. **此前 lesson 文档不抽取材料/组是结构性断点**：题级 ::ref 索引
   （material_refs 表）在导入时对 lesson 同样写入，而材料实体从不落库——
   建卷依赖闭包 requireClosureRows 对缺失材料 fail closed（409
   ATTEMPT_CONTEXT_BROKEN），含材料的讲练页此前开卷即失败（fail closed 非
   泄露）。本单补齐抽取后整链打通，服务端零改动即闭环（TT-08/09/10a 地基
   全部复用）。
2. **keep 模式存储原文不动、切段层剔除**：材料/组容器保留在讲义 markdown
   （位置即 markdown、重导/reparse 的原文真相），学生投影在 splitLessonBlocks
   剔除——与题块同规则、与 mixed 的 strip 同语义，防线在切段单源。
3. **行内式 ::ref{…} 留在公开题干是 QM-13 既有口径**（RefDirective 空渲染，
   不可见结构指针，与练习流一致），不构成泄露；md 段级断言仍保证组容器
   原文（含块式 ::ref）不下发。
4. **legacy 边界**：本单之前导入的含材料讲练页，材料实体未落库——重导同一
   文档即注册修复（新开卷起效）；历史冻结卷不受影响（本就开不出卷）。
   reparse 不重建 lesson 材料（assembleUnitDoc 按单元实体行拼装，lesson 嵌入
   单元无实体行），升级路径=重导，记档不另建机制。
5. **GROUP_ORDER_INVALID 顺带验证**：组 ::ref 引用序必须与题块文档序一致——
   讲练夹具首轮 422 即该码拦截（引用序与文档序不一致），按语料纪律对齐后
   通过（lint 单一出处对 lesson 同样生效）。

## 三、验证（新流程分层三档，真实命令退出码）

- 执行单三档快检：md-dsl 全量 435/435（首轮）→ 契约面全仓 6432/6432
  （packages/md-dsl 目录下 vitest 捡到全仓 workspace）；lesson 文件 42/42；
  web LessonGroupBlock 3/3 + StudentLessonPage 16/16（新增 2）+ ai 5/5；
  typecheck:affected Done（首轮揭 split-lesson 谓词负向收窄 TS2339 ×2、
  测试两处 optional/TS2739，当场修复后复绿）；lint:changed 首轮揭 6 文件
  format + organizeImports，biome 收口后清洁（订正：该表述失实——后续
  3a4bfc27 又引入一处 format 错使 lint:changed 退出码 1，验证单已揭、
  修复附录已订正）。
- 收口（兜底全量如实执行）：test:affected 命中迁移兜底 → 全量（数字见
  §四）；e2e:affected 命中迁移兜底 → 全量 chromium（数字见 §四）。
- `pnpm typecheck` 一次 + gen:spec/schema:export：契约零改动（git diff
  codex/qm..HEAD -- packages/contract 为空），无需再生。

## 四、收口验证数字

- `pnpm test`（test:affected 兜底全量）：**529 文件 / 6442 用例全绿 EXIT=0**
  （基线 6423 + 本单 19：parse 5 + split-lesson 4 + lesson 六细项 5 +
  LessonGroupBlock 3 + 页面 2）。
- e2e:affected（迁移兜底全量、本机 chromium）：**124 过 / 1 skip（fixme）/
  1 挂 EXIT=1 → 挂例隔离复跑 1/1 过 EXIT=0（49.0s，warm 100.8–126.9ms 全部
  ≤150ms）**——挂例为既有「130 题长作业性能预算」用例（TT-10a P3-① 同款
  满载计时噪声，预算口径待拍板项），判环境负载抖动、与本单无关。

## 五、硬性边界对照

防泄露零放宽（assertNoLeak + 六哨兵双断言随新面、md 段级容器剔除断言、
原文投影恒不下发）；DSL 只增不改（注册表零改动、既有指令全量复用、
splitLessonBlocks 剔除是学生投影侧不是存储侧）；判分只在服务端且新题型恒
null（gradeResponseRow 零改动）；零新依赖；零新迁移；教师端 UI 不动。

## 六、遗留

- 审查 P3-2（samples/qm 增补 lesson×材料/组×新题型语料）：留 QM-15——
  语料框架按 practice 锁型（contract qm-corpus.test.ts 的
  ExpectedValid.kind: "practice"、md-dsl 名册同源），扩 lesson 语料需
  同时改两处名册与类型锁，属 QM-15 语料批次，不在本收尾单顺手范围；
  现状唯一 lesson 样例 samples/v2/讲练样例.md 无材料/组，该组合面仍仅
  单测锁定（lint 红线与切段剔除已由本修复附录补测试收口）。
- TT-10a P3 未修项维持记档不属本单范围：①note-service 逐行
  materialSlotOrderOf N+1（缓存优化建议）；②attempt-service 保存路径重复
  查询与无谓材料扫（matching 短路建议）；③材料槽位 code/math 同名 id 字符串
  替换（语料不可达论）；④130 题预热 150ms 预算口径待拍板。
- legacy 含材料讲练页升级路径=重导（见 §二-4），无自动迁移。
- 真机验收：讲练页组段阅读（材料面板长文滚动、窄屏堆叠、xl 布局）留人工
  核对（自动化已覆盖 DOM 序与渲染断言）。

## 七、修复附录（编排者验收后，2026-10-25）

**验证单不符项与报告失实订正**：验证单唯一不符 = lint:changed exit 1
（3a4bfc27 引入 student-lesson.test.ts:3075 单行 format 错）；§三
「biome 收口后清洁」随之失实——该 format 错在收口检查之后引入，本附录与
§三内联均已订正，format 已收口（26d3e8be）。

**审查 P1-1（必修，嵌套材料/组绕过三防线）**：修法 = lint 红线 + 切段兜底
（0800a257）。lint walk 对 material/group 复用 isTopLevel 判定，非顶层在
lesson/mixed 记 error（MATERIAL_NESTED_IN_CONTAINER /
GROUP_NESTED_IN_CONTAINER，走 error 阻断导入与编辑保存）；splitLessonBlocks
全树剔除非顶层材料/组行区间（legacy 存量兜底）。API 级口径理由：嵌套材料
原文（含 [[答案]] 文本、{{槽位}} 标记）随学生 md 段原样下发即触规则 3，
UI 空框渲染不算防线。测试先行（lint 双 kind + 切段剔除，含 QM_SECRETS
哨兵「[[」断言）。mixed 侧 TT-06 沿袭的同构缺口由本红线一并覆盖（同
error 阻断导入与重导；mixed 讲义 strip 走 containerRanges 顶层口径，
嵌套容器属非法形态由 lint 拦截，无需切段改动）。

**审查 P2-1（必修，lesson 正文裸 [[…]]，pre-existing）**：修法 =
BLANK_MARKER_OUTSIDE_QUESTION error 规则（b0ed8aaf）：lesson/mixed 讲义
正文（题块外）完整 [[…]] 标记记 error；题目内合法、材料内
MATERIAL_CONTAINS_ANSWER 单报、组头 introMd 学生投影照报；lecture
（无题目语境，非未交卷答案泄露）与 practice（无学生下发面）不加严。

**P3×3**：P3-1 §三数字订正（19/19 → 16/16（新增 2））；P3-2 samples/qm
lesson×材料/组语料留 QM-15（§六记档：语料框架 practice 锁型，扩型需动
两处名册）；P3-3 contextError 固定文案 + 重试、不再透出 error.message
（测试双断言：固定文案出现、技术文本不出现）。

**修复复验数字**（真实命令退出码）：修复 3 提交 + 记档 1 提交；三档快检
EXIT=0（test:quick / typecheck:affected / lint:changed）；md-dsl 定向
32 文件 442/442；StudentLessonPage 16/16 ×3 轮（首轮 1 挂经 stash 对照
定位为共租负载噪声，非回归）；**test:affected 529 文件 / 6445 全绿
EXIT=0**（= 6442 + 防线新增 3：lint P1 ×1 + 切段 P1 ×1 + P2 ×1）；
gen:spec 连跑两轮幂等（lint 规则 64 → 67：新增三个 error 码并登记
规范三件套 + dsl-kit）。
