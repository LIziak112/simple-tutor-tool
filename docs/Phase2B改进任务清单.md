# Phase 2 改进任务清单（Phase 2B：多教师与管理员改造）

> 配套文档：`docs/技术架构与实施方案.md`（架构文档）、`docs/开发任务清单.md`（主任务清单，Phase 0–2 与 §0 全局约定）、`docs/Phase2A改进任务清单.md`（Phase 2A，本阶段的前置）、`docs/Phase3任务清单.md` / `docs/Phase4任务清单.md` / `docs/Phase5任务清单.md`（后续阶段条目）、`docs/进度表.md`（总进度表）。
> 本文只写**做什么、按什么规则、怎么验收**。**凡本文涉及的范围，与上述文档冲突时以本文为准。**
> 执行对象：GLM 5.3。每次只下达**一个任务（T2B.x）**。本阶段须在 Phase 2A（T2A.9）全部完成后开始。

---

## 0. 使用方法

### 0.1 每个任务的下达提示词

```
阅读 AGENTS.md、docs/技术架构与实施方案.md、docs/开发任务清单.md、docs/Phase2A改进任务清单.md、docs/Phase2B改进任务清单.md。
本阶段以 docs/Phase2B改进任务清单.md 为准（§2 设计决策已定，不要重新讨论）。
执行任务 <T2B.x>，只做该任务范围内的事。
1. 先阅读与本任务相关的现有代码，列出：要新建/修改的文件、数据库迁移、接口变更、实现步骤、要写的测试。等我回复"确认"。
2. 确认后实施。完成后运行 pnpm lint && pnpm typecheck && pnpm test && pnpm e2e，贴出结果。
3. 逐条对照该任务的「验收」自查，说明每条如何验证。
4. 本文 §2 未覆盖的设计决策，停下来问我，不要自行假设。
```

### 0.2 规则

- 严格按编号顺序执行；「依赖」未完成不得开始。
- 每个任务一个分支 `task/T2B.x`，验收通过后合并到 `v2`。
- **每个任务结束时应用必须完整可用**：旧页面在被新页面替换之前必须继续工作；`pnpm e2e` 必须保持全绿（若任务改变了 E2E 覆盖的流程，在本任务内同步更新用例）。
- **不得破坏现有数据**：所有结构变更走 drizzle 迁移（`pnpm db:generate`，不手改）；数据回填沿用 T2A.1 的模式——不写进迁移文件，放在 migrate.ts 流程内以代码执行，带完成标记防重跑。
- 旧列先保留不再读写（代码注释 `@deprecated T2B`），Phase 3 结束后统一清理，本阶段不删列。
- **隔离红线：本阶段改造后，教师端/管理端每一个按 id 取资源的接口，都必须有「教师乙访问教师甲资源 → 404」的服务测试**（矩阵见各任务验收）；学生端接口行为不得有任何变化。
- 学生端任何新增/修改接口都必须接入 `assertNoLeak` 泄露测试（本阶段原则上不动学生端接口）。
- **第二位教师的出现入口（自助注册与管理员创建，均在 T2B.6）必须晚于全部域隔离完成**——T2B.6 之前的每个任务结束时系统仍处于单教师等价状态。
- 带 🧑 的验收项需要用户本人手动检查。完成后在 §6 进度表打勾。

### 0.3 本阶段明确不做

- 教师间实时协作、共同编辑、资源细粒度授权（只读/可编辑分享）——共享只有「发布 → 文件 → 他人导入」一条通道。
- 一名学生归属多位教师（`students.teacherId` 单值，归属终身不变）。
- 删除教师（只有禁用/启用；教师相关数据永不连带删除）。
- 教师自助修改密码（本阶段重置由管理员完成；如需自助改密码，后续单独小任务补）。
- 管理员查看/编辑教师业务数据（题库、课程、学生、作答——管理员只管账号、注册开关与共享文件）。
- 学生端任何改动（登录方式、页面、接口行为均不变）。
- 组织架构/部门、SSO、密码找回自助、注册邀请码/邮箱验证（注册只做开关控制，不做白名单）。
- T4.5 `teachers.apiToken` 的多教师语义（届时随 T4.5 一并定义，本阶段该列继续闲置）。
- 修改 DSL 语法与 `pnpm gen:spec` 产物。

---

## 1. 目标模型

```
管理员（isAdmin 的教师；首位 = 存量教师自动升级 / 新部署首启创建）
    │  创建/禁用/重置密码/授予撤销 isAdmin；注册开关
教师 ×N（每人独立的域；除管理员创建外，可自助注册——开关默认开）
    ├─ 资源库（文件夹、讲义、单元、题目、导入记录）——域内私有
    ├─ 课程（目录、成员）与作业——域内私有
    ├─ 学生（教师创建，归属终身）——学生端无感知
    │       └─ 作答 / 笔迹 / 事件 —— 经学生归属教师
    └─ 发布（复制快照到共享目录）
            ↓ DATA_DIR/shared/*.md（专门网页浏览，或直接从服务器本地放入）
        其他教师 / 管理员 ← 浏览、删除；其他教师「导入到我的资源库」进入自己的域
```

