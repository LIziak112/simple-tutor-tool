# TT-09c 尾单报告（codex/tt-09c，2026-10-25）

> 一～六见 docs/题目模型与练习适配/验收记录.md「TT-09（tt-09c 部分）」与
> 决策记录 §22（两线收敛记档）。本文件承接尾单「验证留痕收口」职责；前序
> 81 轮会话截断时本报告未落盘，此处按第七节职责补建。

## 七、新流程验证留痕（分层测试三档口径，2026-10-25）

### 命令与结果

| 命令 | 兜底/选测决策 | 结果 |
| --- | --- | --- |
| `pnpm test:affected` | 兜底命中（migrations + packages/contract 变更）→ 全量单测 | 首轮 EXIT=1：6372/6378，`student-lesson.test.ts` 6 挂（合并残留，见下）；修复后 **EXIT=0：524 文件 / 6378 用例全绿** |
| `pnpm typecheck` | 全量类型基线 | **EXIT=0**（六包全 Done） |
| `pnpm lint:changed` | 兜底命中（migrations）→ `biome check .` | 首轮 1 error（result-review-model.test format）→ 修复后仅余 5 处 SelfReviewSection noNonNullAssertion **预存警告**（627d014d 已记档，非 error 不阻塞） |
| `pnpm e2e:affected` | 兜底命中（`apps/server/src/db/migrations/0040_bizarre_fabian_cortez.sql`）→ 全量 chromium 126 用例 / 6 workers | 首轮 EXIT=1：114 过 / 11 挂（**全部为分支预存断裂，非本尾单提交引入**，见分类）；修复后终跑 **EXIT=1：124 过 / 1 skip（fixme）/ 1 挂**——唯一挂为 130 题预热性能阈值（353.6ms > 150ms），**隔离复跑通过、判环境负载敏感，与本次改动无关**（见「环境性失败」） |
| `pnpm exec vitest run scripts/e2e-affected.test.mjs` | e2e 改动后核对登记守卫 | **16/16 过**（spec 标签未动） |

### 单测失败修复记档（student-lesson 六处，提交 5dc6e525）

合并 eadff82b 解决冲突时，六处断言被按 v2 e0e60af2「无条件冻结
reference_self」的期望改写，与收敛实现（QM 支线为基础，§22.1；§5.8.4
发布开关 `NEW_CONTENT_ENABLED` 关 → 开卷冻结 null 旧行旧语义）相抵：

1. fill 恒人工批改 summary / 混合卷末题收尾：`pendingCount` 0→1（旧行照计 D4 教师待批；测试标题本就写「计 1」）；
2. 待批谓词用例：恢复「提交后立即进队 + `marks[0].responseId` 出队」原貌（合并误改 `toHaveLength(0)` 且 mark URL 误用 questionRevisionId）；
3. 我的记录/教师卡两处 `pendingCount` 0→1；随时重开用例恢复「重开前 toContain、重开后清空」方向；
4. 讲练自评用例改走 `startOkNewContent`（开关开卷冻结 reference_self 才可自评 200；旧行 403 已有 student-self-review.test 专测）；开关模式收敛共享 helper、`makeSelfReviewEnv` 复用去重。

### e2e 失败分类与修复（提交 2d2f94b3 + 6c13937b）

首轮 11 挂全部为分支「待验证」积压的预存断裂（早于本尾单提交）：

- **A 类 9 个**：QM-12 把学生面汇总文案「待批」改「待判断」（结果瓦片/讲练条带/未答提示语，单测已锁定新文案），e2e 八 spec 仍等旧文案 → helpers 联合类型与 8 调用点、lesson/SAI-33 条带、review-workspace 提示语对齐；两处被首败遮蔽的深断言一并修复（lesson 条带改「答对 4」——QM-12 有效判定口径教师批对计入 correct；student-records 结果卡 `role=status` 旧状态行已随 VerdictBadge 重构不存在，改断言徽章文案）。教师端待批卡片/队列/详情文案有意不动。
- **B 类 1 个**：`student-self-review.spec.ts` 结构性跑不通——需要 `NEW_CONTENT_ENABLED=true` 服务端冻结 reference_self/manual_only，共享 webServer 恒开发布开关（全局开会翻转其他 spec 旧行断言）→ 标 `test.fixme` 记因（终跑计入 1 skipped），待专用开关 e2e 项目或 spec 内独立服务拍板（§22.2 后续项）。
- **C 类 1 个（环境性，如实记录不修）**：`student-workspace.spec.ts` 130 题预热阈值——满载两轮 187.7ms / 353.6ms > 150ms，**隔离复跑通过**（与圈画深比较失败同理：6 worker 满载 + 共租噪声，见记忆「计时基准共租噪声」）。性能预算是否随满载调整属产品拍板，不属尾单职权。
- 首轮另 1 个圈画深比较失败（annotation-cross-device-view）隔离复跑亦通过，判负载敏感。

### 本尾单提交链（183b1a9b 之后）

| 提交 | 内容 |
| --- | --- |
| 9ad93c52 | fix: verdictBadgeDisplayOf 旧行 autoCorrect 兜底与配套断言（WIP 收口 + result-review-model 按 D3/M6 口径修正） |
| 5dc6e525 | test: student-lesson 六处断言按两线收敛口径回正（合并残留） |
| 2ffce87c | chore: result-review-model.test biome format 收口 |
| 2d2f94b3 | test: e2e 学生面汇总文案对齐 QM-12「待判断」改名（8 spec） |
| 6c13937b | test: e2e 补两处被首败遮蔽的断言（lesson 汇总口径/records 徽章） |

### 剩余

- 130 题预热 150ms 预算在满载 e2e 下不可达（隔离可过）——预算口径待拍板；
- student-self-review e2e fixme 待开关环境方案；
- SelfReviewSection 五处 noNonNullAssertion 预存警告（非阻塞）；
- 分支合并 v2 与发 main 拍板（沿用 TT-09c 既定流程）。
