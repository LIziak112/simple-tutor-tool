# Phase 3 任务清单（教师数据与学生记录）

> 从《`docs/开发任务清单.md`》分离而来；全局约定（API 前缀、响应格式、主键、时间等）见该文档 §0.3，任务分支与 🧑 规则见其 §0.2，**均继续适用**。
> 配套文档：`docs/技术架构与实施方案.md`（下称"架构文档"，引用写作 §x.x）。本文只写**做什么、按什么顺序、怎么验收**；判分/批改/记录的设计细节以本文 §2 为准（与架构文档冲突时以本文为准，T3.6 收尾时同步回架构文档）。
> 执行对象：GLM 5.3。每次只下达**一个任务（T3.x）**。
> **顺序前提**：Phase 2A（`docs/Phase2A改进任务清单.md`，至 T2A.9）与 Phase 2B（`docs/Phase2B改进任务清单.md`，至 T2B.8）全部完成后开始。
> **2026-09-29 重写说明**：本版吸收了 T2A.9 / T2B.8 计划中的 Phase 3 条目修订（按课程视图、来源筛选、历次展开、记录分组、错题本口径、教师域化），并落实用户四项决策（§2 标注「用户定」）。**原 T3.6（旧版数据迁移）已整体删除**（用户决策：旧版数据不迁移，内容届时以 .md 重新导入）；T3.6 现为收尾任务。任务完成后在 [`docs/进度表.md`](进度表.md) 打勾。

---

## 0. 使用方法

### 0.1 每个任务的下达提示词

```
阅读 AGENTS.md、docs/技术架构与实施方案.md、docs/开发任务清单.md（§0 全局约定）、docs/Phase3任务清单.md。
本文 §2 设计决策已定，不要重新讨论。执行任务 <T3.x>，只做该任务范围内的事。
1. 先阅读与本任务相关的现有代码，列出：要新建/修改的文件、契约变更、实现步骤、要写的测试。等我回复"确认"。
2. 确认后实施。完成后运行 pnpm lint && pnpm typecheck && pnpm test && pnpm e2e，贴出结果。
3. 逐条对照该任务的「验收」自查，说明每条如何验证。
4. 本文 §2 未覆盖的设计决策，停下来问我，不要自行假设。
```

### 0.2 规则

- 严格按编号顺序执行；「依赖」未完成不得开始。每个任务一个分支 `task/T3.x`，验收通过后合并到 `v2`。
- **每个任务结束时应用必须完整可用**：`pnpm e2e` 必须保持全绿（若任务改变了 E2E 覆盖的流程，在本任务内同步更新用例）。
- **契约优先**（硬性规则 1）：涉及数据结构的改动先改 `packages/contract` 的 Zod schema 再实现，完成后运行 `pnpm schema:export` 并提交。
- **判分逻辑修改先补测试**（硬性规则 9）：T3.2 对「未作答客观题判错」的语义变更，必须先写用例再改实现，并同步修订 T2.5/T2.6 时期锁定的相关测试期望与契约注释。
- **学生端任何新增/修改接口都必须接入 `assertNoLeak` 泄露测试**（硬性规则 3）。
- **域隔离红线（沿用 T2B 口径）**：本阶段教师端每一个按 id 取数的新接口，都必须有「教师乙访问教师甲资源 → 404」的服务测试。
- 本阶段**无数据库结构变更**：批注相关列（`responses.teacherMark / teacherComment / finalCorrect`、`attempts.scoreFinal`）已在 T2.6 预留，直接启用；若实施中发现确需结构变更，走 drizzle 迁移并在任务报告中列出理由。
- 带 🧑 的验收项需要用户本人手动检查。完成后在 `docs/进度表.md` 打勾。

### 0.3 本阶段明确不做

