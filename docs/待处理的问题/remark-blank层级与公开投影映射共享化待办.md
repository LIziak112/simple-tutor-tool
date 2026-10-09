# remark-blank 层级与公开投影映射的共享化待办

> 记录日期：2026-10-09（T7.9 审查发现，超出该任务范围未当场处理）
> 来源：T7.9 样例回归门禁的四角度质量审查（复用/简化/效率/层级），两条属生产代码改动，按 T7.2 先例留待后续任务。

## 一、remarkBlank 停在 apps/web 层，解析域知识反向伸手

`apps/web/src/features/markdown/remark/remark-blank.ts` 把 `[[…]]` 语法糖转成 blank 指令，其头注释自述"规则与 packages/md-dsl v2 解析器一致"——`[[…]]` 的识别语义（math/code 子树跳过等）同时存在于：

1. 解析器：`packages/md-dsl/src/v2/question.ts`（scanStem）；
2. 投影：`packages/md-dsl/src/v2/public-stem.ts`（publicStemMd / stemMdLeaksAnswers）；
3. 渲染：`apps/web/.../remark-blank.ts`（本文件）。

三份知识靠约定同步。T7.9 的测试辅助 `test-support/dsl-samples.ts` 因 md-dsl 侧无此转换可复用，经相对导入伸手 apps/web（测试代码可容忍，但生产分层不变量明文是"packages 不得 import apps/web"，见 `static-material.ts:19` 与 `contract/note.ts:25` 的同类约束）。

**建议**：照 T6R.13 static-material 先例，把 remarkBlank（纯函数、无 DOM 依赖）移入 `packages/md-dsl`（如 `src/v2/blank-transform.ts`），web 的 `pipeline.ts`/`RichMarkdown.tsx` 改从包出口导入；`test-support/dsl-samples.ts` 随之改用同层导入。适合与 T7.2（宿主消费 Zod 属性解析）或 T7.3（DirectiveSessionContext）一并做，避免渲染管线反复动刀。

**状态（2026-10-09）**：T7.2、T7.3 均已完成，本项未并入——两任务的清单条目均不含此项，且它是跨包搬迁+样例门禁的独立回归面，与上下文收编混批会模糊 bisect 边界。仍待处理；建议作为独立小任务（半天量级）或随下一次动渲染管线的任务落地。

## 二、Question → 学生端公开投影的字段映射有三份同构拷贝

`id/type/difficulty/knowledge/stemMd(studentStemMd)/options.map(text)/hintCount` 的映射手写于：

1. `apps/server/src/services/attempt-service.ts`（publicOfSnapshot，私有）；
2. `apps/server/src/services/assignment-service.ts`（同构内联）；
3. `apps/web/src/features/attempt/sample-rendering.test.tsx`（toPublic，T7.9 测试镜像）。

投影规则演进（新增剥除项等）时三处漂移；`questionPublicSchema.parse` 只守形状不守投影语义。web 测试不能 import server 包（跨 app），前两份也未导出。

**建议**：把"Question（或冻结快照）→ questionPublicSchema 形态（不含 questionRevisionId）"的纯投影函数落到 `packages/md-dsl` 或 `packages/contract` 侧导出，服务端两处与测试共用；assignment-service 的多字段形态（dueAt 等）在其上扩展。适合与 T7.4（能力契约与题型桥接表，本就要动 contract）同批处理。

**状态（2026-10-09）**：T7.4 已完成，本项未并入——清单条目不含此项，且投影函数共享化是 server/web 行为等价重构（三处调用点 + 泄露测试回归面），与契约词表添加分属两个回归面（与 T7.3 不并入 remarkBlank 同口径的范围纪律）。仍待处理；建议作为独立小任务，或在触及 attempt/assignment 投影逻辑的下一个任务里顺带。