### 1.1 术语（界面文案与代码命名统一使用）

| 术语 | 含义 | 代码命名建议 |
| --- | --- | --- |
| 管理员 | `teachers.isAdmin = true` 的教师，可兼任全部教师功能 | isAdmin |
| 教师域 / 域内 | 一位教师名下的全部资源，逻辑上互相隔离 | teacher scope |
| 归属教师 | 资源/学生 `teacherId` 指向的教师（根表直接存列，派生表经 join 推导） | owner |
| 域内唯一 | DSL id 只在本教师域内要求唯一（单元/题目） | scoped id |
| 注册 | 教师自助创建账号（登录名 + 密码，isAdmin=false，受开关控制） | register |
| 共享目录 | `DATA_DIR/shared/`，发布产物与本地放入文件的统一落点 | shared |
| 发布 | 教师把单元/讲义导出为 md 写入共享目录（复制快照，非引用） | publish |
| 共享页 | 教师端浏览/导入共享目录的专门页面 | /t/shared |
| 禁用 | 教师 `disabledAt` 置值：会话立即失效、可再启用、数据全保留 | disable |

---

## 2. 设计决策（已定，实施时不得更改）

### 角色与账号

- **D1 教师单表多角色**：不建独立 admins 表。`teachers` 增加 `loginName`（唯一）、`isAdmin`（默认 false）、`disabledAt`（可空）——**不引入 displayName，教师身份显示一律用登录名**（顶栏、管理端列表、共享发布者）。管理员 = `isAdmin` 的教师，登录后教师功能照常可用，另可进管理端。会话 `sessions.subjectType` 保持 `'teacher' | 'student'` 不扩——管理员复用教师会话。
- **D2 登录名规则**：`loginName` 全局唯一，字符集为中文/字母/数字/下划线/连字符（**禁止空白与文件路径非法字符** `\ / : * ? " < > |`），长度 2–32（契约 Zod regex 统一校验，前后端共用）；选择该规则是因为登录名会进入共享文件名与 URL 之外的展示位，且与「学生 loginName 默认为中文姓名」的现状保持一致。存量部署唯一的教师行迁移时取 `loginName = 'teacher'`。
- **D3 教师账号的两个来源与最小管理集**：
  - **来源一：自助注册**。`POST /api/public/teacher/register`，表单与登录一致为「登录名 + 密码」，成功自动登录（`isAdmin = false`）。受**注册开关**控制（默认开，管理员可关）：关闭时注册接口返回 403 `REGISTRATION_DISABLED`，登录页不显示注册入口。**无教师行时注册接口不可用**（409 `TEACHER_NOT_EXISTS`，引导走首启 setup）——第一位教师只能由 setup 创建且必然是管理员。注册接口按 IP 限流：同一 IP 1 小时内最多 5 次，超出 429 `LOCKED`（复用限流表，key `reg:ip:<IP>`）。
  - **来源二：管理员创建**（管理端，快捷且不受开关影响）：登录名 + 初始密码。
  - **管理动作只保留常用集**：改登录名、禁用/启用、重置密码、授予/撤销 `isAdmin`。硬约束：不能禁用自己；不能禁用或撤销**最后一位未禁用的 `isAdmin` 教师**（否则系统失去管理入口），违反返回 409 `LAST_ADMIN`。登录名冲突返回 409 `TEACHER_LOGIN_EXISTS`（教师登录名命名空间与学生的 loginName 互不相干，允许同名）。
- **D4 首启与存量迁移**：全新部署首启 setup 创建的就是第一位教师（`isAdmin = true`），表单从「只有密码」变为「**登录名 + 密码**」；存量部署中唯一的教师行自动升级为管理员——`loginName = 'teacher'`、`isAdmin = true`、**密码不变**，部署者无感。
- **D5 禁用语义**：`disabledAt` 置值即禁用。禁用后：该教师**当前全部会话立即失效**（requireTeacher 校验，与学生归档同口径）；**其学生不受影响**（照常登录、作答、查看记录）；其资源/课程/作业/导入记录全部保留；重新启用完全恢复原状。禁用是可逆的人事动作，不是数据删除。
- **D6 登录、注册与限流**：管理员与普通教师**同一个登录页、同一个接口**（登录名 + 密码），成功返回 `isAdmin` 供前端展示管理入口。登录名不存在 / 密码错误统一 401 `INVALID_CREDENTIALS`（防枚举）；**身份验证通过但被禁用**返回 403 `ACCOUNT_DISABLED`（明示「账号已被停用，请联系管理员」——本人有权知道原因）。登录限流 key 从写死的 `name:teacher` 改为 `name:<loginName>`，与 `ip:<IP>` 双 key（§5.7 口径不变）；注册限流见 D3。首启 setup 仅在无教师行时可用（不变）。学生两种登录完全不变。
- **D7 会话与守卫**：`requireTeacher` 增加未禁用校验（禁用/不存在教师 → 401，同一路径）。新增 `requireAdmin` = requireTeacher 全部校验 + `isAdmin`，未通过返回 403 `ADMIN_ONLY`，挂在整个 `/api/admin/*`。
- **D8 注册开关的存储与公开查询**：新表 `app_settings(key, value)`（两列 KV，本阶段仅一个键 `allowRegistration`，默认 `'true'`；管理员经 `GET/PATCH /api/admin/settings` 读写）。公开接口 `GET /api/public/teacher/status` 响应扩展为 `{ hasTeacher, registrationOpen }`（布尔值无敏感性；`hasTeacher=false` 时 `registrationOpen` 恒为 `false`）——前端据此决定登录页是否显示注册入口。

