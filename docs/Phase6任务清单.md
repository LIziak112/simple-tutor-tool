# Phase 6 任务清单(题目草稿 + AI 评析导出)

> 从《`docs/开发任务清单.md`》体系分离;全局约定(API 前缀、响应格式、主键、时间等)见该文档 §0.3,任务分支与 🧑 规则见其 §0.2,**均继续适用**。
> 配套设计文档:**[`docs/题目草稿功能方案.md`](题目草稿功能方案.md)(下称"方案",设计决策 D6.1–D6.10 与红线坑位清单 §10 在彼处,已定稿不再讨论)**;手写引擎约定见架构文档 §5.4;AI 数据包既有设施见 `docs/Phase4任务清单.md` §2(D14–D19)。
> 执行对象:GLM 5.3。每次只下达**一个任务(T6.x)**。任务完成后在 [`docs/进度表.md`](进度表.md) 打勾。

## 0. 使用方法

### 0.1 每个任务的下达提示词

```
阅读 AGENTS.md、docs/技术架构与实施方案.md、docs/开发任务清单.md(§0 全局约定)、docs/题目草稿功能方案.md、docs/Phase6任务清单.md。
方案 §3 设计决策与 §10 红线已定,不要重新讨论。执行任务 <T6.x>,只做该任务范围内的事。
1. 先阅读与本任务相关的现有代码,列出:要新建/修改的文件、契约变更、实现步骤、要写的测试。等我回复"确认"。
2. 确认后实施。完成后运行 pnpm lint && pnpm typecheck && pnpm test(涉及 E2E 时加 pnpm e2e),贴出结果。
3. 逐条对照该任务的「验收」自查,说明每条如何验证。
4. 方案未覆盖的设计决策,停下来问我,不要自行假设。
```

### 0.2 规则(沿用 Phase 4 口径)

- 严格按编号顺序执行;「依赖」未完成不得开始。每个任务一个分支 `task/T6.x`,验收通过后合并到 `v2`。
- **每个任务结束时应用必须完整可用**:`pnpm e2e` 保持全绿(改变了 E2E 覆盖流程时在本任务内同步更新用例)。
- **契约优先**:先改 `packages/contract` 再实现;改后 `pnpm schema:export` 并提交(CI 校验 diff 为空)。
- **学生端任何新增/修改接口都必须接入 `assertNoLeak` 泄露测试**;教师端按 id 取数的新接口必须有「乙取甲 → 404」域隔离测试。
- 数据库结构变更走 drizzle-kit 迁移(`pnpm db:generate`),禁止手改迁移文件;题目只允许软删。
- **不新增技术栈清单以外的依赖**;本阶段唯一预定新依赖 `html-to-image`(T6.9),PR 描述必须写明理由与替代方案(方案 D6.10 已备对比)。
- 带 🧑 的验收项需要用户本人手动检查(iPad 真机项一律 🧑,ink-ipad 技能:模拟器通过不算数)。

### 0.3 本阶段明确不做

- 覆盖式标注、草稿回放、草稿判分、整卷长草稿纸(方案 §1 已否);
- 服务端偏好系统(布局偏好只进 localStorage,D6.4);
- 学生端 AI 直连/BYO-Key(Phase 5 范畴);
- 客户端 zip 库(单题走剪贴板/下载,整套走服务端 archiver,红线 §10-9)。

---

## 1. 链路总览

```
答题页题卡 ──✏️开启──> NoteLayer(布局注册表:自动/右侧/下方)
    │                     └ InkPad(atrament,高度=max(自动加高,父容器高),背景三选一)
    │                     └ use-note-sync ──2s 防抖──> PUT note(gzip+png ≤2MB) + IDB tutor-notes
回看:结果页/错题重练 ──> note.png 懒加载直出
AI 评析:单题=客户端组合(复制文本+笔迹图);整套=LearningPack 新模块「草稿 PNG」+ 新 prompt 模板
```

