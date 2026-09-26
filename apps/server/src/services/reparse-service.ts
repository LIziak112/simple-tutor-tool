import type { Question } from "@tutor/contract";
import {
  LECTURE_PREFIX_LINES,
  parseDocument,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { Lecture, Question as QuestionRow } from "../db/schema.ts";
import {
  knowledgePoints,
  lectures,
  questionKnowledge,
  questions,
} from "../db/schema.ts";
import {
  loadKnowledgeIdByName,
  questionFields,
  syncQuestionKnowledge,
} from "./question-sync.ts";

/**
 * reparse 服务（T1.14，§5.1.1(4)「原文是真相」）：用当前解析器从
 * questions.sourceMd / lectures.markdown 重新抽取结构化字段，题目 id 不变，
 * 历史作答不受影响。解析器/判分升级涉及结构化字段后由 `pnpm reparse` 调用。
 *
 * 语义（与 T1.12 单题编辑同一解析语境）：
 * - 题目：sourceMd 经 wrapSingleQuestionMd（unitId=所属单元、questionStartNumber=
 *   order+1）→ parseDocument → 取解析出的该题，与库中结构化字段逐项比较
 *   （type/difficulty/stemMd/options/answers/hints/solutionMd/knowledge）；
 *   解析失败 / 0 题 / 多题 / id 不一致 → 不修改该题，记入报告「跳过」列表（绝不丢数据）；
 * - 讲义：markdown 重解析只重取 title（其他列都是原文本身），title 变化才更新；
 * - version 策略：有实质字段变化的题目 version+1，无变化不动；讲义只更新 title/updatedAt；
 * - 考点归一复用 question-sync（同名复用 + 关联全量替换），与导入/单题编辑同源；
 * - dryRun：只分析输出变更摘要，不写库。
 *
 * 本模块为纯服务函数（可测），CLI（apps/server/scripts/reparse.ts）只是壳 + 打印。
 */

/** 单个字段的变更记录（from/to 为截断后的展示文本） */
export interface ReparseFieldChange {
  /** 字段名（type/difficulty/stemMd/options/answers/hints/solutionMd/knowledge/title） */
  readonly field: string;
  /** 旧值（展示文本，长值截断） */
  readonly from: string;
  /** 新值（展示文本，长值截断） */
  readonly to: string;
}

/** 单题的 reparse 结果 */
export interface ReparseQuestionResult {
  readonly id: string;
  readonly status: "updated" | "unchanged" | "skipped";
  /** 跳过原因（中文；仅 status=skipped 时存在） */
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
}

/** 单篇讲义的 reparse 结果 */
export interface ReparseLectureResult {
  readonly id: string;
  /** 当前（重取后的）讲义标题——跳过时为库中原值 */
  readonly title: string;
  readonly status: "updated" | "unchanged" | "skipped";
  /** 跳过原因（中文；仅 status=skipped 时存在） */
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
}

/** reparse 全量报告 */
export interface ReparseReport {
  /** 本次是否为 --dry-run（只输出不写库） */
  readonly dryRun: boolean;
  readonly questions: readonly ReparseQuestionResult[];
  readonly lectures: readonly ReparseLectureResult[];
}

/** reparse 选项 */
export interface ReparseOptions {
  /** true = 只分析输出变更摘要，不写库 */
  readonly dryRun: boolean;
}

// ---------- 展示与比较辅助 ----------

/** 变更摘要里单个值的最大展示长度（超过截断，避免长题干刷屏） */
const MAX_VALUE_DISPLAY_LENGTH = 60;

/** 把值格式化为展示文本：JSON 形态、null/undefined 显示（空）、超长截断 */
function displayValue(value: unknown): string {
  const text =
    value === null || value === undefined ? "（空）" : JSON.stringify(value);
  return text.length > MAX_VALUE_DISPLAY_LENGTH
    ? `${text.slice(0, MAX_VALUE_DISPLAY_LENGTH)}…（共 ${text.length} 字符）`
    : text;
}

/** 安全解析库中 JSON 列：损坏（不应发生）时返回原始文本，比较必然不等、触发修复 */
function parseJsonColumn(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 键序无关的深比较（数组保序、对象按键集合递归；NaN 不涉及，数据均来自 JSON 域） */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]),
    );
  }
  return false;
}