### 数据归属与隔离

- **D9 归属列**：根表加 `teacherId`：`students`、`courses`、`library_folders`、`lectures`、`units`、`questions`（并入复合主键）、`imports`、`assignments`。派生表**不加列**，经 join 推导：`course_items`/`course_students` → course；`assignment_units`/`assignment_students` → assignment；`attempts`/`responses`/`ink`/`events` → attempt → student。`sessions`、`login_failures`、`knowledge_points`、`data_migrations`、`app_settings` 不加。
- **D10 单元/题目复合主键 (teacherId, id)**：`units` 与 `questions` 的 id 来自 DSL，当前全局唯一；多教师后「两位教师各持同 id 单元」必须合法，故主键改为 `(teacherId, id)`（表重建迁移，项目在 T2A.6 已有先例）。**所有引用列的值不变**（`course_items.refId`、`assignment_units.unitId`、`attempts.unitId`、`questions.unitId`、`ink.questionId`、`events.questionId`、`question_knowledge.questionId`），但**去掉外键约束**（SQLite 外键必须引用完整唯一键组；域一致性改由服务层保证——查询一律带教师上下文）。不采用「内部 uuid + dslId 双轨」方案：双轨会让 id 语义分裂，导出/往返/展示处处特判，一次表重建换长期一致更划算。
- **D11 考点全局共享**：`knowledge_points`（name 全局唯一）**保持全局共享，不加 teacherId**——考点是通用学科概念（如「一元二次方程」），不同教师导入同一份材料自动合并到同一条，不泄露任何内容。`question_knowledge` 主键改为 `(teacherId, questionId, knowledgePointId)`。
- **D12 隔离口径**：教师访问非本人资源一律 **404 `NOT_FOUND`**（不暴露存在性，与 T2A D22 同口径），不引入新错误码；按 `studentId` / `attemptId` / `inkId` / `assignmentId` 等取数的教师侧接口，一律按 `student.teacherId`（或对应根表）判定归属后才继续。
- **D13 匹配与工具的域化**：导入匹配从全局改为域内——单元按 `(teacherId, dslId)`、讲义按 `(teacherId, folderId, title)`、题目按 `(teacherId, id)`（T2A D18 各规则不变，只是作用域缩小到本教师）。`pnpm reparse`、`export.md`、可见性函数 `canStudentSeeItem`、「复制错误给 AI」、`question-sync`、spec 相关路由全部带教师域。

### 学生归属

- **D14 学生归属创建教师**：`students.teacherId` = 创建者，**一生只归一位教师**（转校/换老师场景本阶段不做）。`loginName` / `linkToken` 维持**全局唯一**——不同教师各自创建「张三」时登录名必须不同：创建/改登录名时全局查重，冲突时自动建议「张三2」。学生端接口与两种登录流程**零变化**（学生按 studentId 工作，天然隔离；学生端不知道也不需要知道教师是谁）。

### 共享发布

- **D15 共享目录**：`DATA_DIR/shared/`。教师端「共享」页列出目录内全部 `.md`；教师也可以**直接把文件放进服务器该目录**（本地共享：U 盘、网盘同步、scp 皆可），与在线发布的文件同源并列。目录内文件是**独立快照**，与任何资源库无关联——发布后源资源继续修改不影响已发布文件。目录规模防线：只列出前 200 个文件，超出在页面提示「目录文件过多，仅显示前 200 个」；单文件 > 1 MB 的不列出并提示。
- **D16 发布 = 复制快照**：单元/讲义详情提供「发布到共享」，按 T2A.2 的 `export.md` 格式写入 `DATA_DIR/shared/`，文件名 `<标题>-<发布者登录名>-<yyyymmdd-HHmmss>.md`（登录名字符集已由 D2 保证文件名安全；重名加序号 `-2`）。同目录写伴生元数据 `<同名>.meta.json`：`{ teacherId, loginName, publishedAt }`——共享列表的「发布者/时间」与发布者的删除权限都以此为准；手动放入的文件没有 meta，发布者显示「本地文件」，仅管理员可删。讲义发布文件为 markdown 原文（不注入 frontmatter，保证重新导入匹配行为不变）。
- **D17 导入共享**：共享页「导入到我的资源库」→ 服务端读 `shared/` 内该文件 → 复用现有单文件预览/提交（preview 展示动作清单，提交进**导入者自己的域**，目标文件夹可选）。同 id 单元按 D13 在导入者域内匹配（教师乙导入教师甲发布的 `unit1`，在乙的域内是全新增）。导入后与发布者**无任何后续关联**。`filename` 参数必须与目录扫描白名单比对（防路径穿越）。
- **D18 共享文件删除**：发布者可删自己发布的（meta.teacherId 匹配）；管理员可删任意（含本地放入的）。删除 `.md` 时连带删伴生 `.meta.json`。删除后不可再导入，**已导入进资源库的不受影响**。