- **旧版历史数据迁移**（用户已决策放弃）：原「导入 content.json 与 submissions、按姓名建学生、批注迁移」的任务整体删除；旧内容届时以 .md（v1/v2 均可，现有导入流程已支持）重新导入资源库。
- 学情聚合分析页（完成矩阵、趋势、考点统计——属 Phase 4）：本阶段教师端只呈现**原始作答数据 + 批改 + 导出**。
- 学生端笔迹回放：回放仅教师端；学生记录页只看 PNG 快照（如需再立项）。
- 批改完成的消息推送/通知：学生端以状态徽章体现，不主动推送。
- 重新设计答题页、改动作答流程（T3.x 只读消费作答数据，不改动作答链路）。

---

## 1. 目标模型

```
教师侧   数据页（/t/data）：按学生 / 按作业 / 按课程 三视图 + 待批队列
              │ 点击作答
              ▼
         作答详情：逐题（快照题干 · 本人答案 · 判定 · 用时 · 提示 · 改答案 · 笔迹缩略图/回放）
              │ 改判 / 评语（详情页内联 或 待批队列连续批改）
              ▼
         scoreFinal / status=graded → 作业名单、进度矩阵、学生端记录联动更新 → CSV 导出

学生侧   我的记录（/s/records）：作业组 + 课程练习组（历次展开）
              │ 点击单次
              ▼
         单次结果视图（现有接口扩展）：对错 · 参考答案 · 详解 · 笔迹 · 老师评语
         错题本（/s/records/wrong）：最近一次做错的题 + 首次是否做对标注 + 考点筛选
```

判分链（本阶段定稿）：`autoCorrect`（服务端自动，未作答客观题=**false**）→ `teacherMark`（教师批改/改判，优先）→ `finalCorrect`（统计唯一口径）→ `scoreFinal`（分母=全部题）与 `status`（draft → submitted → graded）。

---

## 2. 设计决策（已定，实施时不得更改）

> 标注「用户定」为 2026-09-29 用户拍板；标注「默认」为编排者按现状推演的既定口径，如需推翻请在对应任务下达前提出。

### 判分与状态机

- **D1 未作答客观题自动判错（用户定）**：交卷判分时，判断/单选/多选/填空**完全未作答**（`answerJson = null`）的题直接记 `autoCorrect = false`（恢复旧版口径），不进待批队列。判定逻辑放 `packages/grading`（可自动判分题型 + answer 为 null → false），先补用例再改实现；`attempt-service` 与 `contract/attempt.ts` 的相关注释、T2.5/T2.6 锁定的测试期望同步修订。此后 `autoCorrect = null` 只剩两种：手写题（待批）、题目无标准答案。
  - 附带影响（一并修订）：`scoreAuto` 公式不变（答对 ÷ autoCorrect 非 null 的题数），但未作答客观题从此进入分母，数值更真实；学生端结果视图对未作答题显示 ✗（原显示待判定）；受影响的既有断言（结果汇总 correct/wrong/pending 计数、进度矩阵与作业卡片得分）逐个核对更新。
  - 填空**部分空有答案**不属于未作答，按现有判分规则正常判定。
- **D2 scoreFinal 分母 = 全部题（用户定）**：`scoreFinal = finalCorrect 为 true 的题数 ÷ 该 attempt 全部题数 × 100`（四舍五入）。`status = graded` 当且仅当该 attempt 全部 responses 的 `finalCorrect` 均非 null；清除批注使题目回落 null 时，status 回 `submitted`、`scoreFinal` 置 null 重算。所有界面「得分」展示**有 scoreFinal 用 scoreFinal，否则 scoreAuto**（作业卡片、课程进度矩阵、单元卡片首次/最近/最高分、我的记录、CSV）。
- **D3 批注语义（默认）**：`POST /api/teacher/responses/:id/mark` 请求 `{ mark: 'correct' | 'wrong' | null, comment: string | null }`，两字段一次提交（UI 上判定与评语一起保存）。`mark = null` 清除教师判定（finalCorrect 回落 autoCorrect），`comment = null` 清除评语。**允许对任何已交卷的题批注/改判**（含自动判过的题，入口在详情页），不限待批队列。对 draft attempt 批注 → 409 `NOT_SUBMITTED`。
- **D4 待批队列口径（默认）**：`autoCorrect = null` 且 `teacherMark` 为空（D1 之后即：手写题 + 无标准答案题）。排序 `submittedAt` 升序（先交先批）；支持按课程 / 作业 / 学生筛选。