/** unknown → Record<string, unknown> 的类型守卫 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------- 题目重解析 ----------

/** 题目分析产物：报告字段 + 写库所需的解析结果（updated 时才有） */
interface QuestionPlan {
  readonly id: string;
  readonly status: "updated" | "unchanged" | "skipped";
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
  readonly parsedQuestion?: Question;
}

/**
 * 解析单题 sourceMd 并与库中行比较，产出更新计划（纯读，不写库）。
 * currentKnowledge 传库中该题关联的考点名列表。
 */
function planQuestion(
  row: QuestionRow,
  currentKnowledge: readonly string[],
): QuestionPlan {
  const wrapped = wrapSingleQuestionMd(row.unitId, row.sourceMd);
  const parsed = parseDocument(wrapped, {
    unitId: row.unitId,
    questionStartNumber: row.order + 1,
  });

  // 解析失败（结构性 error，如被篡改的 sourceMd）：跳过，绝不丢数据
  const errorIssue = parsed.issues.find((issue) => issue.level === "error");
  if (errorIssue !== undefined) {
    const line = Math.max(
      1,
      shiftLintIssuesToFragment([errorIssue], SINGLE_QUESTION_PREFIX_LINES)[0]
        ?.line ?? 1,
    );
    return {
      id: row.id,
      status: "skipped",
      reason: `sourceMd 按当前解析规则存在 error（第 ${line} 行：${errorIssue.message}），保持原样未修改`,
      changes: [],
    };
  }

  const parsedQuestions = parsed.units.flatMap((unit) => unit.questions);
  if (parsedQuestions.length === 0) {
    return {
      id: row.id,
      status: "skipped",
      reason: "未解析出任何题目（sourceMd 可能已损坏），保持原样未修改",
      changes: [],
    };
  }
  if (parsedQuestions.length > 1) {
    return {
      id: row.id,
      status: "skipped",
      reason: `解析出 ${parsedQuestions.length} 道题目（单题 sourceMd 应只含 1 道），保持原样未修改`,
      changes: [],
    };
  }
  const next = parsedQuestions[0];
  if (next === undefined) {
    return {
      id: row.id,
      status: "skipped",
      reason: "未解析出任何题目（sourceMd 可能已损坏），保持原样未修改",
      changes: [],
    };
  }
  if (next.id !== row.id) {
    return {
      id: row.id,
      status: "skipped",
      reason: `解析出的题目 id「${next.id}」与库中 id「${row.id}」不一致，保持原样未修改`,
      changes: [],
    };
  }

  // 结构化字段逐项比较（fromText/toText 为展示值：number 不带引号、字符串按
  // JSON 形态带引号；fromValue/toValue 为比较值，键序无关深比较）
  const nextOptions = next.options ?? null;
  const nextAnswers = next.answers ?? null;
  const nextSolution = next.solutionMd ?? null;
  const comparisons: ReadonlyArray<{
    readonly field: string;
    readonly fromValue: unknown;
    readonly toValue: unknown;
    readonly fromText: unknown;
    readonly toText: unknown;
  }> = [
    {
      field: "type",
      fromValue: row.type,
      toValue: next.type,
      fromText: row.type,
      toText: next.type,
    },
    {
      field: "difficulty",
      fromValue: row.difficulty,
      toValue: next.difficulty,
      fromText: row.difficulty,
      toText: next.difficulty,
    },
    {
      field: "stemMd",
      fromValue: row.stemMd,
      toValue: next.stemMd,
      fromText: row.stemMd,
      toText: next.stemMd,
    },
    {
      field: "options",
      fromValue: parseJsonColumn(row.optionsJson),
      toValue: nextOptions,
      fromText: row.optionsJson ?? "（空）",
      toText: nextOptions === null ? "（空）" : JSON.stringify(nextOptions),
    },
    {
      field: "answers",
      fromValue: parseJsonColumn(row.answersJson),
      toValue: nextAnswers,
      fromText: row.answersJson ?? "（空）",
      toText: nextAnswers === null ? "（空）" : JSON.stringify(nextAnswers),
    },
    {
      field: "hints",
      fromValue: parseJsonColumn(row.hintsJson),
      toValue: next.hints,
      fromText: row.hintsJson,
      toText: JSON.stringify(next.hints),
    },
    {
      field: "solutionMd",
      fromValue: row.solutionMd,
      toValue: nextSolution,
      fromText: row.solutionMd ?? "（空）",
      toText: nextSolution ?? "（空）",
    },
    {
      field: "knowledge",
      // 排序后比较：关联顺序不构成实质变更（判分与统计只看集合）
      fromValue: [...currentKnowledge].sort(),
      toValue: [...next.knowledge].sort(),
      fromText: JSON.stringify(currentKnowledge),
      toText: JSON.stringify(next.knowledge),
    },
  ];

  const changes = comparisons
    .filter((c) => !jsonEquals(c.fromValue, c.toValue))
    .map((c) => ({
      field: c.field,
      from: displayValue(c.fromText),
      to: displayValue(c.toText),
    }));

  if (changes.length === 0) {
    return { id: row.id, status: "unchanged", changes };
  }
  return {
    id: row.id,
    status: "updated",
    changes,
    parsedQuestion: next,
  };
}

