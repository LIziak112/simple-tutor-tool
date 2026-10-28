import type { Material, Question, QuestionGroup } from "@tutor/contract";
import {
  LECTURE_PREFIX_LINES,
  lintDocument,
  parseDocument,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type {
  Lecture,
  MaterialRow,
  QuestionGroupRow,
  Question as QuestionRow,
} from "../db/schema.ts";
import {
  knowledgePoints,
  lectures,
  materials,
  questionGroups,
  questionKnowledge,
  questions,
} from "../db/schema.ts";
import { liveMaterialIdsOf, resolveQmImportIssues } from "./import-qm.ts";
import {
  replaceQuestionMaterialRefsWithin,
  saveMaterialWithin,
  saveQuestionGroupWithin,
} from "./material-repository.ts";
import { assembleUnitDoc } from "./qm-edit-service.ts";
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
 *   （type/difficulty/stemMd/options/answers/hints/solutionMd/knowledge，
 *   tt-06b 起含 materialRefs）；解析失败 / 0 题 / 多题 / id 不一致 → 不修改该题，
 *   记入报告「跳过」列表（绝不丢数据）。题级 ::ref{material=} 的教师域解析降级
 *   与导入同口径（库内既有材料不报错；材料缺失 → 跳过并明确要求原文件重导，
 *   不从相邻文本猜测恢复）；
 * - 讲义：markdown 重解析只重取 title（其他列都是原文本身），title 变化才更新；
 * - 材料/题组（tt-06b / QM-05）：按教师域逐单元重建文档（assembleUnitDoc——
 *   与编辑/导出同一拼装口径）重新抽取 anchors/slots/mediaPaths/引用索引/
 *   成员索引；引用解析失败（含材料缺失）→ 该单元材料/组整体跳过并记原因；
 * - version 策略：有实质字段变化的题目 version+1，无变化不动；讲义只更新
 *   title/updatedAt；材料/组 sourceMd 不变 → version 不动（抽取副本刷新）；
 * - 考点归一复用 question-sync（同名复用 + 关联全量替换），与导入/单题编辑同源；
 * - 历史作答快照（attempt_context_snapshots）不受 reparse 影响（只动实体行）；
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
  /** tt-06b / QM-05：材料/题组重解析结果（仅含有 QM 实体的单元） */
  readonly materials: readonly ReparseQmEntityResult[];
  readonly groups: readonly ReparseQmEntityResult[];
}