### 教师端数据页

- **D5 草稿可见（用户定）**：数据页**包含进行中作答**，列表带显著「进行中」徽章；详情页只读展示当前草稿（已答内容 + 笔迹），判定列显示「未交卷」，不做实时自动刷新（刷新才更新）。
- **D6 三视图与来源筛选（T2A.9 修订并入）**：按学生 / 按作业 / **按课程**（课程视图 = 该课程下的课程练习历次 + 关联作业）；列表支持 `sourceType`（assignment/course）、`status`（draft/submitted/graded）、学生、时间范围筛选；分页 `limit/offset`（默认 50，最大 200）。
- **D7 详情页逐题字段（默认）**：全卷连续题号 + 所在单元节标题、题目快照公开形态（题型、难度、考点、题干）、学生答案、`autoCorrect`、`finalCorrect`、`teacherMark`、`teacherComment`、`activeSec`、`hintsUsed`、`changeCount`、手写信息 `{ inkId, pngUrl, hasStrokes }`。手写缩略图懒加载、点击放大（lightbox）；顶部得分汇总（对/错/待批计数、scoreAuto、scoreFinal）。
- **D8 入口衔接（默认）**：作业详情名单中「进行中/已交卷/已批改」状态点击 → 该生 attempt 详情；课程进度矩阵的历次列表点击 → attempt 详情（替换 T2A.6 的占位交互「点击单元格暂只显示历次列表」）。

### 学生端记录

- **D9 复用结果视图，不新建 records/:attemptId（默认）**：扩展现有 `GET /api/student/attempts/:id` 结果契约（`attemptResultQuestionSchema` 等），新增 `teacherMark / teacherComment / finalCorrect`，汇总新增 `scoreFinal` 与待批标记。快照形态与既有泄露规则不变（已交卷后本就公布答案详解）。若 T2A.8（after_due 公布时机）此前已实现，评语与对错同样受公布 gate：截止前只显示本人答案与「待公布」。
- **D10 records 聚合（T2A.9 修订并入）**：`GET /api/student/records` = 作业组（每作业：状态、得分、待批数、进行中标记）+ 课程练习组（按课程分组：单元 × 历次 attemptNo / 时间 / 得分 / 待批，及首次 / 最近 / 最高分）。已移出课程的**已交卷**记录保留可见（T2A D7 口径）；已失权的进行中草稿不列出。
- **D11 错题本口径（T2A.9 修订并入，默认补全聚合键）**：聚合键 = (学生, questionId)，**跨全部来源（作业 + 课程练习）取最近一次已交作答**，`finalCorrect = false` 入本；条目标注「首次是否做对」与最近一次来源（课程/作业名）。默认隐藏「最近已做对」的题，提供「显示已攻克」开关；考点筛选为服务端参数。答案/详解下发遵循 D9 的公布 gate。

### 笔迹回放

- **D12 回放数据与降级（默认）**：教师端新增矢量数据接口 `GET /api/teacher/ink/:inkId.json.gz`（域判定；文件缺失 404）。`<InkReplay>` 按 `engine` 分派：atrament 按点时间戳重演；excalidraw 按元素顺序逐笔（无精确时间戳，匀速近似）。无矢量数据（仅剩文件缺失的异常情形）时降级显示 PNG + 「无回放数据」提示。

### 导出