// ---------- 讲义重解析 ----------

/** 讲义分析产物 */
interface LecturePlan {
  readonly id: string;
  readonly title: string;
  readonly status: "updated" | "unchanged" | "skipped";
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
}

/** 解析单篇讲义 markdown 重取 title，与库中行比较（纯读，不写库） */
function planLecture(row: Lecture): LecturePlan {
  const wrapped = wrapLectureMd(row.markdown);
  const parsed = parseDocument(wrapped);

  const errorIssue = parsed.issues.find((issue) => issue.level === "error");
  if (errorIssue !== undefined) {
    const line = Math.max(
      1,
      shiftLintIssuesToFragment([errorIssue], LECTURE_PREFIX_LINES)[0]?.line ??
        1,
    );
    return {
      id: row.id,
      title: row.title,
      status: "skipped",
      reason: `markdown 按当前解析规则存在 error（第 ${line} 行：${errorIssue.message}），保持原样未修改`,
      changes: [],
    };
  }
  if (parsed.lectures.length !== 1) {
    return {
      id: row.id,
      title: row.title,
      status: "skipped",
      reason: `重解析得到 ${parsed.lectures.length} 篇讲义（单篇 markdown 应只含 1 个 H1），保持原样未修改`,
      changes: [],
    };
  }
  const nextTitle = parsed.lectures[0]?.title;
  if (nextTitle === undefined) {
    return {
      id: row.id,
      title: row.title,
      status: "skipped",
      reason: "未能从 markdown 的 H1 重取讲义标题，保持原样未修改",
      changes: [],
    };
  }
  if (nextTitle === row.title) {
    return { id: row.id, title: row.title, status: "unchanged", changes: [] };
  }
  return {
    id: row.id,
    title: nextTitle,
    status: "updated",
    changes: [
      {
        field: "title",
        from: displayValue(row.title),
        to: displayValue(nextTitle),
      },
    ],
  };
}

// ---------- 全量 reparse ----------