### 管理端

- **D19 管理端边界**：前端 `/a`（独立布局，不套教师端导航）+ 后端 `/api/admin/*`（requireAdmin）。功能三组：教师账号管理（D3 常用集 + 授予/撤销 isAdmin）、注册开关（D8）、共享文件管理（列表/删除，D18）。管理员**没有**任何业务数据权限：看不到教师的题库、课程、学生、作答。管理端入口只对 `me.isAdmin` 显示。
- **D20 管理端概览**：`GET /api/admin/overview` 只返回聚合计数（教师数/未禁用教师数/学生总数/作答总数/共享文件数/注册开关状态），不返回任何明细——管理员感知系统规模即可。

---

## 3. 数据模型变更汇总

| 表 / 目录 | 变更 | 所在任务 |
| --- | --- | --- |
| `teachers` | + loginName（唯一索引，字符集见 D2）、isAdmin（默认 false）、disabledAt（可空） | T2B.1 |
| `app_settings` | 新建：key（PK）, value；初始键 `allowRegistration='true'` | T2B.6 |
| `students` | + teacherId（NOT NULL，索引） | T2B.1 |
| `courses` / `library_folders` / `lectures` / `imports` / `assignments` | + teacherId（NOT NULL，索引） | T2B.1 |
| `units` | + teacherId；**主键改 (teacherId, id)**（表重建） | T2B.1 |
| `questions` | + teacherId；**主键改 (teacherId, id)**（表重建）；unitId 去 FK | T2B.1 |
| `question_knowledge` | **主键改 (teacherId, questionId, knowledgePointId)** | T2B.1 |
| `course_items.refId` / `assignment_units.unitId` / `attempts.unitId` / `ink.questionId` / `events.questionId` | 去 FK（**值不变**） | T2B.1 |
| `knowledge_points` / `sessions` / `login_failures` / `data_migrations` | 不变 | — |
| 存量数据 | 唯一教师升级（D4：loginName='teacher'、isAdmin=true）+ 全部业务行 teacherId 回填 | T2B.1（migrate.ts 流程内） |
| `DATA_DIR/shared/` | 新目录（非数据库）；`.md` + 伴生 `.meta.json` | T2B.7 |

---

## 4. 管理端与通用使用约定（所有页面任务都要遵守）

1. **影响先说清**：禁用教师的确认弹层写明具体影响（「该老师的登录将立即失效；其名下 N 名学生不受影响，历史数据全部保留；可随时重新启用」）；撤销 isAdmin 同理说明；重置密码确认框提示「新密码需线下告知对方」。
2. **不丢数据**：禁用不是删除；共享文件删除前确认框注明「已导入的资源不受影响」。成功操作 toast 提示。
3. **状态一目了然**：教师列表显示「正常 / 已禁用」标签与「管理员」徽章；自己所在行标注「我」且禁用、撤销 isAdmin 按钮置灰；共享列表显示「在线发布 / 本地文件」来源标签；设置区开关显示当前注册状态。
4. **初始密码一次性展示**：管理员创建教师与重置密码成功后弹层展示一次（默认生成 12 位随机密码，可自定义），关闭后不可再查，附「已复制」按钮（自助注册的教师自己设密码，无此环节）。
5. **找得到**：教师管理、共享列表有搜索（登录名/文件名，前端即时过滤）。
6. **三态齐全**：加载 / 空态（带引导，如「还没有其他老师 → 创建教师 或 打开注册开关」）/ 错误（中文说明 + 重试）。
7. **时间**：界面一律北京时间；共享列表显示「x 天前」相对时间。
8. **触控**：管理端也可能在 iPad 上使用，交互元素 ≥ 44px。
9. 沿用 Phase 2A §4 的教师端通用约定（本阶段教师端新增页面同样遵守）。

---

## 5. 任务