- **D13 CSV（默认）**：包含**全部来源**（作业 + 课程练习），筛选 `studentId / courseId / assignmentId / sourceType / from / to`；UTF-8 BOM；每题一行（仅已交卷 attempt），列：学生、来源类型、课程、作业或单元（课程练习含「第 n 次」）、提交时间（北京时间）、单元标题、全卷题号、题型、难度、考点（分号分隔）、学生答案（序列化文本：多选/多空按序拼接，手写题为最终答案文本）、自动判定、最终判定、判定来源（自动/教师）、用时（秒）、提示数、改答案次数、教师评语、手写笔迹 PNG 链接（仅手写题，教师端绝对 URL）。考点取自题目快照；快照缺失时按题目 id 从当前库关联兜底。

### 上线

- **D14 旧数据不迁移（用户定）**：原 T3.6 删除。旧内容以 .md（v1/v2 均可）经现有导入流程重新进资源库；架构文档中 migrate-v1 相关描述在 T3.6 收尾时清除。阶段完成标志改为「按 `docs/部署.md` 完成一次部署演练」。

---

## 3. 数据模型与契约变更汇总

| 位置 | 变更 | 所在任务 |
| --- | --- | --- |
| 数据库 | **无结构变更**：直接启用 `responses.teacherMark / teacherComment / finalCorrect`、`attempts.scoreFinal`（T2.6 预留列） | T3.2 |
| `packages/contract`（判分/结果） | `attemptResultQuestionSchema` + `teacherMark/teacherComment/finalCorrect`；得分汇总 + `scoreFinal / pendingCount`；`autoCorrect` 注释按 D1 修订 | T3.2、T3.5 |
| `packages/contract`（教师端） | 作答列表/详情查询与数据 schema、`markRequestSchema`、待批队列 schema、CSV 导出查询 schema | T3.1、T3.2、T3.4 |
| `packages/contract`（学生端） | `studentRecordsDataSchema`、`wrongQuestionsDataSchema`（含 query） | T3.5 |
| `packages/grading` | 未作答客观题 → false（先补用例） | T3.2 |

每次契约改动后运行 `pnpm schema:export` 并提交（CI 校验）。

---

## 4. 任务

### T3.1 教师端作答数据页（三视图 + 详情）
- 依赖：Phase 2A、Phase 2B 全部完成
- 产出：
  - 契约：`teacherAttemptListQuery/DataSchema`、`teacherAttemptDetailDataSchema`（D6/D7 字段）。
  - 接口：
    - `GET /api/teacher/attempts?studentId&courseId&assignmentId&unitId&sourceType&status&from&to&limit&offset` → 作答卡片列表（学生、来源〔类型 + 课程/作业名 + attemptNo〕、单元数/题数、状态、得分〔D2 口径〕、待批数、startedAt/submittedAt、activeSec）。
    - `GET /api/teacher/attempts/:id` → 详情（D7 全部字段；draft 亦可用，判定列语义见 D5）。
  - 服务：`teacher-attempt-service`（归属判定 attempt → student → teacherId，404 口径同 T2B；来源名/单元节经 join 组装）。
  - 前端：
    - `/t/data`：侧边栏「数据」入口启用；视图切换（按学生 / 按作业 / 按课程，课程视图含课程练习历次展开）+ 筛选 + 分页；三态齐全。
    - `/t/data/attempts/:id`：来源头（「作业 · 课程名」或「课程：xx · 第 n 次」）、逐题列表（快照题干用 `<RichMarkdown>` 渲染）、手写缩略图懒加载 + lightbox 放大（回放切换 T3.3 接入）。
    - 入口衔接（D8）：作业详情名单状态点击、课程进度矩阵历次点击 → attempt 详情。
- 要点：详情页数据全部来自服务端（快照 + responses），不在前端拼判分；draft 详情不显示参考答案对比高亮（未交卷无判定）。
- 验收：
  - 服务测试：三视图与各筛选组合正确；进行中作答出现在列表且详情含草稿答案与笔迹（D5）；教师乙访问甲的 attempt → 404；分页边界；含软删单元的作业 attempt 照常可查（T2A D16 口径）。
  - E2E：教师打开数据页，按课程视图看到课程练习历次，进详情见手写图。
  - 🧑 数据页能看到 Phase 2 / 2A 产生的全部数据（作业、课程练习、进行中草稿各至少一条样例）。