数据落点:契约 `packages/contract/src/note.ts`;表 `question_notes`(UNIQUE(studentId,questionId),另冗余 teacherId 列);文件 `DATA_DIR/blobs/notes/<studentId>/<questionId 安全名>.{json.gz,png}`。

---

## 2. 任务

### T6.1 契约与存储地基
- 依赖:无(Phase 4 已合并)
- 产出:`packages/contract/src/note.ts`(noteDocSchema/noteUploadDataSchema/noteFetchDataSchema/错误码含 NOTE_NOT_FOUND,方案 §5.1)+ 契约单测;`question_notes` 表(含冗余 `teacherId` 列,写时取 student.teacherId 快照,便于导出/教师接口 join;UNIQUE(studentId,questionId) 不变)+ drizzle 迁移 + `note-service.ts`(**题目按 `(teacherId, questionId)` 域内查询——questionId 跨教师同 id 合法共存,绝不按全局 id 查**;upsert 幂等保 id 稳定、`.tmp`→rename 原子替换、路径安全名 safeInkFileName 同款、PNG IHDR 宽高解析、strokeCount;2MB/413/解压炸弹防护**照抄 ink-service 同款实现**);`pnpm schema:export`。
- 验收:契约单测覆盖字段边界(padHeightLogical 0/3000、bgStyle 三值);迁移在空库与存量库均可启动;note-service 单测(往返/幂等同 id/超限拒绝/**域外同 id 题目不可命中**)。

### T6.2 学生端草稿接口
- 依赖:T6.1
- 产出:`GET/PUT /api/student/questions/:questionId/note` + `GET .../note.png`(本人 PNG 直出;`/api/student/questions` 是学生端新命名空间——笔记跨 attempt 不挂 /attempts 下,鉴权同既有 session);PUT multipart 字段名 `strokes`+`snapshot`(与 ink 一致,`strokes` gzip 载荷 = 整个 noteDoc JSON);不校验 attempt 状态(D6.2);**题目按 `(student.teacherId, questionId)` 域内查询,软删/域外 → 404**;泄露测试。
- 验收:服务端集成测试逐项对齐 `student-ink.test.ts` 模式——往返一致、png 直出 Content-Type、413(超限)、404(无笔记 NOTE_NOT_FOUND/题目软删/**域外同 id 题目**)、400(非 gzip 魔数/非法文档)、401、路径穿越拒绝、**已交卷 attempt 后仍可写**、**assertNoLeak** 全过。

### T6.3 InkPad 高度/背景扩展与布局注册表
- 依赖:无(可与 T6.1/T6.2 并行)
- 产出:InkPad/适配器高度语义扩展(容器高 = max(自动加高状态, 父容器高),不改既有两形态默认行为;`bgStyle` CSS 背景三态,画布透明);`features/notes/note-layout.ts`(NOTE_LAYOUTS 注册表 + resolve 纯函数 + NOTE_LAYOUT_MIN_WIDTH=1024 单点常量,方案 §6.1);`use-note-layout-pref.ts`(localStorage `tutor:note-layout`,try/catch 与损坏值回退 auto)。
- 验收:高度语义单测(自动加高不受影响、父容器更高时跟随、达 3000 逻辑单位封顶);resolve() 三偏好 × 宽/窄屏组合单测;偏好读写与回退单测;InkPad 既有测试零修改通过(默认行为不变的证明)。

### T6.4 草稿区接入答题页
- 依赖:T6.1–T6.3
- 产出:`features/notes/` 下 NoteLayer(开启/收起/墨点标记/有笔迹自动展开/非手写题判定用 contract `HANDWRITTEN_QUESTION_TYPES`)、NoteLayoutSide(grid 55/45,右列等高拉伸)/NoteLayoutBelow、NoteToolbar(笔色×粗细/荧光笔/橡皮/撤销/重做/清空二次确认/布局切换/背景切换/拖把手,全部 44px 触控目标);`use-note-sync.ts`(照抄 use-ink-upload 的 controller:2s 防抖 PUT + dirty 标志去重 + PNG 每次上传现导,fetch+FormData 同 putAttemptInkApi;事件层照抄 use-draft-sync:visibilitychange hidden→PUT、pagehide 只落 IDB;**独立 IDB 仓 `tutor-notes`、key `note:<studentId>:<questionId>`,绝不碰 tutor-drafts**;加载合并按 updatedAt(UTC 毫秒)新者胜);挂载 AttemptQuestionCard。
- 验收:组件测试——开合与墨点、自动展开、手写题不显示、布局切换即时生效并持久化、清空二次确认、工具条命令转发;use-note-sync 测试(防抖窗口/flush 时机/dirty 去重不重传/**两账号同设备不串写**/交卷 clearDraft 后草稿本地仍在——红线 §10-1 的回归);E2E:开草稿→handwriteOneStroke 写→2s 内 PUT 发生→刷新自动展开且笔迹恢复;**草稿开启时单选/多选/判断选项仍可正常选择且不产生笔迹**;🧑 iPad 真机:横竖屏各写一页、选项/滚动/笔写三方共存、拖把手与自动加高、背景切换、交卷后再写。

