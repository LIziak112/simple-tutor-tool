import { z } from "zod";
import { materialSchema, unitGroupSchema } from "./material.ts";
import { practiceRecommendationSchema } from "./practice-workflow.ts";
import { teachingPackSchema } from "./teaching-pack.ts";

/**
 * 内容契约（DSL v2）：练习题、讲义、单元与解析结果的权威数据结构。
 * 依据：docs/技术架构与实施方案.md §5.1（内容 DSL v2）、§5.1.1(4)（原文是真相）、§5.2（数据模型）。
 *
 * 两点全局约定：
 * 1. 「原文是真相」：Question.sourceMd / Lecture.markdown 保存原始 Markdown，
 *    本文件的结构化字段只是"判分与统计必需"的抽取结果，展示内容在前端渲染时再解析。
 * 2. 「学生端防泄露」：QuestionPublic 是学生端唯一允许下发的题目形态，
 *    不含 answers / solutionMd / hints 内容 / sourceMd / 选项正确项标记，只有 hintCount。
 *    学生端接口（T2.4 起）必须经它过滤输出，并有泄露测试兜底（AGENTS.md 硬性规则 3）。
 */

/** 题型（§5.1 规则要点表，共七种）：判断 / 单选 / 多选 / 填空 / 计算 / 应用 / 找错 */
export const questionTypeSchema = z.enum([
  "judge",
  "choice",
  "multi",
  "fill",
  "solve",
  "apply",
  "find-error",
]);

/**
 * 题型中文名（UI 徽章与 T3.4 CSV 导出共用；前后端共用同一份，禁止各自手写）。
 * 手写题集合（solve/apply/find-error，答案 kind=final 的题型）自 UA-01 起由
 * capability.ts 的跨端证据角色绑定派生（HANDWRITTEN_QUESTION_TYPES，正式纸面
 * 资格单源），不再在本文件维护字面量。
 */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  judge: "判断",
  choice: "单选",
  multi: "多选",
  fill: "填空",
  solve: "计算",
  apply: "应用",
  "find-error": "找错",
};

/** 化名编号（学生A/学生B…，按名单顺序编号）：字母列号核心算法单一来源 */
export function lettersOf(index: number): string {
  // 0→A … 25→Z、26→AA（电子表格列号同款进制）
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * 参考答案 → 文本序列化（QuestionAnswers 的家在 content.ts，单一来源）：
 * - judge→对/错、choice→字母、multi→字母串、fill→逐空等价答案「或」连接、
 *   空与空「；」分隔、final→原文；
 * - mathify 可注入显示侧的 LaTeX 包裹启发式（web 结果页 formatReferenceAnswers
 *   传 mathifyAnswerText；服务端单题包 review-pack 不传——裸 LaTeX 对 AI 更
 *   友好，渲染管线行为不复刻进契约）。
 */
export function formatQuestionAnswers(
  answers: QuestionAnswers,
  options: {
    readonly mathify?: (text: string) => string;
  } = {},
): string {
  const mathify = options.mathify ?? ((text: string) => text);
  switch (answers.kind) {
    case "judge":
      return answers.value ? "对" : "错";
    case "choice":
      return lettersOf(answers.index);
    case "multi":
      return [...answers.indexes]
        .sort((a, b) => a - b)
        .map((index) => lettersOf(index))
        .join("");
    case "fill":
      return answers.blanks
        .map((blank) => blank.map(mathify).join(" 或 "))
        .join("；");
    case "final":
      return mathify(answers.answer);
  }
}

/**
 * 文档类型：练习 / 讲义 / 混合 / 讲练页（frontmatter kind）。
 * lesson（2026-10 讲练一体，第四种文档形态）：题目容器合法且**保留在讲义
 * markdown 原位**（解析时开围栏注入最终题目 id），导入建讲练页 + 练习单元；
 * 学生端单题提交、当题即时释放对错与详解——服务课堂"讲一段练一题"场景。
 */
export const documentKindSchema = z.enum([
  "practice",
  "lecture",
  "mixed",
  "lesson",
]);

/**
 * 选择题选项：text 为选项 Markdown（字母 A/B/C/D 由顺序推导，不单独存）。
 * 正确项的唯一权威表示是 answers（choice.index / multi.indexes）——历史上本对象
 * 曾冗余存过 correct 布尔，因全链路零消费方且与 answers 双家并存易漂移，已于
 * 2026-10 移除；旧库 options_json / 冻结快照中的 correct 经 questionSchema
 * 解析时被 strip（本 schema 非 strict），无需数据迁移。
 */
export const optionSchema = z.object({
  text: z.string(),
});

/**
 * 各题型答案形态（存入 §5.2 questions.answersJson）：
 * - fill：blanks 外层按空位顺序与题干 `[[…]]` 标记一一对应，内层为该空的可接受答案列表（等价答案，如 ["0.5", "1/2"]）；
 * - choice：index 为正确项下标（0 起，对应 A=0）；单选恰一个正确项由 linter 保证；
 * - multi：indexes 为全部正确项下标；
 * - judge：value 为布尔语义值（DSL 写法 `[[正确]]`/`[[错误]]` 由解析器映射）；
 * - final：solve/apply/find-error 手写题可选的"最终答案"文本，用于自动判分；未提供时该题交由教师批改。
 */
export const fillAnswersSchema = z.object({
  kind: z.literal("fill"),
  blanks: z.array(z.array(z.string().min(1))),
});

export const choiceAnswersSchema = z.object({
  kind: z.literal("choice"),
  index: z.number().int().min(0),
});

export const multiAnswersSchema = z.object({
  kind: z.literal("multi"),
  indexes: z.array(z.number().int().min(0)).min(1),
});

export const judgeAnswersSchema = z.object({
  kind: z.literal("judge"),
  value: z.boolean(),
});

export const finalAnswersSchema = z.object({
  kind: z.literal("final"),
  answer: z.string(),
});

export const questionAnswersSchema = z.discriminatedUnion("kind", [
  fillAnswersSchema,
  choiceAnswersSchema,
  multiAnswersSchema,
  judgeAnswersSchema,
  finalAnswersSchema,
]);

/**
 * 题目（教师侧完整形态）。字段参考 §5.2 questions 表：
 * - id：来自 DSL；缺省由解析器按 `单元slug-序号` 生成。编辑内容时保持 id 不变，学情统计才能跨版本延续；
 * - difficulty：1–5 的整数（星级颗粒度），题目指令属性缺省值由注册表（T1.2）决定；
 * - knowledge：考点列表（§5.2 经 knowledge_points/question_knowledge 关联表存储），DSL 单个 knowledge 属性也归一为数组；
 * - options：仅 choice/multi 有（GFM 任务列表形式存于 stemMd，抽取为纯文本数组；正确项以 answers 为权威）；
 * - answers：见 questionAnswersSchema，缺失/不完整由 linter 报 issue，契约层允许缺省以便表达"带错误的解析结果"；
 * - stemMd：题干 Markdown。注意填空题 stemMd 中的 `[[答案]]` 标记含参考答案，属教师侧内容；
 * - solutionMd：详解，交卷后才下发；
 * - sourceMd：该题原始 Markdown 片段（reparse 与单题编辑的依据，T1.12/T1.14）。
 * 跨字段约束（如 choice 必须有 options、fill 空数与 blanks 对齐）由解析器与 linter 保证，契约只管单字段形态。
 */
export const questionSchema = z.object({
  id: z.string().min(1),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)).default([]),
  stemMd: z.string(),
  options: z.array(optionSchema).optional(),
  answers: questionAnswersSchema.optional(),
  hints: z.array(z.string()).default([]),
  solutionMd: z.string().optional(),
  sourceMd: z.string(),
});