### T2B.1 数据模型与迁移（多教师基础结构）
- 依赖：Phase 2A 全部完成（T2A.9）
- 产出：
  - §3 中标注 T2B.1 的全部结构变更（drizzle 迁移，含 units/questions/question_knowledge 表重建）。
  - 存量回填（migrate.ts 流程内，幂等）：唯一教师行升级 `loginName='teacher'`、`isAdmin=true`（密码、id、createdAt 不动）；全部业务根行 teacherId 回填该 id。
  - **行为不变的兼容改造**（本任务结束时应用表现与迁移前完全一致，仍只有一位教师）：
    - `content-service` / `import-actions` / `question-sync` 中所有按全局 id 匹配/upsert 单元与题目的查询，改为携带 `teacherId`（值取自库中唯一教师行——单教师下与原行为等价）；`onConflictDoUpdate` target 同步改为复合键。
    - `reparse-service` 遍历同样按教师分组执行（当前只有一组）。
  - 本任务**不改**登录接口与前端（`loginTeacher` 仍按第一行取教师，照常工作）；不改契约。
- 要点：迁移测试用「T2B 前结构」fixture 库（复用 T2A 迁移测试的造库模式，含 2 课程、3 讲义、4 单元、2 学生、1 多单元作业、2 已交卷 attempt），断言迁移后：教师行升级正确、全部业务行 teacherId 正确、单元/题目数据与关联（course_items、assignment_units、attempt 快照、question_knowledge）一字不差、重复执行无重复数据。**表重建迁移必须先写测试再生成**（硬性规则 9 同精神）。
- 验收：
  - 迁移测试全过（含幂等重跑）；现有全部测试与 E2E 绿（登录、导入、课程、作业、作答流程行为不变）。
  - 单测：域内匹配——同 teacherId 下同 dslId 更新 version+1；（构造两个 teacherId 的 fixture）同 dslId 不同 teacherId 互不干扰、各自行数不变。
  - 🧑 用现有 `data/` 副本启动一次：教师按原密码照常登录，全部页面与迁移前一致。

### T2B.2 认证改造（登录名登录 + 管理员角色 + 禁用 + 守卫）
- 依赖：T2B.1
- 产出：
  - 契约（`packages/contract/src/auth.ts`，先改后实现，完成跑 `pnpm schema:export` 提交）：
    - `teacherLoginNameSchema`（D2 字符集与长度，regex + 中文说明）；
    - `teacherLoginRequestSchema` + `loginName`；`teacherSetupRequestSchema` + `loginName`（表单 = **登录名 + 密码**，无姓名字段）；`teacherInfoSchema` + `loginName` / `isAdmin`；
    - `teacherStatusDataSchema` 扩展 `registrationOpen`（本任务先恒返回 `false`——注册未上线，T2B.6 接真值；避免契约二次变更）；
    - 错误码新增 `ACCOUNT_DISABLED`（登录时身份已验证但被禁用）、`ADMIN_ONLY`（非管理员访问管理接口）；预留 `TEACHER_LOGIN_EXISTS`、`LAST_ADMIN`、`REGISTRATION_DISABLED`、`TEACHER_NOT_EXISTS`（本任务定义，T2B.6 使用）。
  - `teacher-auth-service`：`loginTeacher(db, {loginName, password}, ip)`——按 loginName 查行；禁用教师在验密**通过**后返回 403 `ACCOUNT_DISABLED`（验密失败仍走 401 统一口径，防枚举）；限流 key 用真实 loginName。`setupTeacher` 创建 `isAdmin=true` 的首位教师（请求体含 loginName，写库前校验唯一）。`getTeacherInfo` 改为返回完整账号信息并在 `disabledAt` 非空时视为无效（守卫据此立即吊销存量会话）。
  - `require-teacher`：走新校验链（存在 + 未禁用）；`c.var.teacher` 携带 `id / loginName / isAdmin`。新增 `requireAdmin`（D7）。
  - 前端：`/t/login` 加登录名输入（记入 localStorage 供下次预填，明文即可，非机密）；`/t/setup` 改两字段表单（登录名默认建议 `teacher`，可改）；`me` 响应带 `isAdmin`（管理入口 T2B.6 再显示）；`TeacherLayout` 顶栏显示登录名。
- 要点：存量教师迁移后凭 `teacher` + 原密码直接登录（T2B.1 已保证，此处加服务测试固化）；禁用校验要覆盖「禁用后**已持有的会话**下一次请求即 401」；本任务**不实现注册接口**（T2B.6），故 `status.registrationOpen` 暂为 false、登录页不显示注册入口。
- 验收：
  - 服务测试：正确登录名+密码成功并返回 isAdmin；错误登录名与错误密码均 401 `INVALID_CREDENTIALS`（错误码一致，防枚举）；正确凭证+已禁用 → 403 `ACCOUNT_DISABLED`；禁用教师既有会话下一请求 401；限流按 loginName 计数（甲失败 5 次不影响乙）；setup 已有教师时 409 `TEACHER_EXISTS`；status 返回 `{hasTeacher:true, registrationOpen:false}`。
  - 契约单测：登录名字符集（合法中文/英文、拒绝空格与 `/\:*?"<>|`、长度边界）。
  - 页面测试：登录表单校验与错误提示（账号停用文案）；setup 两字段流程。
  - E2E：现有登录用例改为「teacher + 密码」。
  - 🧑 迁移库上用 `teacher`/原密码登录成功，顶栏显示 `teacher`。

