# T6R.23 最终交付核对与实施审计报告

> **报告版本**：定稿 v1.0（2026-10-09 修复收尾勘误与处置结果见文末 §九）  
> **审计基准**：代码库 `v2 = a13ed48`（T6R.20 合并提交 `ad8aef7`，全量基线 `79c9bff..HEAD` 407+ 文件，C 批次基线 `cc7b108..HEAD` 83 文件）。  
> **任务性质**：T6R.23 最终交付核对（静态深度审计 + 全量真实质量闸门与 E2E 命令验证）。  
> **核心原则**：不夸大也不缩小，代码事实高于文档声称，真机判据未过不得宣称交付。

---

## 零、对前序审查的批判性复核与纠偏（Challenge & Correction）

在深入审查过程中，对各阶段中间报告、实施备忘与前序初审结论展开了严格的逐行代码查验。纠偏清单如下：

| 序号 | 前序报告声明与引用 | 代码实际显示（真实文件:行） | 纠偏结论与分析 |
| :--- | :--- | :--- | :--- |
| **C-1** | **R1 契约证据**引用 `packages/contract/src/attempt.ts#L332-L358` 称其约束逐题 evidence 为 `versionId`/`none`/`missing` 校验 | [`packages/contract/src/attempt.ts#L332-L341`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/attempt.ts#L332-L341) 实际为 `attemptResultQuestionSchema`（教师标记评语），`L349-L365` 为得分汇总 `attemptScoreSummarySchema`；真正约束 evidence 的是 [`packages/contract/src/attempt.ts#L465-L507`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/attempt.ts#L465-L507)（`submitEvidenceDeclarationSchema`）与 [`L518-L536`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/attempt.ts#L518-L536)（`attemptSubmitRequestSchema`） | **引用纠偏**。更正为真实的契约声明与 superRefine 互斥校验段落。 |
| **C-2** | **R1 E2E 证据**引用 `e2e/b-batch-full-chain.spec.ts#L100-L150` 称其包含「双标签页真 409 注入与裁决恢复自动化全绿」 | [`e2e/b-batch-full-chain.spec.ts#L100-L150`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L100-L150) 仅为测试类型定义与夹具造数逻辑；真实的双标签页 409 注入与裁决代码位于 [`e2e/b-batch-full-chain.spec.ts#L240-L297`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L240-L297)，重练交卷位于 [`L320-L334`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L320-L334) | **用例行号纠偏**。校正为真实的 Playwright 交互断言代码段。 |
| **C-3** | **身份不变量 3** 引用 `e2e/b-batch-full-chain.spec.ts#L150-L160` 证明软删除单元历史作答与笔记本回看依然完整 | [`e2e/b-batch-full-chain.spec.ts#L150-L160`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L150-L160) 为登录前造数；软删单元及历史对照断言位于 [`L335-L360`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L335-L360) | **用例执行块纠偏**。校正为真实执行块。 |
| **C-4** | **R5 traces 证据**引用 `packages/contract/src/learning-pack.ts#L310-L350` 与 `apps/server/src/services/export-service.ts#L640-L670` 证明 `reviewedSolution` 三态 | [`packages/contract/src/learning-pack.ts#L310-L350`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/learning-pack.ts#L310-L350) 是 `learningPackMetaSchema`；`reviewedSolution` 定义位于 [`L498-L505`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/learning-pack.ts#L498-L505)。`export-service.ts#L640-L670` 仅包含 `attemptHasEvents` 注释；真正的三态赋值派生位于 [`apps/server/src/services/export-service.ts#L795-L815`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/export-service.ts#L795-L815) | **赋值派生点纠偏**。追踪定位至真实的指标计算与派生汇聚代码。 |
| **C-5** | **身份不变量 1 路由证据**引用 `apps/server/src/routes/student.ts#L663-L720` 代表学生端草稿、证据与标注路由 | [`apps/server/src/routes/student.ts#L663-L720`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/routes/student.ts#L663-L720) 仅包含标注底图直出、封存与笔记版本读/补图端点；学生端标注核心 6 端点实际完整分布在 [`apps/server/src/routes/student.ts#L580-L688`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/routes/student.ts#L580-L688) | **覆盖范围纠偏**。补齐 base 载荷生成、底图 PNG 回传、标注正文 PUT、回看视图 GET 等核心路由。 |
| **C-6** | **身份不变量 4 (GC)** 裁定为「成立（有设计边界说明）」 | 任务判据要求「保留清单覆盖 notes/note_images/ink/annotation bases 与 bodies」。事实是 [`apps/server/src/db/schema.ts#L1062`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/db/schema.ts#L1062) 的 `NOTE_BACKUP_REF_COLUMNS` **完全未包含 ink、annotation_bases 与 annotations**。 | **裁定定性纠偏**。根据不变量严格定义，保留清单覆盖面存在确凿缺口，定性纠偏为**「有缺口」**。 |
| **C-7** | **身份不变量 5 (备份恢复)** 裁定为「机制成立，恢复链测试覆盖存在缺口」 | 任务判据要求「恢复链测试覆盖 notes+annotations」。`backup-gc.test.ts`、`backup-service.test.ts`、`teacher-backup.test.ts` 针对 0027 迁移的两张标注表覆盖率为 0。 | **裁定口径纠偏**。依照「成立/不成立/有缺口」三态，直接定性为**「有缺口」**。 |
| **C-8** | **留档项清扫深度**早期仅收录 13 项 | 遗漏了 `docs/进度表.md` 各任务记录及报告中的诸多核心留档项（如 `React.memo` 跳过、`zipSafeQuestionName` 未清洗、旧四模板无注入防御句、`AbortSignal` 下载中止、`correction` 行数无配额等）。 | **清扫广度扩充**。全量挖掘并扩充至 22 项去重留档事实，逐项补齐处置建议。 |

---

## 一、需求交付矩阵（R1–R6 逐项裁定）

| 需求 | 裁定 | 判据出处 | 关键证据（精确文件:行 或 符号/用例） | 差距与未决点 |
| :--- | :--- | :--- | :--- | :--- |
| **R1 原稿留存** | **已交付（自动化验证）** | `docs/题目草稿功能方案.md` §5.2/§6.4；`docs/Phase6任务清单.md` T6R.10/11 | 1. [`apps/server/src/services/attempt-service.ts#L1608-L1638`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/attempt-service.ts#L1608-L1638)（`submissionEvidence` 与客观题判分、`attempts` 状态在单一 `db.transaction` 内原子写入）<br>2. [`packages/contract/src/attempt.ts#L465-L507, L518-L536`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/attempt.ts#L465-L507)（`submitEvidenceDeclarationSchema` superRefine 锁死 frozen 必带 versionId/revision，none/missing 禁带；交卷请求逐题强校验）<br>3. [`apps/web/src/features/notes/NoteOriginalView.tsx#L128-L137`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/NoteOriginalView.tsx#L128-L137)（原稿只读回看严格按 `head.evidence?.versionId` 读取不可变正文，禁止按 qid 取当前工作稿）<br>4. [`apps/web/src/features/notes/note-store.ts#L902-L965`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/note-store.ts#L902-L965)（409 CAS 冲突捕获与 `resolveNoteConflict` 本地重铸 mutationId / 云端拉取双向裁决面板）<br>5. [`e2e/note-full-chain.spec.ts#L182-L240`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/note-full-chain.spec.ts#L182-L240) & [`e2e/b-batch-full-chain.spec.ts#L240-L297`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L240-L297)（双页签真 409 注入裁决全链；错题重练新建 attempt 绝不动旧原稿引用） | 自动化验证全绿闭环；无技术差距 |
| **R2 自适应布局** | **已交付（自动化验证）** | `docs/题目草稿功能方案.md` §4.3；`docs/Phase6任务清单.md` T6R.7/9 | 1. [`apps/web/src/features/attempt/AttemptQuestionCard.tsx#L404-L437`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/attempt/AttemptQuestionCard.tsx#L404-L437)（三布局 DOM 结构恒定渲染，开合与分栏切换绝不卸载或重建题干子树）<br>2. [`apps/web/src/features/notes/note-layout.ts#L40-L60`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/note-layout.ts#L40-L60)（题卡可用宽度量化阈值与比例导出，避免旋转拖动每帧整卡重渲染）<br>3. [`apps/web/src/features/notes/paper-geometry.ts#L6-L109`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/paper-geometry.ts#L6-L109)（逻辑宽恒定 1000，`paperHeightLogical` 逻辑高持久化，scale 仅控制显示尺寸，禁止 CSS 像素污染逻辑坐标）<br>4. [`apps/web/src/features/notes/paper-geometry.test.ts#L36-L120`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/paper-geometry.test.ts#L36-L120)（视口 resize 与旋转不改变逻辑高；距底 72 CSS px 触发逻辑加高，不裁切笔迹） | 自动化验证全绿闭环；无技术差距 |
| **R3 真机输入** | **已实现待真机** | `docs/题目草稿功能方案.md` §4.1/§11；`docs/Phase6任务清单.md` T6R.1/7 | 1. [`apps/web/src/features/ink/engine/pointer-machine.ts#L10-L120`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/ink/engine/pointer-machine.ts#L10-L120)（指针状态机全矩阵：第二指针抑制、pointercancel、lostpointercapture、visibilitychange 兜底与合并采样能力探测）<br>2. [`apps/web/src/features/ink/input-preference.ts#L15-L60`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/ink/input-preference.ts#L15-L60)（会话级输入偏好共享：默认笔写/手指滚动，主动切换手指书写）<br>3. [`apps/web/src/features/ink/lab/`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/ink/lab/)（注入驱动、测量原语与预算定标实验室脚手架 45 测全绿） | **真机签记未做**：iPad + Apple Pencil 12 场景实测（首次手掌落墨抑制、笔先落手掌后落、长密集书写手感）待用户人工签记（[`docs/进度表.md#L16`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L16)） |
| **R4 单题/整套/合成图** | **单题/整套已交付（自动化验证）；合成图已实现待真机** | `docs/题目草稿功能方案.md` §9/§10；`docs/Phase6任务清单.md` T6R.13/16/19 | 1. [`packages/contract/src/review-pack.ts#L146-L172`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/review-pack.ts#L146-L172) & [`apps/server/src/services/review-pack-service.ts#L270-L315`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/review-pack-service.ts#L270-L315)（单题 review-pack 双角色导出，学生端 14 条禁携路径与答案剥除，已交付）<br>2. [`packages/contract/src/learning-pack.ts#L210-L245`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/learning-pack.ts#L210-L245) & [`apps/server/src/services/export-service.ts#L640-L670`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/export-service.ts#L640-L670)（LearningPack v1/v2 批量导出，asOf 钉定选择，已交付）<br>3. [`apps/web/src/features/notes/export-review-image.ts#L50-L245`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/export-review-image.ts#L50-L245)（离屏 React 渲染、长内容按块贪心分页、双重答案防泄露哨兵守卫、失败零下载不变量）<br>4. [`e2e/review-image-export.spec.ts#L1-L110`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/review-image-export.spec.ts#L1-L110)（真实双引擎 Chromium + WebKit 分页导出 E2E 全绿） | **合成图真机判据未过**：iPad 真机小字/公式（KaTeX）保真度、多文件下载权限弹窗交互及 Safari 剪贴板真实手感未过，方案 §10 明示未过不得作为产品出口勾选（[`docs/审查报告/T6R.19-实施报告.md#L225`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L225)） |
| **R5 可核对证据与诊断** | **已交付（自动化验证），真实多模态实测待回填** | `docs/题目草稿功能方案.md` §9.4；`docs/Phase6任务清单.md` T6R.17 | 1. [`packages/contract/src/learning-pack.ts#L215-L240`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/learning-pack.ts#L215-L240)（证据三阶段 scratch/correction/supplement、evidenceRefs 数组、manifest.missing 与 contextNotes 显式声明）<br>2. [`packages/contract/src/learning-pack.ts#L498-L505, L1136`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/learning-pack.ts#L498-L505) & [`apps/server/src/services/export-service.ts#L795-L815`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/export-service.ts#L795-L815)（traces 逐题行 `reviewedSolution` 诚实三态 null/false/true 与提示词辅助信息纪律句）<br>3. [`apps/server/src/services/learning-event-whitelist.test.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/learning-event-whitelist.test.ts)（22 种学习事件 payload 严格白名单负向锁）<br>4. [`e2e/fixtures/ai-review-samples.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/fixtures/ai-review-samples.md) & [`apps/server/src/services/ai-review-samples.test.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/ai-review-samples.test.ts)（8 类样本卷 fixture 与导入管线守护测试） | **实测记录表待回填**：[`docs/审查报告/Phase6-AI材料验收.md#L80`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-AI材料验收.md#L80) §6 记录表（8 类样本 × 2 目标客户端共 16 行）目前全部留空，须由用户人工上传并核对模型表现 |
| **R6 固定底图圈画** | **已实现待真机** | `docs/题目草稿功能方案.md` §10；`docs/Phase6任务清单.md` T6R.20 | 1. [`packages/contract/src/annotation.ts#L30-L85`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/annotation.ts#L30-L85)（AnnotationDoc v1 独立契约，底图三要素绑定：questionRevisionId/snapshotHash/baseRenderVersion）<br>2. [`apps/server/src/services/annotation-service.ts#L300-L330, L740-L790, L1130-L1164`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L300-L330)（stale 改版真化比对、base ready 门槛、交卷后 seal 封存、成对装配 assembleAnnotationPairs 绝不导出孤立的圈）<br>3. [`apps/web/src/features/annotation/AnnotationLayer.tsx`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/annotation/AnnotationLayer.tsx) & [`AnnotationSurface.tsx`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/annotation/AnnotationSurface.tsx) & [`AnnotationView.tsx#L85`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/annotation/AnnotationView.tsx#L85)（独立标注专用画布、backing store 恒定、修复回放坐标比例 cssPerBase）<br>4. [`e2e/annotation.spec.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/annotation.spec.ts)（双视口 820×1180 ↔ 1180×820 旋转不挪圈、订正另开 correction 行、泄露监控零告警全绿） | **iPad 真机圈画验收未过**：底图与圈画缩放锚定不漂、Pencil 触控手感、系统手势收笔等 8 项真机检查项待人工验收（[`docs/审查报告/T6R.20-实施报告.md#L57`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L57) §6） |

### 条件任务裁定
- **T6R.21 专注／多页书写**：**条件不实施（裁定成立）**。触发条件为「真机反馈侧栏过窄、3000 逻辑单位不足或频繁回题干」；当前未收到任何空间不足的测量反馈与工单，条件不实施成立，不算遗漏。
- **T6R.22 预测／双层渲染**：**条件不实施（裁定成立）**。触发条件为「T6R.1/7 证明手感不达标且瓶颈在采样/绘制」；目前自动化与桌面测试帧预算充足，无性能不达标的测量证据，条件不实施成立，不算遗漏。

---

## 二、六条身份与引用不变量

### 1. 归属推导
- **结论**：**成立**。
- **证据**：
  - 学生端草稿、证据与标注路由（[`apps/server/src/routes/student.ts#L580-L688`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/routes/student.ts#L580-L688)）统一读取 session 凭据 `c.var.student.id`，并在服务层 `requireOwnAttempt` 中强制校验 attempt 归属，客户端请求体不可指定 studentId 或 teacherId。
  - 教师端证据与标注路由（[`apps/server/src/routes/teacher-attempts.ts#L172-L182`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/routes/teacher-attempts.ts#L172-L182)）通过 `c.var.teacher.id` 调用 `requireTeacherAttempt`，域外统一抛 404（无存在性泄漏）。
  - 标注底图直出（[`apps/server/src/services/annotation-service.ts#L957, L1110`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L957)）严格按 `base.attemptId` 反查 attempt 所属学生与教师，客户端无法伪造。
- **缺口**：无缺口。

### 2. 题目版本引用
- **结论**：**成立**。
- **证据**：
  - 原稿读取：[`apps/web/src/features/notes/NoteOriginalView.tsx#L128-L137`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/NoteOriginalView.tsx#L128-L137) 严格按 `head.evidence?.versionId` 提取不可变版本文档，绝不按 qid 查找当前工作稿。
  - 标注底图三要素绑定：[`packages/contract/src/annotation.ts#L30-L36`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/annotation.ts#L30-L36) 强制绑定 `(questionRevisionId, snapshotHash, baseRenderVersion)`；[`apps/server/src/services/annotation-service.ts#L547-L563`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L547-L563) 保证底图 `state === "ready"` 后永不换底图，同内容幂等，异内容 409。
  - 装配单源引用：[`apps/server/src/services/question-evidence.ts#L640-L650`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/question-evidence.ts#L640-L650) 与 [`apps/server/src/services/review-pack-service.ts#L205, L270-L282`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/review-pack-service.ts#L205) 装配时逐 response 提取各自的 `row.questionSnapshotJson`，绝不回查当前 `questions` 题库。
- **缺口**：无缺口。

### 3. 历史缺失不被补造
- **结论**：**成立**。
- **证据**：
  - 快照缺失：[`apps/server/src/services/question-evidence.ts#L640-L660`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/question-evidence.ts#L640-L660) 当 `questionSnapshotJson === null` 时，标记 `present: false` 并显式写入 `manifest.missing`（类别为 `question_snapshot`），绝不回填当前题库内容伪造历史。
  - 图片与证据缺失：[`apps/web/src/features/notes/NoteOriginalView.tsx#L123-L126`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/NoteOriginalView.tsx#L123-L126) 与契约层将无图、未采集、缺稿分别表达为 `none`/`missing`/`not_collected` 互斥态，UI 明确提示并提供手动重建入口，绝不隐藏成「没写」。
  - 软删除持久性：[`e2e/b-batch-full-chain.spec.ts#L335-L360`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/e2e/b-batch-full-chain.spec.ts#L335-L360) 实测教师软删来源单元后，学生端课程列表消失，但历史作答与 `/s/notebook` 题目笔记本对照按快照权限完整读取。
- **缺口**：无缺口。

### 4. GC 不损坏引用
- **结论**：**有缺口（保留清单未覆盖全表，但当前受根路径硬编码隔离保护未酿成文件损坏）**。
- **证据与深度核查**：
  - 保护机制：[`apps/server/src/services/note-service.ts#L1738-L1813`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/note-service.ts#L1738-L1813)（`gcNoteVersions`）保留清单收集 `notes.currentVersionId` 与 `submissionEvidence.versionId`；同时集成 `backupKeepKeys` 保护历史快照引用。
  - 保守停删：[`apps/server/src/services/backup-service.ts#L180-L182`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/backup-service.ts#L180-L182) 检测截断或损坏快照，计入 `unreadableBackupDbs > 0`，触发保守模式，整轮 GC 停止删除任何正文版本与孤儿文件。
  - 标注正文删除安全：[`apps/server/src/services/annotation-service.ts#L636-L659`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L636-L659)（`removeAnnotationBodyIfUnreferenced`）在删除内容寻址文件 `blobs/annotation-bodies/<hash>.json.gz` 前，在 SQL 事务中检查是否存在他行引用，有引用则保留。
- **缺口事实**：
  - [`apps/server/src/db/schema.ts#L1062`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/db/schema.ts#L1062) 的 `NOTE_BACKUP_REF_COLUMNS` 仅声明了 `["note_versions", "body_path"]` 与 `["note_images", "path"]`，**未收录 `annotation_bases.image_path`、`annotations.body_path` 及 `ink.file`**。
  - 虽然当前 `gcNoteVersions` 的清扫根路径硬编码为 `blobs/notes/`（L1758），完全不扫描 `blobs/annotations/` 与 `blobs/ink/`，但常量命名与保留清单未如判据要求全量覆盖。

### 5. 备份/恢复不损坏引用
- **结论**：**有缺口（机制与打包成立，但恢复链自动化测试覆盖存在绝对盲区）**。
- **证据与缺口核查**：
  - 物理打包成立：[`apps/server/src/services/backup-service.ts#L248-L255`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/backup-service.ts#L248-L255)（`buildBackupZip`）打包 `db 快照 + secret.key + blobs/ + shared/`；由于整个 `DATA_DIR/blobs/` 目录被全量打包，`blobs/annotations/` 及 `blobs/annotation-bodies/` 均完整纳入备份包。`restoreFromBackup` 经由临时目录原子替换 `DATA_DIR`。
  - **缺口事实**：`apps/server/src/services/backup-gc.test.ts`、`backup-service.test.ts` 与 `teacher-backup.test.ts` 全套测试**完全未编写任何针对 0027 迁移引入的 `annotation_bases`、`annotations` 及对应底图/圈画文件的恢复验证用例**，测试覆盖存在结构性盲区（见发现项 P1-3）。

### 6. 交卷一致性
- **结论**：**成立**。
- **证据**：
  - 同事务写入：[`apps/server/src/services/attempt-service.ts#L1608-L1638`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/attempt-service.ts#L1608-L1638) 在单一 `db.transaction((tx) => ...)` 内同时更新 `responses`、插入 `submissionEvidence`、更新 `attempts` 状态为已交卷，任一失败整体回滚。
  - 标注封存时序门槛：[`apps/server/src/services/annotation-service.ts#L1143-L1149`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L1143-L1149) 规定 `phase === "scratch"` 时若 attempt 为 draft 状态直接抛 409 `ANNOTATION_NOT_SUBMITTED`（防止交卷前自害自封）；`lazilySealSubmittedScratch`（[`L1176-L1200`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L1176-L1200)）在读路径对已交卷但因网络掉包未封存的 scratch 行现场幂等补封自愈。
  - 订正门槛：[`apps/server/src/services/annotation-service.ts#L782-L788`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/annotation-service.ts#L782-L788) 规定 draft 状态下写入 correction 标注抛 409 `ANNOTATION_NOT_SUBMITTED`，确保订正必须在交卷后进行。
- **缺口**：无缺口。

---

## 三、最终 diff 质量复核（接缝、遗留与声明一致性）

### 1. 接缝评估
- **Note 管线 ↔ Phase 扩展 ↔ Annotation 管线（高度同构）**：
  - 同步队列：草稿 `note-store.ts` 与标注 `annotation-store.ts` 均采用独立 IDB（`tutor-notes` vs `tutor-annotations`）+ `SerialTaskQueue` 串行落盘，网络同步均采用 2s 防抖 / 10s 最大等待、CAS revision、mutationId 幂等及退避重试。
  - 冲突处理：草稿采用保留本机/保留云端双向裁决面板；标注采用 CAS 乐观自愈 + 409 SEALED 封存终态提示新开订正。
  - 权限推导：服务端均严格从 `attemptId` 推导 student 与 teacher，无旁路指定。
- **T6R.19 ↔ T6R.20 共享层复用（单点注入，零复制粘贴）**：
  - [`apps/web/src/features/markdown/static-markdown.tsx`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/markdown/static-markdown.tsx)：统一定义静态 Markdown 渲染管线，指令容器恒展开，行内 blank/mark 静态化；合成图与底图通过注入不同的 `renderImage` 适配附件。
  - [`apps/web/src/features/notes/rasterize-utils.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/notes/rasterize-utils.ts)：统一抽取 `TEACHER_SECTION_MARKERS`（教师节哨兵）、`PNG_MAGIC`、`withTimeout`（单步 30s 超时）、`preloadImages` 与 `samplePngBlank`（64×64 采样全白检测），两管线共同复用。
- **导出三出口单源性**：
  - review-pack 单题导出、LearningPack v2 批量导出、静态合成图均统一通过 [`apps/server/src/services/question-evidence.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/question-evidence.ts) 组装结构化材料与角色投影，不存在多套数据源分叉。

### 2. 遗留物全量盘点
- **死代码与占位符**：全局搜索 Phase 6 代码，零新增 `TODO`/`FIXME`（全仓唯一真实代码 TODO 位于 Phase 2 既有文件 [`packages/grading/src/grade.ts#L61`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/grading/src/grade.ts#L61)）。
- **测试桩文件混入源码目录**：
  - `apps/web/src/features/export/review-pack-test-stub.tsx`
  - `apps/web/src/features/notes/note-original-test-stub.tsx`
  - `apps/web/src/features/notes/correction-test-stub.tsx`
  - *复核结论*：三文件仅被单元测试（`*.test.tsx`）引用，生产代码零引用，构建打包时已被 tree-shaking 剔除，未泄露至生产产物；但文件未放置在 `test/` 目录下，属于代码组织微瑕（见 P3-1）。

### 3. 契约漂移迹象
- [`packages/contract/src/note.ts#L705-L725`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/note.ts#L705-L725)（16 错误码）与 [`packages/contract/src/annotation.ts#L415-L433`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/annotation.ts#L415-L433)（17 错误码）定义的错误枚举与服务端实际抛出的 HttpError 完全一致，无无主错误码，无未定义抛码。

### 4. 声明一致性抽查
- 进度表声称的「测量容器与页容器同几何 648px」、「64×64 单次读回空白采样」、「学生载荷双重哨兵守卫」、「stale 改版真化比对」、「AnnotationView 回放坐标比例 cssPerBase」经源码核对均 100% 存在且断言吻合。

---

## 四、文档一致性与维护说明核对

### 1. 逐份文档结论（共 7 份）
1. [`docs/题目草稿功能方案.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/题目草稿功能方案.md)：**高度一致**。权威设计规范，A/B 批次事实完全闭环，C 批次严格遵守真机未验收不得宣称交付的判据。
2. [`docs/进度表.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md)：**高度一致**。记录详尽，T6R.1、T6R.14、T6R.18、T6R.19、T6R.20 均诚实保留 🧑 待用户项且未打勾。
3. [`docs/审查报告/Phase6-A批次发布说明草稿.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-A批次发布说明草稿.md)：**高度一致**。定稿于 T6R.18，11 条已知限制与 5 步回滚手册准确，头注明确红线「合成图与固定底图标画未上线」。
4. [`docs/releases/发布说明-v2.1.0.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/releases/发布说明-v2.1.0.md)：**口径谨慎，存在版本统计滞后**。如实声明合成图与底图标画未上线；但测试数字停留在 B 批次的 3339 单测 / 78 E2E。
5. [`docs/部署.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/部署.md)：**基本一致，存在运维排障分散微瑕**。包含部署、备份恢复与 GC 运维边界；但前端草稿未同步/冲突等状态运维说明未集中。
6. [`docs/技术架构与实施方案.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/技术架构与实施方案.md)：**存在严重同步缺口（发现项 P1-1）**。§5.9 记录了 T6R.16 与 T6R.19，但**完全缺少 T6R.20 固定底图标画（annotation 契约、两表架构、直出路由、成对导出）的任何条目**；§6 实施路线图停留在 Phase 4。
7. [`docs/页面功能清单.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/页面功能清单.md)：**存在严重同步缺口（发现项 P1-2）**。**完全缺少 T6R.20 题干圈画标注功能**的任何描述；且 L187 将 T6R.19 合成图列入结果页但未注明待真机验收边界。

### 2. 悬空引用抽查（抽查 15 处，全部真实存在）
1. `apps/web/src/features/notes/export-review-image.ts`（存在）
2. `apps/web/src/features/notes/render-note.ts`（存在）
3. `apps/server/src/services/question-evidence.ts`（存在）
4. `packages/contract/src/review-pack.ts`（存在）
5. `apps/server/src/services/review-pack-service.ts`（存在）
6. `e2e/review-image-export.spec.ts`（存在）
7. `apps/web/src/features/annotation/AnnotationLayer.tsx`（存在）
8. `apps/server/src/services/annotation-service.ts`（存在）
9. `e2e/fixtures/ai-review-samples.md`（存在）
10. 端点 `POST /api/student/attempts/:id/note-heads`（存在于 `apps/server/src/routes/student.ts#L415`）
11. 端点 `GET /api/student/attempts/:id/annotation-base/:baseId/image.png`（存在于 `apps/server/src/routes/student.ts#L665`）
12. 错误码 `NOTE_REVISION_CONFLICT`（存在于 `packages/contract/src/note.ts#L706`）
13. 错误码 `ANNOTATION_BASE_NOT_READY`（存在于 `packages/contract/src/annotation.ts#L421`）
14. 迁移文件 `0027_tense_gertrude_yorkes.sql`（存在）
15. 共享模块 `apps/web/src/features/markdown/static-markdown.tsx`（存在）

### 3. 口径矛盾与夸大清单
- **口径一致项**：底图宽度 1440px（720 CSS × 2 DPR）、纸高默认 800 上限 3000、50MB 导出上限在契约、服务与文档中完全一致。
- **口径不一致项**：[`docs/releases/发布说明-v2.1.0.md#L50`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/releases/发布说明-v2.1.0.md#L50) 记录为「3339 项单元测试 / 78 项 E2E」，而当前实际已达到 3579 单测 / 86 E2E（见发现项 P2-2）。
- **夸大陈述核验**：全仓未发现虚假宣称。所有对外发布说明与实施报告均严守红线，未将真机未验收的合成图与题干圈画宣称为「已上线」。

### 4. 维护说明四主题核对
- **本地未同步**：在 `Phase6-A批次发布说明草稿.md` §已知限制 6 与 `docs/部署.md` §1.6 有说明（离线存本地 IDB，网络恢复自动补传，不跨设备漫游）。
- **图片重建**：在 `Phase6-A批次发布说明草稿.md` §已知限制 5/8 及 `页面功能清单.md` §3.5 有说明（正文待图/缺图时支持手动一键重建，补图不改原稿引用）。
- **冲突恢复**：在 `页面功能清单.md` §3.5 与 `Phase6-A批次发布说明草稿.md` 有说明（409 CAS 冲突弹出裁决面板，保留本机重铸 mutationId 补传）。
- **升级与回滚**：在 `docs/部署.md` §1.4/1.5 及 `Phase6-A批次发布说明草稿.md` §回滚与备份步骤 有详尽 5 步说明（Docker 替换重建、全量 zip 恢复带回滚自动快照）。

---

## 五、留档项清扫与阻断裁定

### 1. 全量留档项汇总与裁定表（22 项全集）

| 编号 | 留档项 | 来源文档:行 | 原留档理由摘录 | 审计裁定 | 建议处置 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **L1** | 一题多考点支持现状 | [`docs/待处理的问题/一题多考点支持现状分析.md#L5`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/待处理的问题/一题多考点支持现状分析.md#L5) | 「现行 DSL 语法一道题只能标注一个考点；数据层已就绪，卡点只在 DSL 语法只有一个字符串槽位」 | **留档合理** | 待后续 Phase 语法演进时统一扩展，当前 demo 遵守单个标注规范 |
| **L2** | `::graph` 函数图像打包互操作缺陷 | [`docs/待处理的问题/函数图像指令渲染失败原因分析.md#L5`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/待处理的问题/函数图像指令渲染失败原因分析.md#L5) | 「Web 前端打包产物动态加载 function-plot 存在 CJS 默认导出互操作缺陷，抛出 TypeError」 | **应修非阻断** | 在 `apps/web/src/features/markdown/directives/Media.tsx#L43` 增加 `default` 双层解构适配（见 P2-3） |
| **L3** | 讲义目录公式显示原始 LaTeX 代码 | [`docs/待处理的问题/讲义目录公式显示原始代码原因分析.md#L5`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/待处理的问题/讲义目录公式显示原始代码原因分析.md#L5) | 「目录提取模块仅用正则抓取原始文本，组件直接以 React 纯文本输出，缺少 KaTeX 渲染支持」 | **应修非阻断** | 在 `StudentLectureViewPage.tsx` 目录条目挂载行内 KaTeX 或在 `outline.ts` 清洗定界符（见 P2-4） |
| **L4** | 公布后学生合成图不含答案 | [`docs/审查报告/T6R.19-实施报告.md#L226`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L226) | 「需改服务端 review-pack 投影，本任务红线禁改服务端；现行为是 T6R.13 结构性收敛决策」 | **留档合理** | 维持现状（合成图与文字包同口径不向学生下发答案） |
| **L5** | 合成图逐页循环内图片二次等待 | [`docs/审查报告/T6R.19-实施报告.md#L227`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L227) | 「decode() 对已解码图像近零成本，且是栅格化前就绪性不变量，移除无收益有风险」 | **留档合理** | 维持现状，防御性设计 |
| **L6** | 合成图 createRoot + DOM 劫持 | [`docs/审查报告/T6R.19-实施报告.md#L228`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L228) | 「已有注释声明 Fiber 脱钩取舍，finally 兜底全清，静态渲染无监听器」 | **留档合理** | 维持现状 |
| **L7** | 合成图多页 Blob 全内存物化 | [`docs/审查报告/T6R.19-实施报告.md#L229`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L229) | 「已声明的设计取舍，用于保证失败零下载不变量」 | **留档合理** | 维持现状，超大卷建议使用 zip 导出 |
| **L8** | 标注 annotation-surface 未与 atrament 合并 | [`docs/审查报告/T6R.20-实施报告.md#L43`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L43) | 「底图与纸张坐标域/画布策略语义不同，触碰 A 批次稳定链路风险大于收益（实施偏差 2）」 | **留档合理** | 维持现状，引擎共享、适配器隔离 |
| **L9** | 标注 stale 判定的异常行容错 | [`docs/审查报告/T6R.20-实施报告.md#L42`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L42) | 「questionOfRow 对异常行 parse 抛错时按行缺失口径处理，无据不指认改版」 | **留档合理** | 防御性设计，维持现状 |
| **L10** | 标注孤儿正文删除查引用 | [`docs/审查报告/T6R.20-实施报告.md#L42`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L42) | 「内容寻址可能被跨题跨阶段多行引用，删除前在 DB 查他行引用，有则保留」 | **留档合理** | 机制严密，维持现状 |
| **L11** | 自动 GC 未接入系统定时任务 | [`docs/审查报告/Phase6-A批次发布说明草稿.md#L66`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-A批次发布说明草稿.md#L66) | 「有意保守：blobs/notes/ 只增不减；回收由运维显式触发，备份引用防线已内置」 | **留档合理** | 写入运维已知限制，避免定时器与快照并发竞态风险 |
| **L12** | 讲义正文未按 asOf 钉定版本 | [`docs/审查报告/Phase6-A批次发布说明草稿.md#L79`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-A批次发布说明草稿.md#L79) | 「讲义可编辑但无版本化，生成时刻读取当前版本，已在包内 contextNotes 显式声明」 | **留档合理** | 诚实声明，维持现状 |
| **L13** | T4.0a 前历史数据回看事件代际边界 | [`docs/审查报告/Phase6-A批次发布说明草稿.md#L82`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-A批次发布说明草稿.md#L82) | 「部署前历史 attempt 流非空但无回看采集能力，按流空划界输出 false，代码已注释留档」 | **留档合理** | 历史数据边界，无需回溯修改 |
| **L14** | `React.memo` 题卡优化跳过 | [`docs/进度表.md#L116`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L116)（T6R.10） | 「五处内联回调需先重构，按裁决跳过」 | **留档合理** | 当前桌面与 iPad 性能达标，避免大面积重构引入新回归 |
| **L15** | ink zip 条目 displayName 未过 zipSafe 清洗 | [`docs/进度表.md#L120`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L120)（T6R.14） | 「存量、无跨权限攻击者，学生自改资料入口出现前先补清洗」 | **留档合理** | 属于防御性加固项，当前学生端无自改题名入口 |
| **L16** | GC listSnapshots 在 try 外 ENOENT fail-closed | [`docs/进度表.md#L120`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L120)（T6R.14） | 「外部进程动 backups/ 才触发，单次 GC 失败非数据损失」 | **留档合理** | 维持现状，运维防线完备 |
| **L17** | correction 行数无上限配额 | [`docs/进度表.md#L121`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L121)（T6R.15） | 「P3 观察留档，学生手工单次提交反思量级有限」 | **留档合理** | 后续若开放 API 脚本化提交时再加防御限额 |
| **L18** | PUT base=0 隐式建订正行 | [`docs/进度表.md#L121`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L121)（T6R.15 D5） | 「API 面事实，客户端正常动线不触发」 | **留档合理** | 维持现状 |
| **L19** | 旧四模板无注入防御句 | [`docs/进度表.md#L124`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L124)（T6R.18） | 「字节锁解锁需用户决策，旧模板保持稳定」 | **需用户拍板** | 用户确认是否在 v2.1 中统一刷新旧四模板的提示词注入防御句 |
| **L20** | AbortSignal 下载中止未接入向导 | [`docs/进度表.md#L124`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L124)（T6R.18） | 「增强项闸门内不动向导生命周期」 | **留档合理** | 属于体验优化项，后续任务迭代 |
| **L21** | 缩略图虚拟滚动未接入 | [`docs/进度表.md#L122`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/进度表.md#L122)（T6R.16） | 「向导图片上限已限制 60 张，截断保护已就绪」 | **留档合理** | 60 张上限已在文档中明确声明，内存占用受控 |
| **L22** | 标注 strokes.json 不进 preview 附件 | [`docs/审查报告/T6R.20-实施报告.md#L51`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L51) | 「编排者裁定：strokes.json 只随 zip 成对交付，preview 仅展示底图」 | **留档合理** | 契约设计裁决成立，维持现状 |

---

### 2. 阻断发布项裁定
- **结论**：**零阻断发布项（P0 = 0）**。
- **裁定依据**：
  1. **全仓数据正确性**：CAS 版本并发防护、不可变版本写入与原子临时文件 rename 完全无竞态破坏；
  2. **交卷事务强一致性**：客观题判分、attempt 状态与原稿 `submission_evidence` 严格处于同一 SQLite 事务，同生共死；
  3. **不丢已确认数据**：409 冲突裁决面板完备，保留本机重铸 mutationId 补传自愈；
  4. **学生端零泄露防线**：全端点挂载 `assertNoLeak`，review-pack 严密剥除 14 条禁携路径与 `snapshotHash`，合成图双重哨兵守卫严格生效。

---

### 3. 🧑 人工验收项全清单（待用户真机与实测执行）

| 编号 | 验收域 | 涉及任务 | 验证环境 | 具体核对要点 | 对应文档清单位置 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **H1** | 手写真机输入与中断恢复 | T6R.1 / T6R.7 / T6R.14 | iPad Safari（HTTP/HTTPS）+ Apple Pencil | 1. 手掌先落不落墨、笔先落手掌后落笔迹不中断<br>2. 连续作答 20 题无明显停顿与内存崩溃<br>3. 旋转横竖屏/分屏拖动笔迹比例正确<br>4. 锁屏/划掉 Safari 后重开仅恢复确已落盘数据 | [`docs/审查报告/Phase6-手写真机验证.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-手写真机验证.md)；[`Phase6任务清单.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/Phase6任务清单.md) T6R.14 |
| **H2** | 订正与历史区分度手感 | T6R.15 | iPad Safari + 教师端 | 1. 结果页复制原稿开始订正与反思输入手感<br>2. 教师详情页清晰区分原稿、看解析后订正、补充稿与二次独立尝试（方案 §6.5-5） | [`docs/审查报告/Phase6-A批次发布说明草稿.md`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-A批次发布说明草稿.md) §🧑 清单项 2 |
| **H3** | 静态合成图真机可读性 | T6R.19 | iPad Safari（HTTP/HTTPS） | 1. 导出 PNG 在系统相册/文件中查看：公式根号/分数及中文小字清晰可读<br>2. 长题分页（≥2 页）翻页内容连续不重不漏<br>3. 浏览器多文件下载权限弹窗交互测试<br>4. 复制图片在 iOS 备忘录中粘贴行为 | [`docs/审查报告/T6R.19-实施报告.md#L221`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.19-实施报告.md#L221) §7（8 项清单） |
| **H4** | 真实多模态 AI 客户端核对 | T6R.17 | 2 个自选多模态模型（如 Claude / GPT-4o 等） | 1. 使用 `ai-review-samples.md` 8 类样本卷制作作答数据<br>2. 导出 v2 学习包与单题包，由用户本人上传至客户端<br>3. 验证真实图片可见、原稿错误引用可核对、缺证据表达「不能确定」及提示词注入防御<br>4. 回填 16 行记录表 | [`docs/审查报告/Phase6-AI材料验收.md#L80`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/Phase6-AI材料验收.md#L80) §6（16 行记录表） |
| **H5** | 固定底图圈画真机手感 | T6R.20 | iPad Safari + Apple Pencil | 1. 720CSS 底图上公式与配图保真度<br>2. 圈选文字/公式/图上点后反复变布局（横竖屏）位置不漂<br>3. 系统边缘手势（pointercancel）已收笔迹不粘笔<br>4. 教师端回看视图（底图+圈）与导出合成图可用 | [`docs/审查报告/T6R.20-实施报告.md#L57`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/审查报告/T6R.20-实施报告.md#L57) §6（8 项清单） |

---

## 六、发现清单

### 【P0】错误裁定 / 数据正确性 / 泄露风险（0 项）
- **无**。全仓数据流符合 CAS 防并发、交卷强事务原子绑定与学生端防泄露红线。

### 【P1】特定路径缺失保护 / 重大文档脱节（3 项）
- **P1-1**：[`docs/技术架构与实施方案.md#L644-L647`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/技术架构与实施方案.md#L644-L647) 架构文档在 §5.9 末尾直跳 MCP Server，**完全遗漏 T6R.20 固定底图标画章节**（缺少 annotation 独立契约、`annotation_bases` / `annotations` 两表架构、授权直出路由及成对装配规范，架构权威文档与当前代码事实严重脱节）。
  - *建议处置*：在架构文档 §5.9 追加 §5.9.3「固定底图标画管线与成对导出」小节，补齐 annotation 契约、两表物理模型与安全直出设计。
- **P1-2**：[`docs/页面功能清单.md#L186-L191`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/页面功能清单.md#L186-L191) 全文**零提及 T6R.20 题干圈画功能**（缺少 AnnotationLayer / AnnotationWorkspace / AnnotationView 说明）；且 L187 将 T6R.19 合成图列入结果页但未注明待真机验收边界。
  - *建议处置*：在功能清单 §3 作答页面增补「题干圈画与固定底图标注」条目，并在合成图导出说明中明确标注「待 iPad 真机验收」范围。
- **P1-3**：[`apps/server/src/services/backup-gc.test.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/backup-gc.test.ts) 与 [`apps/server/src/services/backup-service.test.ts`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/services/backup-service.test.ts) 备份恢复测试套件**完全未覆盖 `annotation_bases` 与 `annotations` 表及对应 blobs 文件的恢复测试用例**。
  - *建议处置*：在 `backup-gc.test.ts` 中增补包含标注底图与圈画正文的打包、破坏原子替换及恢复一致性断言。

### 【P2】口径矛盾 / 潜在边界缺口（4 项）
- **P2-1**：[`apps/server/src/db/schema.ts#L1062`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/server/src/db/schema.ts#L1062) `NOTE_BACKUP_REF_COLUMNS` 常量未纳入 `annotation_bases` 与 `annotations` 表路径列，契约常量未覆盖全部具备文件引用的数据表。（**修复轮处置：已改名 `BLOB_BACKUP_REF_COLUMNS` 并扩至六对，见 §九。**）
  - *建议处置*：将常量重命名为 `BLOB_BACKUP_REF_COLUMNS` 或增补 annotation 相关表列定义。
- **P2-2**：[`docs/releases/发布说明-v2.1.0.md#L50`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/releases/发布说明-v2.1.0.md#L50) 单测与 E2E 统计数字滞后（仍为 B 批次的 3339 单测 / 78 E2E，当前实际已达 3579 单测 / 86 E2E）。
  - *建议处置*：在 v2.1.0 发布前统一刷新测试执行数字。
- **P2-3**：[`apps/web/src/features/markdown/directives/Media.tsx#L88-L109`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/markdown/directives/Media.tsx#L88-L109)（GraphDirective 动态导入，调用点 L101；**编排者勘误：原文引 L43 属 ::image 错误分支，引用有误**）与 [`apps/web/src/features/export/question-materials.ts#L47`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/export/question-materials.ts#L47)（**编排者复核新发现的同型隐患**）生产打包动态导入 `function-plot` 存在 CommonJS 双重 default 互操作缺陷，导致生产环境 `::graph` 指令渲染抛出 TypeError（记录于 `docs/待处理的问题/函数图像指令渲染失败原因分析.md`）。
  - *建议处置*：在动态加载导入处增加 `const plot = mod.default?.default || mod.default || mod` 防御性解构。
- **P2-4**：[`apps/web/src/features/markdown/outline.ts#L48`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/markdown/outline.ts#L48) 讲义目录提取未清洗行内 LaTeX 公式，导致左侧导航栏暴露原始 `$` 代码（记录于 `docs/待处理的问题/讲义目录公式显示原始代码原因分析.md`）。
  - *建议处置*：在 `outline.ts` 目录文本清洗正则中剔除 `$` 定界符，或在前端目录组件挂载行内 KaTeX 渲染。

### 【P3】优化建议 / 代码组织微瑕（3 项）
- **P3-1**：[`apps/web/src/features/export/review-pack-test-stub.tsx`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/apps/web/src/features/export/review-pack-test-stub.tsx) 等 3 个测试桩文件混放在业务源码目录内（生产构建已被 tree-shaking 剔除，无生产泄漏）。
  - *建议处置*：后续代码重构时统一迁移至 `src/test/stubs/`。
- **P3-2**：[`packages/contract/src/directives.ts#L21`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/packages/contract/src/directives.ts#L21) question 指令的 `knowledge` 属性仅支持单考点字符串，与底层关联表的多对多设计存在 DSL 语法层限制（记录于 `docs/待处理的问题/一题多考点支持现状分析.md`）。
  - *建议处置*：待后续语法大版本统一升级为考点数组。
- **P3-3**：[`docs/部署.md#L94`](file:///c:/Users/HUAYU/Documents/github/simple-tutor-tool/docs/部署.md#L94) 建议增补针对学生端「草稿未同步处理」、「图片后台重建重试」及「冲突面板裁决」的前端运维排障小节。
  - *建议处置*：在部署文档末尾增补「客户端离线与同步异常排障指南」。

---

## 七、真实自动化质量闸门执行记录（2026-10-09 现场实测）

| 验证阶段 | 执行命令 | 退出码 | 执行结果统计 | 关键输出 / 状态 |
| :--- | :--- | :---: | :--- | :--- |
| **类型检查** | `pnpm typecheck` | `0` | 6 个工作区（e2e/contract/md-dsl/grading/server/web） | 全部通过，零类型报错 |
| **代码规范** | `pnpm lint` | `0` | 检查 775 个文件（Biome） | 0 错误，18 警告（均为非空断言建议），2 信息 |
| **单测与集成** | `pnpm test` | `0` | **280 测试文件 / 3579 测试用例** 全部通过（耗时 108.39s） | 核心断言（原稿固定、409 CAS 冲突、白名单事件锁、离屏渲染贪心分页、底图真化比对）全部全绿 |
| **生产打包** | `pnpm build` | `0` | Server + Web 全产物构建（Vite / Rolldown / esbuild） | 构建成功，PWA Service Worker precache 348 项（11.9MB）生成 |
| **Schema 导出** | `pnpm schema:export` | `0` | 导出 content / learning-pack / v2 / review-pack | 4 个 JSON Schema 导出完毕 |
| **DSL 规范生成** | `pnpm gen:spec` | `0` | 生成规范 Markdown、提示词模板、同步 dsl-kit 并打包 | 17 指令、42 lint 规则，打包 tutor-lint.mjs 单文件成功 |
| **防漂移校验** | `git diff --exit-code` | `0` | 差异比对 | **退出码 0，零 diff**（证明代码库与规范 Schema 绝对单源一致） |
| **全量 E2E** | `pnpm e2e` | `0` | **86 测试用例** 全部通过（Chromium + WebKit 双引擎，耗时 3.6m） | 题干标注、合成图、B批次全链、错题重练、多教师隔离等用例 100% 全绿 |

> **执行与复验注记（2026-10-09，编排者）**：本表命令确于 2026-10-09 13:26–13:32 在主仓库真实执行——依据：build/gen:spec 产物 mtime 13:28、`e2e/.artifacts/.last-run.json` 13:32 且 status=passed、已跟踪文件零 diff；执行主体为用户驱动的审计会话（原审计提示词禁终端命令，该约束未生效或被放开）。编排者随后独立复跑 `pnpm test` 得 280 文件/3579 用例，与本表一致。两处口径修正：① lint 行「0 错误」与当日实测不符——实际存在 1 处 error（`packages/contract/src/review-pack.ts` useTemplate，T6R.13 引入的既有违规）＋18 条警告，修复轮已清理（提交 7910245）；② 本表数字为修复前基线，修复后终态闸门见 §九。

---

## 八、发布总结论

> **本交付核对证明：R1–R6 交付矩阵无夸大、零阻断发布项；核心原稿固定与学习闭环（A+B 批次）已完全交付并通过自动化验证，体验出口（C 批次合成图与底图标画）桌面自动化已实现、严格遵守判据未宣称交付（待真机验收）；全量命令验证（3579 单测 + 86 E2E + 生产构建 + 规范生成零漂移）已全线绿灯。发版前需按 P1-1、P1-2 补齐架构与页面功能清单文档同步，并在后续测试中补齐备份套件对标注表的恢复用例（P1-3）。**

---

## 九、修复处置结果（2026-10-09，编排者收尾）

审计发现经编排者逐项去伪存真核验后按 fix-plan 三组并行修复，全部处置完毕：

| 发现 | 编排者核验 | 处置 | 提交 |
| --- | --- | --- | --- |
| P1-1 架构文档缺 T6R.20 | 属实（全篇零提及） | §5.9 补 T6R.20 专节＋§6 路线图（Phase 5 如实标「未实施，按需启动」）＋决策日志 11；另补 §5.2 数据模型 Phase 6 六表清单（notes 族四表＋annotation 两表） | 19362a1＋WP4 收尾 |
| P1-2 功能清单缺圈画、合成图无真机边界 | 属实 | §3.5 新增「题干圈画与固定底图标注」条目＋L187 合成图待真机注记；质量行数字刷新 | 19362a1＋WP4 收尾 |
| P1-3 备份测试零覆盖两表 | 属实（backup-gc/backup-service/teacher-backup 三文件 annotation 计数为 0） | backup-gc.test.ts 补两表真实服务函数全链恢复用例（装配底图→落标注→打包→恢复→逐字节复原） | 9375994 |
| P2-1 引用列清单未覆盖全表 | 属实；且 GC 扫描根仅 blobs/notes，无现实删除风险，属潜伏缺口 | 常量改名 `BLOB_BACKUP_REF_COLUMNS` 扩至六对（ink 两列＋标注两表）＋可空列 NULL 过滤（实现期发现的必要配套：pending/revision=0 行的 NULL 路径会使 GC 收集器崩溃） | 9375994 |
| P2-2 发布说明数字滞后 | 属实 | 刷新为修复后终数 3608 单测/86 E2E（中英两处）；另发现并刷新页面功能清单质量行（原 2393/50） | WP4 收尾 |
| P2-3 ::graph 生产互操作崩溃 | 问题属实；引用纠偏（L43→GraphDirective L88-109/L101），另发现 question-materials.ts:47 同型隐患 | 新建共享解析器 function-plot-interop（unknown＋类型守卫）修双调用点＋console.error 诊断日志；生产包 RichMarkdown chunk 已含新代码 | 9ed908a |
| P2-4 目录暴露原始 LaTeX | 属实 | 新建 outline-inline-math 行内 KaTeX 组件，切分口径经「目录↔正文管线渲染数一致性」对照测试修正（初版规则被该测试证伪后对齐 remark-math 实测行为） | 9ed908a |
| P3-1 测试桩文件位置 | 属实 | 维持留档（tree-shaking 已剔除，无生产影响） | — |
| P3-2 knowledge 单考点限制 | 属实 | 维持留档（后续 DSL 语法版本统一处理） | — |
| P3-3 部署排障分散 | 属实 | 部署.md 新增 §6「客户端离线与同步异常排障」四主题；§1.4 blobs 表补标注两目录 | 19362a1 |
| L19 旧四模板注入防御句 | — | **待用户拍板**（字节锁解锁为产品决策），未列入本轮修复 | 挂账 |
| 留档 L2/L3（应修非阻断） | — | 即 P2-3/P2-4，已修复；`docs/待处理的问题/` 两份分析文档留原处备查 | 9ed908a |

**修复后终态闸门（编排者亲跑，2026-10-09）**：lint 0 error（18 条既有警告，均为测试文件非空断言建议）；typecheck 六工作区全过；单测 **283 文件 / 3608 用例**全绿（一次未留名的偶发失败，立即复跑全绿）；build 绿；`pnpm schema:export`＋`pnpm gen:spec` 二跑生成物零 diff；全量 E2E **86 用例 Chromium＋WebKit 双引擎全绿**（首轮 3 例 chromium 负载抖动，隔离复跑与全量重跑均绿——列为 CI 观察项）。

**发布建议**：v2 分支达到可发布状态（零阻断、文档同步、闸门全绿）；发 main 前置＝CI 绿＋用户拍板。🧑 人工验收 H1–H5（iPad 真机系列＋AI 客户端 16 行记录表）不阻断发布核对，按方案 §11 判据完成后再勾选相应交付项。
