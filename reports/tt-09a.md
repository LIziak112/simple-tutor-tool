# TT-09a（QM-10）修复附录（2026-10-24，审查单 reviews/tt-09a-codereview 有条件放行后的必修项闭环）

> 本文件为编排者验收轮落盘的修复记录（执行报告正文由编排者会话持有）；修复内容与口径决策记档见[决策记录](../docs/题目模型与练习适配/决策记录.md) §20.5。

## 修复清单

| 项 | 内容 | 处置 |
| --- | --- | --- |
| P1（必修） | `attemptFinalOutcomeOf` 对 legacy 协议+开关开启卷整卷收尾建模缺口：行级 `submittedAt` 仅逐题语义卷写（responses.submittedAt 是逐题提交列），legacy 行恒 null → allSubmitted 恒 false → 整卷交卷恒 submitted/scoreFinal=null，markResponse 批改重算同病 | 已修（5e402bf3）：增 `opts.finalized` 入参（与四态 gate `row.submittedAt ?? 收尾事实` 同口径），交卷/自动收尾/批改重算三链路统一传 finalized；DB 写入零变化、协议分野护栏断言；TDD 先红后绿两例（审查探针形态复现） |
| P2（必修） | assertNoLeak 的 forbid「详解哨兵」是 `:::solution` 正文**值**非键名，键名匹配永不命中（断言虚设） | 已修（同提交）：补 `assertNoSolutionSentinel` 值级断言（JSON.stringify 全文 not.toContain），三处接线（首评 200 体 / 409 附 _current 体 / 全码循环），删 forbid 冗余条目；值级命中语义构造体实证 |
| P3-3（顺手） | 等价形式用例（1/2 vs 0.5）putAnswer 未断言 200，静默丢稿会让「等价/不同」前提失效 | 已修（同提交）：逐题补 200 断言（与 saveAllAnswers 同精神） |
| P3-4（顺手） | 测试拆分标签笔误：grade-row 实测 **32** 例、student-self-review **19** 例（两文件拆分账原稿 30+21，总数 51 不变） | 已修：决策记录 §20.3「矩阵 30 例」订正 32 例（self-review 19 原稿已正确）；执行报告同账订正以本附录为准 |
| P3-1（留 QM-11） | attemptScoreSummaryOf 与 lessonLiveSummaryOf 口径并存——消费侧选型或对齐 | 留 QM-11（自评 UI/答案对照消费侧一并定夺） |
| P3-2（留 QM-12） | selfReviewRecordOf 脏行防御 | 留 QM-12（有效判定投影统一与 finalCorrect IS NULL 审计同批） |

## 修法选型（P1，报告理由）

采**修法②**（`attemptFinalOutcomeOf` 增 finalized 入参）弃修法①（交卷链路 outcomeRows 新判分行恒记 nowIso）：

- ② 与四态 gate（`practiceQuestionFeedbackStateOf` 的 `row.submittedAt !== null || finalized`）同一谓词形状，单一语义出口覆盖交卷/自动收尾/批改重算三链路；
- ① 仍需 markResponse 侧重算另行归一（两处口径），且内存 FinalOutcomeRow 与 DB 行事实分叉（legacy 行 DB 恒 null、内存记时刻），违背行级事实不虚构原则；
- ② DB 行写入零变化（rowSubmittedAtPatch 逐题分野保持），测试加护栏断言 legacy 整卷交卷后行 submittedAt 恒 null。

## 验证（2026-10-24，worktree stt-qm，修复提交 5e402bf3 形态）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run apps/server/src/routes/student-self-review.test.ts -t "审查 P1"`（修复前） | 1 | **先红**：两例 `expected 'submitted' to be 'graded'`（交卷链路 + 教师批改重算链路，与审查探针形态一致） |
| `npx vitest run apps/server/src/routes/student-self-review.test.ts`（修复后） | 0 | 21/21（19 既有 + 2 新增，含组合回归：manual_only 未判阻塞/清除回落/协议分野护栏） |
| `pnpm exec vitest run packages/grading/ apps/server/` | 0 | 150 文件 2339/2339 |
| `pnpm typecheck` | 0 | 六包 Done |
| `pnpm lint` | 0 | 1285 文件零问题（首轮两处 format 由 biome format --write 收口，语义零变化） |
| `pnpm test`（全量） | 1→判无关 | 512 文件 6248 例：6247 过 + 1 失败——失败为 `apps/web/src/features/student-ai/route-integration.test.tsx` SAI-07 beforeEach 10s 超时（与交付轮第三十二次备注同款偶发形态，本 diff 零 web 改动），隔离复跑该文件 5/5 全绿判偶发无关；= 交付基线 6246 + P1 新增 2 |

## 提交

- 5e402bf3 fix(tt-09a)：P1 finalized 入参三链路接线 + P2 值级哨兵断言 + P3-3 PUT 200 断言
- （随后）docs：决策记录 §20.5、验收记录 TT-09 节与编排者加注、总清单第三十三次备注、本附录