/**
 * 题目（学生端公开形态）——显式白名单，故意不派生自 questionSchema：
 * 新增 Question 字段时若忘了在这里登记，只会"少给"而不会"多给"，泄露即失败（fail closed）。
 * 语义差异：
 * - options 是纯文本数组（无 correct 标记），携带正确项标记的对象会被整体拒绝而非静默通过；
 * - stemMd 必须是脱敏后的题干（填空标记内不含答案文本），由服务端投影时生成；
 * - hints 只暴露数量 hintCount，内容由 T2.11 分步接口按需下发。
 */
export const questionPublicSchema = z.object({
  id: z.string().min(1),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  stemMd: z.string(),
  options: z.array(z.string()).optional(),
  hintCount: z.number().int().min(0),
});

/**
 * 截止时间格式（UTC ISO 字符串，带 Z 后缀；datetime-local 本地值由前端转
 * UTC 后提交）。不接受无时区的本地格式（如 2026-09-30T18:00）与 +hh:mm
 * 偏移写法，避免歧义。原定义在 assignment.ts；T6R.3 收敛时下移本文件——
 * attempt.ts 的视图（dueAt 字段）与 assignment.ts 的创建/PATCH 共用同一份，
 * 且 attempt ↔ assignment 不可互相导入（避免环）。
 */
export const assignmentDueAtSchema = z.iso.datetime({ offset: false });

/**
 * 答案公布时机（T2A.8，D11）：on_submit=交卷即公布（默认，现状语义）；
 * after_due=截止后公布——**必须设置截止时间**：create 选 after_due 而 dueAt 缺失、
 * 或 PATCH 把 dueAt 置 null / 去掉截止时当前为 after_due，均 400 VALIDATION_ERROR
 * （防死锁态：永不公布）。截止前学生结果视图只下发「已交卷」与本人答案，
 * 截止后（now ≥ dueAt）读时自动恢复完整结果（无定时任务）。
 * course 来源作答恒为交卷即公布（D11），不适用本字段。
 * 原定义在 assignment.ts；2026-10-21 下移本文件——attempt.ts 草稿视图的
 * answerRelease 字段与 assignment.ts 的创建/PATCH 共用同一份，且
 * attempt ↔ assignment 不可互相导入（避免环，同 assignmentDueAtSchema 先例）。
 */
