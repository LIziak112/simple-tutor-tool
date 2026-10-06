import type {
  QuestionAnswers,
  QuestionType,
  StudentAnswer,
} from "@tutor/contract";
import { QUESTION_TYPE_LABELS as QUESTION_TYPE_LABELS_CONTRACT } from "@tutor/contract";

/**
 * 作答展示的纯函数集（T2.6 答题页/结果视图共用）：
 * 题型中文徽章、选项字母、是否已作答、本人答案与参考答案的文本化。
 * 纯函数无 IO，单测覆盖（answer-format.test.ts）。
 */

/** 题型 → 中文标签（题卡徽章与结果视图共用；T3.4 起常量收归契约，前后端同一份） */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> =
  QUESTION_TYPE_LABELS_CONTRACT;

/**
 * 手写题型集合（T6R.11 起收归本共享模块）：作答 ink 走 HandwrittenControls，
 * 不接草稿层/草稿原稿查看（原查看 AttemptQuestionCard 的本地副本——教师端
 * 详情/待批卡同样需要该判定，单一事实来源）。
 */
export const HANDWRITTEN_TYPES: ReadonlySet<QuestionType> =
  new Set<QuestionType>(["solve", "apply", "find-error"]);

/** 题型徽章配色（按客观/主观两档区分，视觉分组） */
export const QUESTION_TYPE_BADGE_CLASS: Record<QuestionType, string> = {
  judge: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  choice: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  multi: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  fill: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  solve:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  apply:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  "find-error":
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
};

/** 选项下标 → 字母（0→A、1→B…；与 DSL「字母按顺序自动编为 A/B/C/D」一致） */
export function letterOf(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/**
 * 判断题答案的展示文本：布尔 → 对/错；字符串写法（旧版 √/F 等）原样展示。
 */
export function judgeLabelOf(value: boolean | string): string {
  if (typeof value === "boolean") return value ? "对" : "错";
  return value;
}

/**
 * 作答轮次标注（T6R.11 原稿查看面板共用）：课程练习/错题重练带次数
 * （重练同题后回看历史可分辨第几轮），作业为本次。学生结果视图与教师
 * 详情/待批卡同口径。
 */
export function attemptRoundLabel(
  sourceType: "course" | "assignment" | "wrong",
  attemptNo: number,
): string {
  if (sourceType === "course") return `第 ${attemptNo} 次课程练习`;
  if (sourceType === "wrong") return `第 ${attemptNo} 次错题重练`;
  return "本次作业";
}

/**
 * 该题是否算「已作答」（底栏「已答 n/m」与交卷确认的未答数共用口径）：
 * - judge/choice：有答案对象即已答；
 * - multi：至少选一项；
 * - fill：至少一空非空；
 * - final（手写题最终答案）：非空。
 */
export function isAnswered(answer: StudentAnswer | undefined): boolean {
  if (answer === undefined) return false;
  switch (answer.kind) {
    case "judge":
    case "choice":
      return true;
    case "multi":
      return answer.indexes.length > 0;
    case "fill":
      return answer.values.some((value) => value.trim() !== "");
    case "final":
      return answer.finalAnswer.trim() !== "";
  }
}

/** 本人答案 → 展示文本（结果视图「你的答案」行；null=未作答） */
export function formatStudentAnswer(answer: StudentAnswer | null): string {
  if (answer === null) return "未作答";
  switch (answer.kind) {
    case "judge":
      return judgeLabelOf(answer.value);
    case "choice":
      return letterOf(answer.index);
    case "multi":
      return [...answer.indexes]
        .sort((a, b) => a - b)
        .map(letterOf)
        .join("");
    case "fill":
      return answer.values
        .map((v) => (v.trim() === "" ? "（空）" : v))
        .join("；");
    case "final":
      return answer.finalAnswer.trim() === "" ? "（空）" : answer.finalAnswer;
  }
}

/** LaTeX 命令形态（\frac、\pm、\sqrt 等；显示侧判断答案是否要走公式管线） */
const LATEX_COMMAND_RE = /\\[a-zA-Z]+/;

/**
 * 参考答案的显示侧 LaTeX 启发式包裹：
 * [[答案|等价…]] 标记内禁止写 $（remark-math 会切开标记导致答案泄露学生端，
 * 写侧由 lint 拦截），因此答案常存为裸 LaTeX（如 -\frac{5}{4}）——显示侧
 * 检测到 LaTeX 命令形态时整段包 $…$，交给 RichMarkdown 的 remark-math→KaTeX
 * 管线渲染；不含命令的普通写法（-5/4）原样返回。
 * 已含 $ 的文本（T2.13 旧写法 $…$）不二次包裹，避免拆错既有定界符。
 */
export function mathifyAnswerText(text: string): string {
  if (!LATEX_COMMAND_RE.test(text)) return text;
  if (text.includes("$")) return text;
  return `$${text}$`;
}

/**
 * 参考答案 → 展示文本（结果视图「参考答案」行；填空的等价答案用「或」连接）。
 * fill 逐个等价答案、final 整段套用 mathifyAnswerText：裸 LaTeX 显示侧包 $
 * 走公式管线（四个消费方——结果页/错题本/教师批改详情/待批队列——共用本函数，
 * 均以 RichMarkdown 渲染）。
 */
export function formatReferenceAnswers(answers: QuestionAnswers): string {
  switch (answers.kind) {
    case "judge":
      return answers.value ? "对" : "错";
    case "choice":
      return letterOf(answers.index);
    case "multi":
      return [...answers.indexes]
        .sort((a, b) => a - b)
        .map(letterOf)
        .join("");
    case "fill":
      return answers.blanks
        .map((b) => b.map(mathifyAnswerText).join(" 或 "))
        .join("；");
    case "final":
      return mathifyAnswerText(answers.answer);
  }
}

/** 多空填充：把 values 扩到至少 length 长（缺项补空串），并写入第 index 项 */
export function withBlankValue(
  values: readonly string[],
  index: number,
  value: string,
): string[] {
  const next = Array.from(
    { length: Math.max(values.length, index + 1) },
    (_, k) => values[k] ?? "",
  );
  next[index] = value;
  return next;
}