/** 单个材料/题组的 reparse 结果（tt-06b / QM-05；形态同题目结果） */
export interface ReparseQmEntityResult {
  readonly id: string;
  readonly status: "updated" | "unchanged" | "skipped";
  /** 跳过原因（中文；仅 status=skipped 时存在） */
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
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
 * currentKnowledge 传库中该题关联的考点名列表；resolvableMaterialIds 传教师域
 * 存活材料 id 集（tt-06b：题级 ::ref{material=} 的教师域解析降级，与导入同口径）。
 */
function planQuestion(
  row: QuestionRow,
  currentKnowledge: readonly string[],
  resolvableMaterialIds?: ReadonlySet<string>,
): QuestionPlan {
  const wrapped = wrapSingleQuestionMd(row.unitId, row.sourceMd);
  const parsed = parseDocument(wrapped, {
    unitId: row.unitId,
    questionStartNumber: row.order + 1,
  });
  // 教师域解析降级：库内既有材料的题级引用不构成 error（缺省不过滤）
  const issues =
    resolvableMaterialIds === undefined
      ? parsed.issues
      : resolveQmImportIssues(parsed.issues, parsed, resolvableMaterialIds);

  // 解析失败（结构性 error，如被篡改的 sourceMd）：跳过，绝不丢数据。
  // 材料缺失的题级引用单独给出「原文件重导」指引——不从相邻文本猜测恢复
  const errorIssue = issues.find((issue) => issue.level === "error");
  if (errorIssue !== undefined) {
    const line = Math.max(
      1,
      shiftLintIssuesToFragment([errorIssue], SINGLE_QUESTION_PREFIX_LINES)[0]
        ?.line ?? 1,
    );
    const reason =
      errorIssue.code === "UNKNOWN_MATERIAL_REF"
        ? `题目引用的材料不在库中（第 ${line} 行：${errorIssue.message}）：题外材料已丢失，请用原文件重新导入恢复；reparse 不从相邻文本猜测恢复，保持原样未修改`
        : `sourceMd 按当前解析规则存在 error（第 ${line} 行：${errorIssue.message}），保持原样未修改`;
    return {
      id: row.id,
      status: "skipped",
      reason,
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
    // tt-06b / QM-05：题级材料引用（materialRefsJson 抽取副本；null 与 [] 同义
    // ——无引用的旧列 NULL 不构成实质变更）
    {
      field: "materialRefs",
      fromValue: parseJsonColumn(row.materialRefsJson) ?? [],
      toValue: next.materialRefs ?? [],
      fromText: row.materialRefsJson ?? "（空）",
      toText: JSON.stringify(next.materialRefs ?? []),
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
  // 2026-10 讲练一体：按存储的 kind 包装——lesson 讲义正文含题块（注入 id），
  // 按 lecture 语境会被 QUESTION_IN_LECTURE error 误跳过（重解析链路失效）
  const wrapped = wrapLectureMd(row.markdown, row.kind);
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

// ---------- 材料/题组重解析（tt-06b / QM-05） ----------

/** 材料分析产物：报告字段 + 写库所需的解析实体（updated 时才有） */
interface MaterialPlan {
  readonly id: string;
  readonly status: "updated" | "unchanged" | "skipped";
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
  readonly parsedMaterial?: Material;
  readonly row: MaterialRow;
  readonly order: number;
}

/** 题组分析产物 */
interface GroupPlan {
  readonly id: string;
  readonly status: "updated" | "unchanged" | "skipped";
  readonly reason?: string;
  readonly changes: readonly ReparseFieldChange[];
  readonly parsedGroup?: QuestionGroup;
  readonly row: QuestionGroupRow;
  readonly order: number;
}

/** 单元的 QM 重解析计划（材料计划 + 组计划；单元无 QM 实体时为 null） */
interface QmUnitPlan {
  readonly unitId: string;
  readonly materialPlans: readonly MaterialPlan[];
  readonly groupPlans: readonly GroupPlan[];
}

/**
 * 逐单元重建文档重新抽取材料/组（纯读，不写库）。拼装用 assembleUnitDoc
 * （与编辑/导出同一规范序：材料 → 组 → 题目），引用解析做教师域降级
 * （与导入同口径）。引用解析失败（含题外材料缺失）→ 该单元材料/组整体
 * 跳过并记「原文件重导」原因——不从相邻文本猜测恢复。
 */
function planQmUnit(
  db: Db,
  teacherId: string,
  unitId: string,
  liveMaterialIds: ReadonlySet<string>,
): QmUnitPlan | null {
  const materialRows = db
    .select()
    .from(materials)
    .where(
      and(
        eq(materials.teacherId, teacherId),
        eq(materials.unitId, unitId),
        isNull(materials.deletedAt),
      ),
    )
    .orderBy(asc(materials.order), asc(materials.id))
    .all();
  const groupRows = db
    .select()
    .from(questionGroups)
    .where(
      and(
        eq(questionGroups.teacherId, teacherId),
        eq(questionGroups.unitId, unitId),
        isNull(questionGroups.deletedAt),
      ),
    )
    .orderBy(asc(questionGroups.order), asc(questionGroups.id))
    .all();
  if (materialRows.length === 0 && groupRows.length === 0) return null;
  const questionBlocks = db
    .select({ sourceMd: questions.sourceMd })
    .from(questions)
    .where(
      and(
        eq(questions.teacherId, teacherId),
        eq(questions.unitId, unitId),
        isNull(questions.deletedAt),
      ),
    )
    .orderBy(asc(questions.order), asc(questions.id))
    .all()
    .map((row) => row.sourceMd);

  const markdown = assembleUnitDoc(unitId, {
    materials: materialRows.map((row) => row.sourceMd),
    groups: groupRows.map((row) => row.sourceMd),
    questions: questionBlocks,
  });
  const { issues, parsed } = lintDocument(markdown);
  const resolved = resolveQmImportIssues(issues, parsed, liveMaterialIds);
  const firstError = resolved.find((issue) => issue.level === "error");
  const skipAll = (reason: string): QmUnitPlan => ({
    unitId,
    materialPlans: materialRows.map((row) => ({
      id: row.id,
      status: "skipped" as const,
      reason,
      changes: [],
      row,
      order: row.order,
    })),
    groupPlans: groupRows.map((row) => ({
      id: row.id,
      status: "skipped" as const,
      reason,
      changes: [],
      row,
      order: row.order,
    })),
  });
  if (firstError !== undefined) {
    return skipAll(
      `单元文档重建后存在 error 级问题（第 ${firstError.line} 行：${firstError.message}）${
        firstError.code === "UNKNOWN_MATERIAL_REF"
          ? "：题外材料已丢失，请用原文件重新导入恢复，reparse 不从相邻文本猜测恢复"
          : ""
      }，本单元材料/题组保持原样未修改`,
    );
  }

  const parsedMaterials = new Map(
    (parsed.materials ?? []).map((m) => [m.id, m] as const),
  );
  const parsedGroups = new Map(
    (parsed.groups ?? []).map((g) => [g.id, g] as const),
  );

  const materialPlans: MaterialPlan[] = materialRows.map((row) => {
    const next = parsedMaterials.get(row.id);
    if (next === undefined) {
      return {
        id: row.id,
        status: "skipped",
        reason:
          "sourceMd 在单元重建文档中解析不出该材料（id 不一致或容器损坏），保持原样未修改",
        changes: [],
        row,
        order: row.order,
      };
    }
    const comparisons: ReadonlyArray<{
      field: string;
      fromValue: unknown;
      toValue: unknown;
      fromText: unknown;
      toText: unknown;
    }> = [
      {
        field: "title",
        fromValue: row.title,
        toValue: next.title ?? null,
        fromText: row.title,
        toText: next.title ?? null,
      },
      {
        field: "contentMd",
        fromValue: row.contentMd,
        toValue: next.contentMd,
        fromText: row.contentMd,
        toText: next.contentMd,
      },
      {
        field: "anchors",
        fromValue: parseJsonColumn(row.anchorsJson),
        toValue: next.anchors,
        fromText: row.anchorsJson,
        toText: JSON.stringify(next.anchors),
      },
      {
        field: "slots",
        fromValue: parseJsonColumn(row.slotsJson),
        toValue: next.slots,
        fromText: row.slotsJson,
        toText: JSON.stringify(next.slots),
      },
      {
        field: "mediaPaths",
        fromValue: parseJsonColumn(row.mediaPathsJson),
        toValue: next.mediaPaths,
        fromText: row.mediaPathsJson,
        toText: JSON.stringify(next.mediaPaths),
      },
    ];
    const changes = comparisons
      .filter((c) => !jsonEquals(c.fromValue, c.toValue))
      .map((c) => ({
        field: c.field,
        from: displayValue(c.fromText),
        to: displayValue(c.toText),
      }));
    return changes.length === 0
      ? { id: row.id, status: "unchanged", changes, row, order: row.order }
      : {
          id: row.id,
          status: "updated",
          changes,
          parsedMaterial: next,
          row,
          // P2-3 记账：只刷新抽取副本——updated 也保持行内 order（写库侧同传
          // row.order），不重写成连续序（0,1,5 不变 0,1,2）
          order: row.order,
        };
  });

  const groupPlans: GroupPlan[] = groupRows.map((row) => {
    const next = parsedGroups.get(row.id);
    if (next === undefined) {
      return {
        id: row.id,
        status: "skipped",
        reason:
          "sourceMd 在单元重建文档中解析不出该题组（id 不一致或容器损坏），保持原样未修改",
        changes: [],
        row,
        order: row.order,
      };
    }
    const comparisons: ReadonlyArray<{
      field: string;
      fromValue: unknown;
      toValue: unknown;
      fromText: unknown;
      toText: unknown;
    }> = [
      {
        field: "title",
        fromValue: row.title,
        toValue: next.title ?? null,
        fromText: row.title,
        toText: next.title ?? null,
      },
      {
        field: "label",
        fromValue: row.label,
        toValue: next.label ?? null,
        fromText: row.label,
        toText: next.label ?? null,
      },
      {
        field: "introMd",
        fromValue: row.introMd,
        toValue: next.introMd,
        fromText: row.introMd,
        toText: next.introMd,
      },
      {
        field: "materialRefs",
        fromValue: parseJsonColumn(row.materialRefsJson),
        toValue: next.materialRefs,
        fromText: row.materialRefsJson,
        toText: JSON.stringify(next.materialRefs),
      },
      {
        field: "questionIds",
        fromValue: parseJsonColumn(row.questionIdsJson),
        toValue: next.questionIds,
        fromText: row.questionIdsJson,
        toText: JSON.stringify(next.questionIds),
      },
    ];
    const changes = comparisons
      .filter((c) => !jsonEquals(c.fromValue, c.toValue))
      .map((c) => ({
        field: c.field,
        from: displayValue(c.fromText),
        to: displayValue(c.toText),
      }));
    return changes.length === 0
      ? { id: row.id, status: "unchanged", changes, row, order: row.order }
      : {
          id: row.id,
          status: "updated",
          changes,
          parsedGroup: next,
          row,
          // P2-3 记账：同材料侧——updated 保持 row.order，不重排连续序
          order: row.order,
        };
  });

  return { unitId, materialPlans, groupPlans };
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

  // T2B.3：题目按归属教师分组处理（每位教师的域独立分析、独立写入）；复合主键
  // (teacherId, id) 下同 id 题目可能存在于多个域——考点关联也按域全量替换
  // （syncQuestionKnowledge 带 teacherId）。teacherId 为 NULL 的行（D9 下不应
  // 存在：迁移回填后代码恒写非空）跳过并记原因——宁可跳过不可把更新写进错误
  // 的教师域。讲义 id 为 uuid 全局唯一，无需分组。组内保持 id 排序、组间按
  // teacherId 排序，单教师下报告输出与历史完全一致。
  const rowsByTeacher = new Map<string, QuestionRow[]>();
  const orphanRows: QuestionRow[] = [];
  for (const row of questionRows) {
    if (row.teacherId === null) {
      orphanRows.push(row);
      continue;
    }
    const list = rowsByTeacher.get(row.teacherId);
    if (list === undefined) rowsByTeacher.set(row.teacherId, [row]);
    else list.push(row);
  }
  const questionPlans: QuestionPlan[] = [];
  const updateTasks: {
    plan: QuestionPlan;
    row: QuestionRow;
    teacherId: string;
  }[] = [];
  // tt-06b / QM-05：材料/题组的逐单元重解析计划（教师域独立；写入任务随分析收集）
  const materialWriteTasks: { plan: MaterialPlan; teacherId: string }[] = [];
  const groupWriteTasks: { plan: GroupPlan; teacherId: string }[] = [];
  const materialPlans: ReparseQmEntityResult[] = [];
  const groupPlans: ReparseQmEntityResult[] = [];
  for (const teacherId of [...rowsByTeacher.keys()].sort()) {
    // 教师域存活材料集（题级引用降级 + QM 单元重建共用一次查询）
    const liveMaterialIds = liveMaterialIdsOf(db, teacherId);
    for (const row of rowsByTeacher.get(teacherId) ?? []) {
      const plan = planQuestion(
        row,
        knowledgeByQuestion.get(row.id) ?? [],
        liveMaterialIds,
      );
      questionPlans.push(plan);
      updateTasks.push({ plan, row, teacherId });
    }
    // 该教师域内有 QM 实体的单元逐个重建分析
    const qmUnitIds = new Set<string>();
    for (const row of db
      .select({ unitId: materials.unitId })
      .from(materials)
      .where(
        and(eq(materials.teacherId, teacherId), isNull(materials.deletedAt)),
      )
      .all()) {
      qmUnitIds.add(row.unitId);
    }
    for (const row of db
      .select({ unitId: questionGroups.unitId })
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          isNull(questionGroups.deletedAt),
        ),
      )
      .all()) {
      qmUnitIds.add(row.unitId);
    }
    for (const unitId of [...qmUnitIds].sort()) {
      const plan = planQmUnit(db, teacherId, unitId, liveMaterialIds);
      if (plan === null) continue;
      for (const materialPlan of plan.materialPlans) {
        materialPlans.push({
          id: materialPlan.id,
          status: materialPlan.status,
          ...(materialPlan.status === "skipped"
            ? { reason: materialPlan.reason }
            : {}),
          changes: materialPlan.changes,
        });
        if (materialPlan.status === "updated") {
          materialWriteTasks.push({ plan: materialPlan, teacherId });
        }
      }
      for (const groupPlan of plan.groupPlans) {
        groupPlans.push({
          id: groupPlan.id,
          status: groupPlan.status,
          ...(groupPlan.status === "skipped"
            ? { reason: groupPlan.reason }
            : {}),
          changes: groupPlan.changes,
        });
        if (groupPlan.status === "updated") {
          groupWriteTasks.push({ plan: groupPlan, teacherId });
        }
      }
    }
  }
  for (const row of orphanRows) {
    questionPlans.push({
      id: row.id,
      status: "skipped",
      reason:
        "行缺少归属教师（teacherId 为空，正常库不应发生），保持原样未修改",
      changes: [],
    });
  }
  const lecturePlans = lectureRows.map((row) => planLecture(row));

  // 写入阶段：全部更新放进单个事务（要么全部生效、要么全部回滚）。历史作答
  // 快照（attempt_context_snapshots）不在写入面——reparse 只动实体行
  if (!options.dryRun) {
    db.transaction((tx) => {
      const now = new Date().toISOString();
      const knowledgeIdByName = loadKnowledgeIdByName(tx);
      for (const task of updateTasks) {
        if (
          task.plan.status !== "updated" ||
          task.plan.parsedQuestion === undefined
        ) {
          continue;
        }
        tx.update(questions)
          .set({
            ...questionFields(
              task.plan.parsedQuestion,
              task.row.unitId,
              task.row.order,
              now,
            ),
            version: task.row.version + 1,
          })
          .where(
            and(
              eq(questions.teacherId, task.teacherId),
              eq(questions.id, task.row.id),
            ),
          )
          .run();
        // tt-06b / QM-05：题级材料引用索引同事务替换（抽取副本随解析刷新）
        replaceQuestionMaterialRefsWithin(
          tx,
          task.teacherId,
          task.row.id,
          task.plan.parsedQuestion.materialRefs ?? [],
        );
        syncQuestionKnowledge(
          tx,
          task.plan.parsedQuestion,
          knowledgeIdByName,
          task.teacherId,
        );
      }
      for (const task of materialWriteTasks) {
        if (
          task.plan.status !== "updated" ||
          task.plan.parsedMaterial === undefined
        ) {
          continue;
        }
        // sourceMd 未变 → version 不动（仓储版本策略），只刷新抽取副本
        saveMaterialWithin(tx, {
          teacherId: task.teacherId,
          unitId: task.plan.row.unitId,
          material: task.plan.parsedMaterial,
          order: task.plan.row.order,
          now,
        });
      }
      for (const task of groupWriteTasks) {
        if (
          task.plan.status !== "updated" ||
          task.plan.parsedGroup === undefined
        ) {
          continue;
        }
        saveQuestionGroupWithin(tx, {
          teacherId: task.teacherId,
          unitId: task.plan.row.unitId,
          group: task.plan.parsedGroup,
          order: task.plan.row.order,
          now,
        });
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
    materials: materialPlans,
    groups: groupPlans,
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
  const m = countStatus(report.materials);
  const g = countStatus(report.groups);
  const lines: string[] = [
    report.dryRun
      ? "reparse 变更摘要（--dry-run 预览：未写入数据库）"
      : "reparse 变更摘要（已写入数据库）",
    `题目：检查 ${q.total} 题，更新 ${q.updated} 题，无变化 ${q.unchanged} 题，跳过 ${q.skipped} 题`,
    `讲义：检查 ${l.total} 篇，更新 ${l.updated} 篇，无变化 ${l.unchanged} 篇，跳过 ${l.skipped} 篇`,
    `材料：检查 ${m.total} 份，更新 ${m.updated} 份，无变化 ${m.unchanged} 份，跳过 ${m.skipped} 份`,
    `题组：检查 ${g.total} 组，更新 ${g.updated} 组，无变化 ${g.unchanged} 组，跳过 ${g.skipped} 组`,
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
  // tt-06b / QM-05：材料/题组明细（形态同上）
  for (const r of report.materials) {
    if (r.status === "unchanged") continue;
    if (r.status === "updated") {
      lines.push(`[材料·更新] ${r.id}`);
      for (const change of r.changes) {
        lines.push(`  - ${change.field}: ${change.from} → ${change.to}`);
      }
    } else {
      lines.push(`[材料·跳过] ${r.id}：${r.reason ?? ""}`);
    }
  }
  for (const r of report.groups) {
    if (r.status === "unchanged") continue;
    if (r.status === "updated") {
      lines.push(`[题组·更新] ${r.id}`);
      for (const change of r.changes) {
        lines.push(`  - ${change.field}: ${change.from} → ${change.to}`);
      }
    } else {
      lines.push(`[题组·跳过] ${r.id}：${r.reason ?? ""}`);
    }
  }
  return lines.join("\n");
}