### T3.2 批注、待批队列与判分口径修订
- 依赖：T3.1
- 产出：
  - **D1 落地（先补用例）**：`packages/grading` 对「可自动判分题型 + answer=null」返回 false；修订 `attempt-service` 交卷链路、contract 注释、T2.5/T2.6 锁定的测试期望（详见 D1 附带影响清单）。
  - 契约：`markRequestSchema`（D3）、`pendingMarkListDataSchema`（卡片：题干快照、参考答案、学生最终答案、手写图信息、activeSec/hintsUsed/changeCount、来源上下文〔课程/作业/单元/attemptNo〕、submittedAt）。
  - 接口：
    - `POST /api/teacher/responses/:id/mark`（D3；draft → 409 `NOT_SUBMITTED`；非本人教师 404）。
    - `GET /api/teacher/pending-marks?courseId&assignmentId&studentId`（D4 口径与排序）。
  - 服务：`mark-response`（事务内更新 mark/comment → 逐题重算 `finalCorrect` → 重算 attempt `scoreFinal` 与 `status`〔D2 状态机〕）。
  - 前端：
    - `/t/data/pending` 待批队列页：单题卡片连续批改；快捷键 J/K 上下题、1 标对、2 标错、0 清除判定、U 撤销上一题；顶部批改进度 x/y；筛选与空态（「没有待批题」）。
    - 详情页每题「改判 / 评语」内联编辑（对自动判过的题亦可改判）。
  - 联动核对（D2）：作业名单状态与「已批改」统计、课程进度矩阵「待批」消除、单元卡片「有待批」、各处得分展示切换为 scoreFinal 优先。
- 验收：
  - 服务测试：构造 8 题卷（6 客观含 1 题未作答 + 1 手写 + 1 无标准答案）——未作答题交卷即 false 且不进队列；批注手写与无答案题后 `scoreFinal = 6÷8 或 7÷8`（按批注结果）且 `status=graded`；清除批注回 `submitted`、scoreFinal 重算；对自动判过题改判生效；draft 批注 409；队列排序与筛选；域 404。
  - 既有测试修订后全绿：结果汇总计数、scoreAuto 数值（未作答进分母）、进度矩阵/作业卡片得分断言。
  - E2E：教师批改一道手写题 → 学生作业状态「已批」。
  - 🧑 连续批改 5 题流畅（含快捷键与撤销上一题）。

### T3.3 笔迹回放
- 依赖：T3.1
- 产出：
  - 接口：`GET /api/teacher/ink/:inkId.json.gz`（矢量数据；域判定；`Content-Type: application/gzip`；文件缺失 404）。
  - 前端：`<InkReplay data>`（`features/ink/replay/`）：engine 分派（D12）——atrament 按点时间戳重演、excalidraw 按元素顺序匀速近似；播放/暂停/进度条拖动/1×2×4× 倍速；教师详情页手写题「快照 / 回放」切换；数据缺失降级 PNG + 提示。
  - 组件单测：构造带时间戳的 atrament 数据断言重演顺序、倍速与进度跳转；excalidraw 顺序重演；异常/空数据不崩溃。
- 验收：
  - 服务测试：教师乙取甲的笔迹矢量 → 404；正常返回 gzip 字节与库内路径一致。
  - 🧑 用一次真实 iPad 作答的笔迹回放，顺序与书写过程一致；倍速与进度条拖动正常。

### T3.4 CSV 导出
- 依赖：T3.1
- 产出：
  - 接口：`GET /api/teacher/export/csv?studentId&courseId&assignmentId&sourceType&from&to`（D13 列清单与口径；`Content-Type: text/csv` + BOM；文件名 `tutor-export-YYYYMMDD-HHmmss.csv`；仅已交卷 attempt）。
  - 前端：数据页与详情页「导出 CSV」按钮（携带当前筛选条件）。