/** 全量重解析：分析全部未软删题目与全部讲义；dryRun=false 时单事务写入全部更新 */
export function reparseAll(db: Db, options: ReparseOptions): ReparseReport {
  // 分析阶段（纯读）：题目按 id 排序保证报告输出稳定
  const questionRows = db
    .select()
    .from(questions)
    .where(isNull(questions.deletedAt))
    .orderBy(asc(questions.id))
    .all();
  const lectureRows = db
    .select()
    .from(lectures)
    .orderBy(asc(lectures.id))
    .all();

  // 考点关联一次读全（与 getContentTree 同一模式），按题分组
  const knowledgeByQuestion = new Map<string, string[]>();
  for (const row of db
    .select({
      questionId: questionKnowledge.questionId,
      name: knowledgePoints.name,
    })
    .from(questionKnowledge)
    .innerJoin(
      knowledgePoints,
      eq(questionKnowledge.knowledgePointId, knowledgePoints.id),
    )
    .orderBy(asc(knowledgePoints.name))
    .all()) {
    const list = knowledgeByQuestion.get(row.questionId);
    if (list === undefined) {
      knowledgeByQuestion.set(row.questionId, [row.name]);
    } else {
      list.push(row.name);
    }
  }

  const questionPlans = questionRows.map((row) =>
    planQuestion(row, knowledgeByQuestion.get(row.id) ?? []),
  );
  const lecturePlans = lectureRows.map((row) => planLecture(row));

  // 写入阶段：全部更新放进单个事务（要么全部生效、要么全部回滚）
  if (!options.dryRun) {
    db.transaction((tx) => {
      const now = new Date().toISOString();
      const knowledgeIdByName = loadKnowledgeIdByName(tx);
      for (const [index, plan] of questionPlans.entries()) {
        if (plan.status !== "updated" || plan.parsedQuestion === undefined) {
          continue;
        }
        const row = questionRows[index];
        if (row === undefined) continue; // 防御：plans 与 rows 一一对应
        tx.update(questions)
          .set({
            ...questionFields(plan.parsedQuestion, row.unitId, row.order, now),
            version: row.version + 1,
          })
          .where(eq(questions.id, row.id))
          .run();
        syncQuestionKnowledge(tx, plan.parsedQuestion, knowledgeIdByName);
      }
      for (const plan of lecturePlans) {
        if (plan.status !== "updated") continue;
        tx.update(lectures)
          .set({ title: plan.title, updatedAt: now })
          .where(eq(lectures.id, plan.id))
          .run();
      }
    });
  }

  return {
    dryRun: options.dryRun,
    questions: questionPlans.map((plan) => ({
      id: plan.id,
      status: plan.status,
      ...(plan.status === "skipped" ? { reason: plan.reason } : {}),
      changes: plan.changes,
    })),
    lectures: lecturePlans.map((plan) => ({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      ...(plan.status === "skipped" ? { reason: plan.reason } : {}),
      changes: plan.changes,
    })),
  };
}

// ---------- 变更摘要渲染 ----------

/** 状态计数（题目/讲义通用） */
function countStatus<T extends { status: "updated" | "unchanged" | "skipped" }>(
  results: readonly T[],
): { total: number; updated: number; unchanged: number; skipped: number } {
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "updated") updated += 1;
    else if (r.status === "unchanged") unchanged += 1;
    else skipped += 1;
  }
  return { total: results.length, updated, unchanged, skipped };
}

/** 把报告渲染为中文变更摘要（CLI 直接打印；updated 与 skipped 逐行列出明细） */
export function renderReparseReport(report: ReparseReport): string {
  const q = countStatus(report.questions);
  const l = countStatus(report.lectures);
  const lines: string[] = [
    report.dryRun
      ? "reparse 变更摘要（--dry-run 预览：未写入数据库）"
      : "reparse 变更摘要（已写入数据库）",
    `题目：检查 ${q.total} 题，更新 ${q.updated} 题，无变化 ${q.unchanged} 题，跳过 ${q.skipped} 题`,
    `讲义：检查 ${l.total} 篇，更新 ${l.updated} 篇，无变化 ${l.unchanged} 篇，跳过 ${l.skipped} 篇`,
  ];

  for (const r of report.questions) {
    if (r.status === "unchanged") continue;
    if (r.status === "updated") {
      lines.push(`[题目·更新] ${r.id}（version +1）`);
      for (const change of r.changes) {
        lines.push(`  - ${change.field}: ${change.from} → ${change.to}`);
      }
    } else {
      lines.push(`[题目·跳过] ${r.id}：${r.reason ?? ""}`);
    }
  }
  for (const r of report.lectures) {
    if (r.status === "unchanged") continue;
    if (r.status === "updated") {
      lines.push(`[讲义·更新] ${r.id}「${r.title}」`);
      for (const change of r.changes) {
        lines.push(`  - ${change.field}: ${change.from} → ${change.to}`);
      }
    } else {
      lines.push(`[讲义·跳过] ${r.id}「${r.title}」：${r.reason ?? ""}`);
    }
  }
  return lines.join("\n");
}