export const assignmentAnswerReleaseSchema = z.enum(["on_submit", "after_due"]);

/** 练习单元（练习集）。id 来自 DSL（标题 slug，题目缺省 id `单元slug-序号` 中的"单元slug"即它）；数据库层的 courseId/order/updatedAt 与解析无关 */
export const unitSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  topic: z.string().optional(),
  /** 关联讲义标题（frontmatter lecture），导入时解析为 §5.2 units.lectureId */
  lectureTitle: z.string().optional(),
  /**
   * 做题方式与反馈节奏推荐（frontmatter practice，M5-D1）：只推荐非权限，
   * 可选且**禁止 z.default()**——缺省不注入键，老文档解析结果形状不变。
   */
  practice: practiceRecommendationSchema.optional(),
  /**
   * 文档顶层材料声明（TT-05a 域①，§5.2.1 引用式布局）：解析抽取副本。可选且
   * 禁止 z.default()——旧文档解析结果键集不变（practice 字段同款纪律，§5.8.1）；
   * 新代码读旧形态按「无材料」处理（§5.8.3 旧快照读取兼容）。
   */
  materials: z.array(materialSchema).optional(),
  /**
   * 题组叠加元数据（§5.2.4 定稿）：组不产生题行、不进 questions 平铺数组；
   * questionIds 必须是 questions 顺序的子序列（lint 校验）。缺省不注入键。
   */
  groups: z.array(unitGroupSchema).optional(),
  questions: z.array(questionSchema),
});

/** 讲义目录项：只收 H2/H3（H1 用于切分多篇讲义，H4 以下不进目录） */
export const lectureHeadingSchema = z.object({
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string().min(1),
});

/** 讲义：title + 原文 markdown（渲染时再解析）+ H2/H3 目录（T1.4 抽取）。数据库主键 UUID 在导入时生成，解析结果无 id */
export const lectureSchema = z.object({
  title: z.string().min(1),
  markdown: z.string(),
  headings: z.array(lectureHeadingSchema),
});

/** frontmatter（DSL 文档头）。dsl 为版本号，缺省 2、唯一合法值 2（v1 已移除，§10 决策 10）；kind 缺失属 lint error（MISSING_KIND）；新增字段遵守 DSL 兼容规则（只增不改、可选有默认、未知字段优雅降级） */
export const frontmatterSchema = z.object({
  kind: documentKindSchema,
  dsl: z.literal(2).default(2),
  unit: z.string().optional(),
  /**
   * 讲义显示名与导入键（内容模型与导入规范化方案 §2/§3）：
   * 仅单讲义文件生效，缺省取第一个 H1；多讲义文件逐篇用各自 H1（此时声明 title 会被 lint warning 提示忽略）。
   */
  title: z.string().optional(),
  lecture: z.string().optional(),
  topic: z.string().optional(),
  /** 教学包声明（T7.8 / 方案 §4.6，可选命名空间）：依赖声明非能力定义，无该字段即普通 MD */
  teachingPack: teachingPackSchema.optional(),
  /**
   * 练习推荐（M5-D1，可选命名空间）：做题方式与反馈节奏的展示/反馈推荐，
   * 仅 practice/mixed 单元生效（lecture/lesson 带 practice 由 lint warning 提示）。
   * 可选且禁止 z.default()——老 frontmatter 解析结果键集不变。
   */
  practice: practiceRecommendationSchema.optional(),
});

/** linter 输出的单个问题（§5.1）：line/column 均从 1 起；fix 为可选的修正建议文本 */
export const lintIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  fix: z.string().optional(),
});

/**
 * 解析结果（T1.3/T1.4/T1.6 各解析器的统一产出）：
 * - 解析函数是纯函数、不抛异常：结构性错误（缺 frontmatter、未知题型等）记入 issues，frontmatter 允许缺省；
 * - practice：units 各含 questions；lecture：lectures 多篇（按 H1 切分）；mixed：两者兼有并经 lectureTitle 关联。
 */
export const parsedDocumentSchema = z.object({
  frontmatter: frontmatterSchema.optional(),
  lectures: z.array(lectureSchema).default([]),
  units: z.array(unitSchema).default([]),
  issues: z.array(lintIssueSchema).default([]),
});

export type QuestionType = z.infer<typeof questionTypeSchema>;
export type DocumentKind = z.infer<typeof documentKindSchema>;
export type QuestionOption = z.infer<typeof optionSchema>;
export type QuestionAnswers = z.infer<typeof questionAnswersSchema>;
export type Question = z.infer<typeof questionSchema>;
export type QuestionPublic = z.infer<typeof questionPublicSchema>;
export type Unit = z.infer<typeof unitSchema>;
export type LectureHeading = z.infer<typeof lectureHeadingSchema>;
export type Lecture = z.infer<typeof lectureSchema>;
export type DocumentFrontmatter = z.infer<typeof frontmatterSchema>;
export type LintIssue = z.infer<typeof lintIssueSchema>;
export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;