- 验收：
  - 服务测试：行数 = 筛选范围内已交 attempt 的逐题数（draft 不含）；列内容正确（多空/多选/手写序列化、考点分号分隔、判定来源、评语、手写链接）；BOM 存在；含逗号/引号/换行的字段正确转义；域过滤（乙只能导出自己的数据）。
  - 🧑 Excel 直接打开中文无乱码；抽查三行与页面详情一致。

### T3.5 学生「我的记录」与错题本
- 依赖：T3.2
- 产出：
  - 契约：`studentRecordsDataSchema`（D10）、`wrongQuestionsQuery/DataSchema`（D11）；`attemptResult*` 扩展（D9：teacherMark/teacherComment/finalCorrect/scoreFinal/pendingCount）。
  - 接口：
    - `GET /api/student/records`（D10 聚合；移出课程后已交卷保留、失权草稿不列）。
    - `GET /api/student/attempts/:id` 结果视图扩展（D9；草稿视图不变）。
    - `GET /api/student/wrong-questions?knowledge&includeResolved`（D11）。
  - 前端：
    - `/s/records`：作业组 + 课程练习组（按课程分组、单元历次展开）；状态徽章（进行中/已交/已批）、待批徽章；进行中条目「继续作答」入口。
    - `/s/records/wrong` 错题本：考点筛选 chips、「显示已攻克」开关；条目 = 题干（快照渲染）、本人最近答案、正确答案、详解折叠、首次是否做对标记、来源（课程/作业）。
    - 学生端导航「我的记录」指向新页；首页「我的记录」入口同步。
- 要点：三个接口全部 `assertNoLeak`（含「构造 after_due 未公布场景」——仅当 T2A.8 已实现时）；错题本聚合在 SQL 层按 (studentId, questionId) 取 max(submittedAt) 的已交作答。
- 验收：
  - 服务测试：只能看到本人记录（他人 attemptId 403）；批注后结果视图含评语与最终判定；错题本口径（最近一次错才入本、首次做对标注、跨来源取最近、显示已攻克开关、考点筛选）；移出课程后记录可见性（已交可看、失权草稿不列）。
  - E2E：T3.2 批改用例延伸——学生刷新「我的记录」看到评语、得分与「已批」徽章。
  - 🧑 老师批注后，学生在 iPad 上刷新即见评语。

### T3.6 收尾：E2E、文档同步与上线准备
- 依赖：T3.5
- 产出：
  - E2E 全链路：学生作答（含手写）交卷 → 教师数据页查看（三视图）→ 待批队列快捷键批改 → 学生记录见评语/「已批」→ 教师导出 CSV 并断言内容 → 学生错题本出现该题。全程学生端网络层泄露拦截不变。
  - 文档同步：
    - 架构文档：§5.2 补批注/得分/状态机口径（D1–D3）；§5.6 判分小节按 D1 修订；§6 Phase 3 描述与验收更新；**删除 migrate-v1 相关描述**（D14）；§10 追加四项决策（未作答判错、得分分母=全部题、教师可见进行中草稿、旧数据不迁移）。
    - `docs/页面功能清单.md`：增补数据页、待批队列、我的记录、错题本。
    - `docs/部署.md`：增补「上线切换」小节（全新部署、内容 .md 重新导入、旧版可直接下线；无数据迁移步骤）。
    - 侧边栏「数据」入口定稿（「学情」仍为占位，指向 Phase 4）。
  - 进度表打勾；T2A/T2B 若有未尽 🧑 人工项一并核对提醒。
- 验收：`pnpm e2e` 全绿（chromium + webkit）；🧑 通读三份更新文档；按 `docs/部署.md` 完成一次部署演练（本机 Docker 或服务器）——部署 → 导入样例 .md → 教师批改/学生记录全流程冒烟。

---

**Phase 3 完成标志**：教师能完整查看（含进行中）、批改、导出全部作答数据；学生能查看历次记录、老师评语与错题本；按 `docs/部署.md` 完成一次部署演练（旧版数据不迁移，内容以 .md 重新导入，D14）。