### T6.5 结果页与错题重练回看
- 依赖:T6.4
- 产出:ResultQuestionCard「我的草稿」块(note.png 懒加载,InkThumbnail 同模式,onError 隐藏;公布 gate 前照常显示——本人内容不泄题);错题本/重练卷渲染路径确认草稿同样带出(D6.1 全局归属的自然结果);块置于卡内正常文档流(红线 §10-6,防 overflow-hidden 裁切)。
- 验收:组件测试(有/无草稿两态、图片失败隐藏、公布前后均显示);E2E:交卷→结果页见草稿图;错题重练进入该题同样可见;🧑 iPad 真机回看对齐(横竖屏书写后跨布局回看)。

### T6.6 P1 收尾:文档同步与全量回归
- 依赖:T6.4、T6.5
- 产出:架构文档 §5.4 增补草稿层小节(指向方案),顺带修正架构文档 §2 中过时的"本地状态 Zustand"表述(实态为 hooks 局部 state + TanStack Query);`docs/页面功能清单.md` 更新(答题页草稿区/结果页草稿块);本清单勾选与进度表更新;全量 `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`。
- 验收:全量绿;文档通读无歧义;🧑 用户按方案 §9 真机清单整体过一遍。

### T6.7 LearningPack 草稿模块与评析模板(教师整套导出)
- 依赖:P1 全部(T6.6)
- 产出:learning-pack 契约按 D19 模块化新增「草稿 PNG(question_notes)」可选 section(默认关,未勾选不出现;contract 为逐字段风格,需同步 modules schema、meta.modules 回显、superRefine、PromptInput/GoalSectionDeps、prompt 渲染段约 6 处);export-service 实现该模块(png + 元信息 strokeCount/updatedAt,**不透传矢量与事件**,D13;装配块照抄 ink 模块先例);D17 prompt 模板四 → 五:新增「逐题评析(含草稿)」(按勾选模块自动拼装,进 contract 单一源);`schema:export` + `gen:spec` 产物同步(学情分析提示词.md 自动增补);/t/export 向导约 8 个接触点更新(含 GOAL_OPTIONS 第五模板描述文案),预览大小估算服务端自动零改;**MCP `get_student_learning_pack` 需同步修改**:mcp/server.ts 的模块覆盖白名单 packModulesOverrideSchema、默认模块集 packRequestDefaults、逐字段浅合并、goal 枚举各加一处(属既有工具参数扩展,不算新接口)。
- 验收:契约单测(section 可选性);export-service 测试(勾选含草稿→包内出现 png 与元信息、未勾选→section 缺失、化名模式不含学生标识);E2E 导出向导勾草稿走完五步下载,解包断言包内文件;MCP 调用传 notes 模块与新 goal 出包成功;🧑 解包一份真实包人工核对结构与图片可读。