### T2B.3 资源库与导入域隔离
- 依赖：T2B.2
- 产出：
  - `library-service` / `content-service`（讲义、单元、题目、文件夹）/ `import-actions`（preview、preview-batch、commit、batches 回看）全部接口按**会话教师**过滤与写入（`c.var.teacher.id`）；T2B.1 的「取唯一教师行」占位全部替换为会话教师。
  - 导入匹配、文件夹归属、`export.md`、使用情况（usage）、回收站、批量操作（batch）全部域内；D18/D19（T2A）各规则作用域缩小，语义不变。
  - `reparse-service` 按教师分组；`pnpm tutor-lint` 不变（纯文档工具，无库访问）。
  - 前端无结构性改动（接口自动按会话教师取数）。
- 要点：隔离红线——**每个教师端资源接口都要有乙访问甲的 404 用例**（列表接口断言互不可见；详情/编辑/软删/恢复/导出均按 id 断言 404）。
- 验收：
  - 服务测试矩阵：教师乙对甲的文件夹/讲义/单元/题目的列表、详情、编辑、软删、恢复、彻底删除、导出、usage 查询 → 404 或列表为空（列表类断言不含对方任何信息，含数量）；乙导入与甲同 dslId 的相同文件 → 乙域内新增独立单元，甲的单元不受影响（题数、version 不变）。
  - 迁移测试联动：T2B.1 fixture 上甲登录后一切照旧。
  - 🧑 甲（存量管理员）操作资源库全部功能无异常。

### T2B.4 课程与作业域隔离
- 依赖：T2B.3
- 产出：
  - `course-service`：课程 CRUD/归档、目录条目（添加/排序/可见性/定时发布）、成员增删、`student-view` 预览、进度矩阵接口——全部按会话教师；「从资源库添加」可选项天然只列本人资源（T2B.3 已域化），服务端再校验 `refId` 属于本教师（防直接构造请求塞他人 refId）。
  - `assignment-service`：作业 CRUD、多单元内容、名单快照与增删、check 已做过提示、内容锁定——全部按会话教师；`unitIds` / `courseId` / `studentIds` 逐项校验归属。
  - `visibility` / `canStudentSeeItem` 的调用链带上教师域（学生侧行为不变，见 T2B.5 说明）。
- 验收：
  - 服务测试矩阵：乙对甲的课程/条目/成员/作业的读、改、删、排序、名单操作 → 404；乙以自己的作业 PATCH 引用甲的 unitId / studentId → 404；乙 POST 作业带甲的 courseId → 404；甲乙同名课程互不可见。
  - 课程练习与作业在域内全流程回归（复用 T2A.6/T2A.7 用例，跑通即可）。
  - 🧑 甲的课程与作业管理页全部功能无异常。

### T2B.5 学生与作答域隔离
- 依赖：T2B.4
- 产出：
  - `student-service`：创建学生写入 `teacherId`（会话教师）；loginName 全局查重时冲突自动建议后缀名（D14）；学生列表/编辑/重置密码/重置链接/归档全部按归属教师。学生归档对教师可见性规则不变。
  - `attempt-service` / `ink-service` / `event-service` / `active-time` / `student-course-service`：教师侧入口（进度矩阵、批改取卷、笔迹 PNG 与元数据）按 `attempt → student → teacherId` 判定归属；学生侧接口（`/api/student/*`）**行为零变化**——学生按 attemptId/studentId 工作，天然落在自己教师的域内，本任务只加回归测试证明这一点。
  - `GET /api/teacher/content`（兼容接口，T2A.1 组装）域化。
- 要点：这是隔离面最大的任务，逐个教师侧路由对照检查（含 `/api/teacher/ink/:file`）；「已删除单元仍可作答」（T2A D16）等既有语义在域内保持。
- 验收：
  - 服务测试矩阵：乙对甲的学生（列表/详情/重置密码/归档）、作业名单、作答、笔迹 PNG、事件查询 → 404 或列表为空；乙创建学生 loginName 与甲的学生重名 → 自动建议「张三2」且不落库重名；**学生端回归**：两名不同教师的学生各自登录、取卷、作答、交卷、看结果、笔迹互不串扰（学生接口行为与 Phase 2A 完全一致，全部泄露测试保持绿）。
  - 迁移库：存量学生归属甲，甲的学生端使用无任何变化。
  - 🧑 甲的学生在 iPad 上完整作答一次（含手写），记录与笔迹正常。

