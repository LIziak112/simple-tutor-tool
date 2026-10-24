# TT-09b 修复轮报告（QM-11 收尾，2026-10-25）

> 本文件为审查/验证后修复轮附录。交付轮验证记录见
> docs/题目模型与练习适配/决策记录.md §21.4；验证单
> reports/tt-09b-verify.md（通过·有保留）与审查单
> reviews/tt-09b-codereview.md（放行·P0/P1 无）由编排者验收线持有引用。
> worktree stt-qm2，分支 codex/tt-09b（修复前 7 提交）。

## 修复清单（P2×1 / P3×2 / lint 5 警告）

### P2-1 「换意图换新键」断言补齐

SelfReviewSection.test.tsx 用例「失败保留现场可重试：同一意图复用同一
mutationId，换意图换新键」承诺的后半句无断言。补齐：同一意图复用断言保留
（失败→原意图重试→`second?.mutationId === first?.mutationId`），追加
失败后点另一 verdict 链（评 correct 失败→评 wrong 失败→点「暂不判断」
成功），断言 `fourth?.mutationId).not.toBe(third?.mutationId)`——先例
AiBatchReviewPanel.test.tsx 重试新幂等键断言同款。纯断言补充（既有
randomUuid 换意图新生成行为本已成立，TDD 豁免如实记录：非缺陷修复，
系覆盖缺口补齐，落位即绿）。

### P3-1 `_current` safeParse 失败分支缓存失效（TDD 先红后绿）

SelfReviewSection.tsx REVISION_CONFLICT 分支中 `_current` safeParse 成功
时采纳本地基线、失败时原实现静默不动作——与教师竞争
（SELF_REVIEW_TEACHER_MARKED）、未公布/不允许两分支均刷新本题投影不同
口径。先写红测试：409 冲突体不含 `_current`（`extra = {}`，旧后端/网关
剥离形态）断言 `["student","attempt",attemptId]` 失效被调用——首轮实跑
**失败**（`expect(keys.some(...)).toBe(true)` 收到 false，无任何失效调
用）；补 else 分支后复跑全绿。成功采纳分支不失效（§21 口径「本地采纳
refetch 归一」保持，不受本修复影响）。

### P3-4 注释与断言矛盾订正

self-review-display.test.ts:84 注释「finalCorrect ?? autoCorrect」与同
组断言（`finalCorrect: null` → `{ verdict: null }` 不回退）及实现
（self-review-display.ts 落尾 `return { verdict: question.finalCorrect }`，
注释「不做 autoCorrect 回退——待批就是待批」）矛盾。订正为「沿
finalCorrect 原路径、不做 autoCorrect 回退」。纯注释订正。

### lint 5 警告清理 + 归因订正（如实）

验证单发现 5 处 `lint/style/noNonNullAssertion`，全部位于
SelfReviewSection.test.tsx（121/159/166/167/199 行——`mock.calls[n]!`
非空断言）。**归因订正**：交付轮记档（决策记录 §21.4）称「余 5 警告系
存量基线非本单文件」失实——本 worktree 实跑 `pnpm lint` 确认 5 处全部
位于本单新建文件 SelfReviewSection.test.tsx，非存量基线。改写为库内先
例同款 `.at(n)?.[k]` 可选链（AdminTeachersPage/ExportWizard 等同款）+
解构 `?? []` 后可选属性访问，本文件 style 警告清零。

## 验证（修复轮，2026-10-25，最终工作树形态）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| pnpm exec vitest run apps/web/src/features/attempt/ | 0 | 59 文件 522 通过（含 SelfReviewSection 9 例：原 8 + P3-1 新例） |
| pnpm typecheck | 0 | 六包 Done |
| pnpm lint | 0 | 1289 文件零警告 |

全量由编排者合并前统一执行，本轮不重复（任务书约定；修复面为测试断言
改写 + 单分支缓存失效，定向面已覆盖）。

## 不修项记账

- **P3-2 基线账**：本分支树全量 6268（= 基点 codex/tt-09a 树 6246 + 本单
  22）；并入 codex/qm 后真实基线 **6270 = 6248 + 22**（codex/qm 线
  tt-09a 合入后基线 6248）。已落验收记录 TT-09b 编排者验收加注与总清单
  第三十五次备注，后续单以 6270 记账。
- **P3-5 v2 既有自评 UI 口径并存**：不涉代码，已由 QM-12 派单约束携带
  （两线合并以 QM 支线契约为准）。
- **P3-6 matching/ordering 占位未公布分支断言**：记账 QM-13 派单携带——
  QM-13 登记真实视图时占位整体消失，可不补，记录即可。