### T6.8 单题 AI 评析组合(学生结果页 + 教师详情页)
- 依赖:T6.5(学生侧数据齐)、T6.7(教师侧 prompt 口径统一后)
- 产出:纯函数 `buildQuestionReviewMarkdown(ctx)`(方案 §7.1 模板:题干快照 Markdown 原文含 `$...$`、学生作答文本化、判定、草稿引用、解析段;**行为数据段仅教师版**——activeSec/changeCount/hintsUsed 只在教师端契约,学生端结果契约没有,学生版不含,待 P3 契约扩展后再加)——学生/教师两上下文;学生结果页与教师详情页题卡「AI 评析」按钮:「复制评析文本」(clipboard.writeText)+「下载/复制笔迹图」(学生版:本人 note.png 与手写题 ink.png;教师版:T6.8 阶段先只含作答 ink.png,**草稿 note.png 待 T6.10 教师接口落地后点亮**;ClipboardItem 失败回退下载);**学生版"正确答案/判定/解析"三段均走 answersReleased 门控(服务端未公布已置 null,字段缺省即整段不渲染,红线 §10-5),教师版恒含解析/评语/最终判定/行为数据**。
- 验收:组合函数单测(两上下文、学生版无行为数据段、门控前后三段均不出现、LaTeX 原样保留);组件测试(两入口按钮、复制成功/失败提示);E2E:结果页复制按钮产生剪贴板调用与笔迹下载;泄露监控确认未公布时评析文本无解析内容;🧑 真实粘贴给一个大模型确认输出可直接读。

### T6.9 合成图导出(html-to-image)
- 依赖:T6.5;**新依赖审批点:PR 描述写明理由与替代方案(方案 D6.10)**
- 产出:引入 `html-to-image`;`features/notes/export-note-image.ts`(全量 getFontEmbedCSS 不做过滤 + preferredFontFormat woff2 会话缓存、pixelRatio 2 自适应降级、canvas 内联异常兜底替换 dataURL img、白底;方案 D6.10:KaTeX 是唯一 @font-face 来源,勿造 /katex-fonts/ 路径插件);草稿工具条与结果页「导出图片」入口(Blob 下载)。
- 验收:单测(mock 库)参数拼装与兜底分支;E2E:导出按钮触发 download 事件且文件为 PNG 魔数;🧑 **iPad Safari 真机:含公式题目的导出图公式字形正确(字体内联成功)、长题卡不被截断、横竖屏两种构图各导一张**。

### T6.10 教师端草稿查看与埋点(P2 收尾)
- 依赖:T6.2、T6.5
- 产出:`GET /api/teacher/students/:studentId/questions/:questionId/note.png`(归属链 student→teacherId,乙取甲 404 不暴露存在性);教师详情页/待批队列题卡「学生草稿」懒加载块(T3.2b 卡片结构顺延);**点亮 T6.8 教师版评析的草稿笔迹图入口**;事件 `note_edit_batch`(镜像 ink_edit_batch 四计数,payload 只存计数,D12/D13)。
- 验收:教师接口域隔离测试(乙取甲 404)+ assertNoLeak 不适用面说明(教师接口)但跑通用无泄露断言;事件契约扩展 + 服务端校验单测;E2E:教师详情见草稿图;🧑 教师在待批队列连批 5 题顺带查看草稿流畅。

---

**Phase 6 完成标志**:

1. P1(T6.1–T6.6):学生在 iPad 真机对选择题/填空题开草稿演算→交卷→回看见草稿,全程选项可正常选择——🧑 真机清单(方案 §9)逐项通过;
2. P2(T6.7–T6.10):教师从 /t/export 勾选「草稿 PNG + 逐题评析(含草稿)」导出一份包交给大模型,得到按题的错误步骤分析;学生/教师单题「AI 评析」复制粘贴即可用——🧑 各真实走一遍。