### T2B.6 教师自助注册 + 管理端
- 依赖：T2B.5（**隔离完成后才允许出现第二位教师**——注册与管理员创建两个入口都在本任务上线）
- 产出：
  - 注册接口（公开）：`POST /api/public/teacher/register` {loginName, password}（D3：受开关控制 → 403 `REGISTRATION_DISABLED`；无教师行 → 409 `TEACHER_NOT_EXISTS`；登录名冲突 → 409 `TEACHER_LOGIN_EXISTS`；IP 限流 `reg:ip:<IP>` 1 小时 5 次 → 429 `LOCKED`；密码沿用 `teacherPasswordSchema`；成功创建 `isAdmin=false` 教师**并自动登录**签发会话）。`GET /api/public/teacher/status` 的 `registrationOpen` 接真值（app_settings）。
  - `app_settings` 表（§3）+ 迁移初始键 `allowRegistration='true'`（DDL + migrate.ts 流程内插入，幂等）。
  - 管理接口（requireAdmin）：
    - `GET /api/admin/teachers`（列表：loginName、isAdmin、disabledAt、createdAt、学生数；可按状态筛选）
    - `POST /api/admin/teachers` {loginName, password}（管理员创建，不受开关影响；409 `TEACHER_LOGIN_EXISTS`）
    - `PATCH /api/admin/teachers/:id` {loginName?, isAdmin?}（授予/撤销管理员与改登录名；「撤销最后一位活跃管理员」→ 409 `LAST_ADMIN`）
    - `POST /api/admin/teachers/:id/disable` / `enable`（D3 硬约束 → 409 `LAST_ADMIN`；不能对自己 disable）
    - `POST /api/admin/teachers/:id/reset-password` {password}
    - `GET /api/admin/settings`（注册开关）+ `PATCH /api/admin/settings` {allowRegistration}
    - `GET /api/admin/overview`（D20 计数）
  - 前端：
    - `/t/register` 注册页（两字段 + 注册成功自动进入 `/t`；开关关闭时显示「注册已关闭，请联系管理员」）；`/t/login` 底部按 `status.registrationOpen` 显示「没有账号？注册」链接。
    - `/a` 管理端：独立布局 + 路由守卫（`me.isAdmin` 否则跳 `/t`）；页面：概览卡片（含注册开关行，就地切换）、教师管理（列表 + 创建/改登录名/禁用/启用/重置密码/授予撤销 isAdmin，初始密码一次性展示，§4 约定）。
    - 教师端侧边栏/顶栏对 `isAdmin` 增加「管理」入口。
- 要点：被禁用教师正在使用的会话在禁用动作返回成功的那一刻起即失效（T2B.2 已保证，此处加集成测试：禁用 → 用该教师旧 Cookie 请求任意教师接口 → 401）。注册创建的教师名下无任何资源，登录后各页均为空态（复用现有空态组件）。
- 验收：
  - 服务测试：注册成功自动登录且 isAdmin=false；开关关 → 403；无教师行 → 409；重名 → 409；IP 限流第 6 次 → 429；管理员创建/改登录名/授予撤销 isAdmin/重置/禁用/启用全流程；`LAST_ADMIN` 三分支（禁自己、禁最后一位活跃管理员、撤销最后一位活跃管理员的 isAdmin）；非管理员访问 `/api/admin/*` → 403 `ADMIN_ONLY`；禁用后该教师会话立即 401、其学生登录与作答不受影响；status 开关联动（开/关两态）。
  - 页面测试：注册页两字段与开关关闭文案；管理列表状态标签、「我」行按钮置灰、创建弹层、初始密码一次性展示、开关切换。
  - E2E 新增：教师乙自助注册 → 乙登录 → 乙看到空资源库/空课程/空学生（与甲完全隔离）；管理员关闭注册 → 注册页提示关闭。
  - 🧑 注册一个真实同事账号，对方登录确认各自数据完全隔离；然后在管理端禁用、启用各试一次；再试一次「关闭注册后注册页的表现」。

### T2B.7 共享发布与导入
- 依赖：T2B.6
- 产出：
  - 教师接口：
    - `POST /api/teacher/library/units/:id/publish`、`POST /api/teacher/library/lectures/:id/publish`（D16：写 `DATA_DIR/shared/` + 伴生 meta.json；同名文件冲突自动加序号）
    - `GET /api/teacher/shared`（D15：扫目录列表——文件名、类型、标题、题数（解析 frontmatter/标题级轻量信息）、发布者（meta.loginName，无 meta 显示「本地文件」）、时间、来源；200 文件与 1 MB 上限防线）
    - `POST /api/teacher/shared/preview` {filename}（读文件走现有单文件预览，动作清单按 D13 在**本人域**计算）、`POST /api/teacher/shared/import` {filename, folderId?}（提交进本人域；filename 白名单校验防路径穿越）
    - `DELETE /api/teacher/shared/:filename`（D18：发布者删自己的；其他人 → 403 `FORBIDDEN_SHARED_FILE`，管理员经管理端删）
  - 管理接口：`GET /api/admin/shared-files`、`DELETE /api/admin/shared-files/:filename`（可删任意，含本地文件）。
  - 前端：`/t/shared` 共享页（文件卡片 + 来源标签 + 搜索 + 「导入到我的资源库」预览抽屉复用单文件预览组件 + 删除按钮按权限显示）；资源库单元/讲义详情加「发布到共享」（确认弹层说明「发布的是当前内容的快照副本」）；侧边栏「共享」入口；管理端加「共享文件」页签。
