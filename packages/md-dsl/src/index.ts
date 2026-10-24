/**
 * DSL 解析器与 linter 包。
 * v2 解析器：parseDocument 按 frontmatter kind 分派（practice 练习题 / lecture 讲义 H1 切分 /
 * mixed 讲义与题目拆分关联，T1.3/T1.4）；linter：lintDocument 在解析之上叠加规则校验
 * （未知指令、题型语义、未闭合容器等，T1.5）。2026-10-05 起不再支持 v1 旧格式
 * （解析器/转换/版本检测一并移除，见架构文档 §10 决策 10）。
 */

export type { LintOptions, LintResult } from "./lint/lint.ts";
export { lintDocument } from "./lint/lint.ts";
export {
  LECTURE_PREFIX_LINES,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "./v2/edit-context.ts";
export type {
  LectureFoldStructure,
  LectureSectionStructure,
  LectureStepsStructure,
  LectureStructure,
} from "./v2/lecture-structure.ts";
export {
  analyzeLectureStructure,
  weightedCharCounts,
} from "./v2/lecture-structure.ts";
// ::ref 属性串解析（行内式 ::ref 的属性抽取单源，materials.ts 单一出处）：
// 服务端导入层（P2-2 题内块式 ::ref{question=} 告警）复用，不另写一份。
export { parseRefAttrs } from "./v2/materials.ts";
export {
  simplifySizedMathDelimiters,
  sizedMathDelimiters,
} from "./v2/math-delimiters.ts";
// TT-06 新内容检测（决策记录 §5.8.4 触发清单）：NEW_CONTENT_DISABLED 的判定面，
// 导入层（QM-05）消费——本包只检测，不产 lint issue。无解析器核心改动。
export type { NewContentUsage } from "./v2/new-content.ts";
export { detectNewContent } from "./v2/new-content.ts";
// 导入规范化回写（tt-06b / QM-05，§5.2.3）：缺省 id 生成后写回源文——
// 导入层（content-service）在 lint/落库前调用；编辑器/导出不追加改写。
export type {
  NormalizedQmIds,
  NormalizeQmIdsOptions,
} from "./v2/normalize-ids.ts";
export { normalizeQmIds } from "./v2/normalize-ids.ts";
export type { ParseOptions } from "./v2/parse.ts";
export { parseDocument } from "./v2/parse.ts";
// 选择串展开（QM-13）：题级 ::ref{slots=…} → 有序 slotId 的单源展开——
// 服务端 matchingSlots 投影与保存校验共用（lint 第二遍同语义，不另写一份）。
export { expandSelectionIds } from "./v2/references.ts";
// 题干形态变换唯一公开面：学生端 payload 用 studentStemMd（脱敏 + 剥选项），
// 显示侧用 displayStemMd（剥选项不脱敏）；publicStemMd 不再出口——单独使用
// 它组学生载荷会泄露 [x] 正确项标记（v2/public-stem.ts 内部实现）。
export {
  displayStemMd,
  type StudentStemInput,
  stemMdLeaksAnswers,
  stripOptionListMd,
  studentStemMd,
} from "./v2/public-stem.ts";
export { processor } from "./v2/shared.ts";
// 讲练页切段（2026-10 讲练一体）：服务端学生侧安全投影的唯一入口——
// 题块原文绝不出现在学生载荷，question 段只携带题目 id（方案决策 1）。
export type { SplitLessonBlocksOptions } from "./v2/split-lesson.ts";
export { splitLessonBlocks } from "./v2/split-lesson.ts";
// 静态题目素材（T6R.12 前端建立，T6R.13 移入本包）：服务端单题 review-pack
// 与浏览器侧静态合成图共用的纯函数模块（DOM 渲染留在 apps/web）。
export type {
  GraphFigureSpec,
  QuestionMaterialRole,
  StaticQuestionMaterial,
  StaticQuestionMaterialInput,
} from "./v2/static-material.ts";
export {
  buildStaticQuestionMaterial,
  STATIC_INTERACTION_NOTE,
} from "./v2/static-material.ts";