- 要点：发布复用 T2A.2 `export.md` 逻辑（未软删题目、可往返）；共享目录读写集中在单一 service（路径拼接一律 resolve + 白名单比对）；本地直接放入的文件无 meta 也能预览与导入。
- 验收：
  - 服务测试：甲发布单元 → 列表出现（发布者=甲）→ 乙预览动作清单为「新增」→ 乙导入 → 乙域内出现同 dslId 独立单元，甲域不受影响；甲再修改源单元 → 共享文件内容不变；乙删除甲的文件 → 403，甲删除成功，乙随后导入 → 404；`../` 等路径穿越 → 400；本地放入文件（无 meta）出现在列表且仅管理员可删；超过 1 MB 的文件不列出。
  - E2E 新增：甲发布 → 乙导入 → 乙建课使用该单元（承接 T2B.6 的隔离用例延伸）。
  - 🧑 甲发布一个单元；手动把另一个 .md 放进 `DATA_DIR/shared/`；用乙账号在共享页看到两者并分别导入成功。

### T2B.8 收尾：E2E、文档同步
- 依赖：T2B.7
- 产出：
  - E2E 全链路：教师乙自助注册 → 甲导入并发布单元 → 乙从共享导入 → 乙建课加成员（乙自己的学生）→ 乙按课程布置作业 → 学生作答交卷 → 甲访问乙的课程/学生/作业均不可见（网络层断言 404）。
  - 文档同步：
    - 架构文档 §5.2（数据模型：teacherId 归属列、复合主键、app_settings、共享目录）与 §5.7（身份与安全：多教师、管理员角色、注册与开关、ACCOUNT_DISABLED/ADMIN_ONLY、限流口径）。
    - `docs/页面功能清单.md` 增补管理端、注册页与共享页；`docs/部署.md` 增补：升级后存量教师自动成为管理员（`teacher` + 原密码登录）、注册开关（默认开，公网部署建议关闭）、`DATA_DIR/shared/` 用途与本地放入说明、多教师备份提示。
    - 后续阶段清单条目修订（`docs/Phase3任务清单.md` / `docs/Phase4任务清单.md`）：T3.x 批改/数据/学情按教师域工作（进度矩阵与作答查询已域化，T3.x 实现时直接沿用）；T4.5 `apiToken` 届时定义多教师语义（每位教师独立 token）。
    - **（2026-09-29 注）** Phase 3 清单已于 2026-09-29 重写，域化红线已并入其 §0.2 规则与各任务验收（教师乙访问教师甲资源 → 404）；届时只需修订 Phase 4 清单。
  - 进度表全部勾选；T2A.9 若有未尽人工项一并核对。
- 验收：`pnpm e2e` 全绿（chromium + webkit）；🧑 通读三份更新文档；按 §7 对照表逐条确认四项决策落地。

---

## 6. 进度表

| 任务 | 状态 |
| --- | --- |
| T2B.1 数据模型与迁移 | ☐ |
| T2B.2 认证改造 | ☐ |
| T2B.3 资源库与导入域隔离 | ☐ |
| T2B.4 课程与作业域隔离 | ☐ |
| T2B.5 学生与作答域隔离 | ☐ |
| T2B.6 教师自助注册 + 管理端 | ☐ |
| T2B.7 共享发布与导入 | ☐ |
| T2B.8 收尾：E2E、文档同步 | ☐ |

依赖关系：T2B.1 → T2B.2 → T2B.3 → T2B.4 → T2B.5 → T2B.6 → T2B.7 → T2B.8（严格串行：**第二位教师的全部出现入口（自助注册与管理员创建，均在 T2B.6）必须晚于域隔离完成**，此前各任务结束时系统仍处于单教师等价状态，任何时刻都完整可用）。

---

## 7. 决策对照（用户已定的四项 → 落地）

| 决策 | 落地方式 | 任务 |
| --- | --- | --- |
| 内容资源不直接共享；可发布后经专门网页或服务器本地共享 | D10/D12/D13 域隔离 + D15–D18 共享目录（发布快照 → `/t/shared` 浏览或本地放入 → 导入进自己域） | T2B.1、T2B.3–T2B.5、T2B.7 |
| 教师账号由管理员角色管理 + 允许教师自助注册 | D1（单表 isAdmin，存量教师自动升级）+ D3（注册开关默认开 + 管理员创建并存）+ D19 管理端常用集 | T2B.1、T2B.2、T2B.6 |
| 学生由教师创建（主要建访问链接），归属邀请的教师 | D14 `students.teacherId` 终身归属；学生端零变化；loginName 全局唯一 + 冲突建议 | T2B.1、T2B.5 |
| 首启/注册表单为「登录名 + 密码」（无姓名字段） | D1/D2（无 displayName，身份显示一律登录名；登录名字符集保证可进文件名） | T2B.1、T2B.2、T2B.6 |
