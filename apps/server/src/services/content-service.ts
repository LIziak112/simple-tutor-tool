import type {
  ContentTree,
  ContentTreeCourse,
  ContentTreeQuestion,
  ImportCommitData,
  ImportCommitRequest,
  ImportLectureReport,
  ImportPreviewData,
  ImportPreviewRequest,
  ImportSummary,
  ImportUnitReport,
  LintIssue,
  ParsedDocument,
  Question,
} from "@tutor/contract";
import { detectVersion, lintDocument, v1ToV2 } from "@tutor/md-dsl";
import { asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  courses,
  imports,
  knowledgePoints,
  lectures,
  questionKnowledge,
  questions,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";

/**
 * ContentService（T1.10）：内容导入的业务层。路由只做鉴权/校验/包装，本模块承载：
 * - 版本识别与统一 lint：detectVersion → v1 则 v1ToV2 转换（原文照旧留档）→ 一律走
 *   v2 lintDocument（§5.1 末段「v1 兼容」：导入时自动识别）；
 * - preview：纯读，不写库（dry-run 预览，§5.1）；
 * - commit：有 error 级 issue 拒绝（422 LINT_ERROR）；否则事务内落库——
 *   imports 留档原文 → 讲义按 (courseId, title) 替换 markdown → 单元按 id 合并 →
 *   题目 id 已存在则更新 + version+1（跨单元同 id 也按更新，unitId 随之更新）→
 *   知识考点同名归一（knowledge_points 复用 + 关联全量替换）。
 *
 * 「原文是真相」（§5.1.1(4)）：questions.sourceMd / lectures.markdown / imports.rawMd
 * 保存原文；结构化字段（type/answers/…）只是判分与统计必需的抽取结果。
 */

/** 系统默认课程名（courseId 缺省时使用；不存在则自动创建） */
export const DEFAULT_COURSE_TITLE = "默认课程";

/** 事务回调拿到的数据库句柄类型（better-sqlite3 同步事务） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------- 版本识别与统一 lint ----------

/** 导入分析的中间产物：识别版本 + lint 结果（parsed.issues 与 issues 同源全量） */
interface ImportAnalysis {
  readonly version: 1 | 2;
  readonly issues: LintIssue[];
  readonly parsed: ParsedDocument;
}

/**
 * 识别版本并做完整 lint。
 * v1 文档先经 v1ToV2 转换再 lint（转换保证 0 error）；issues 行号对 v1 指向转换后的
 * v2 文本（教师侧修复时以 lint 输出为准）。rawMd 始终保留老师提交的原文。
 */
function analyzeImport(markdown: string): ImportAnalysis {
  const version = detectVersion(markdown);
  const v2Md = version === 1 ? v1ToV2(markdown) : markdown;
  const { parsed, issues } = lintDocument(v2Md);
  return { version, issues, parsed };
}

/** 由解析结果统计预览摘要 */
function summarizeParsed(parsed: ParsedDocument): ImportSummary {
  const typeDistribution: Record<string, number> = {};
  let questionCount = 0;
  for (const unit of parsed.units) {
    for (const question of unit.questions) {
      questionCount += 1;
      typeDistribution[question.type] =
        (typeDistribution[question.type] ?? 0) + 1;
    }
  }
  return {
    unitCount: parsed.units.length,
    lectureCount: parsed.lectures.length,
    questionCount,
    typeDistribution,
  };
}

// ---------- preview：不写库 ----------

/** 导入预览：识别版本 + 摘要 + 全部 lint issues（含 error，供前端标红；不写库） */
export function previewImport(
  _db: Db,
  input: ImportPreviewRequest,
): ImportPreviewData {
  const { version, issues, parsed } = analyzeImport(input.markdown);
  return { version, summary: summarizeParsed(parsed), issues };
}

// ---------- commit：lint 拒绝 + 事务落库 ----------

/**
 * 导入提交。有 error 级 issue 时抛 422 LINT_ERROR（extra._issues 附错误列表，
 * 响应体为统一错误壳的超集）；courseId 缺省时使用系统默认课程（不存在则创建）。
 * 成功返回导入统计报告（报告同时序列化进 imports.reportJson 留档）。
 */
export function commitImport(
  db: Db,
  input: ImportCommitRequest,
): ImportCommitData {
  const { issues, parsed } = analyzeImport(input.markdown);

  // error 级 issue → 拒绝写入（此时连默认课程都不创建）
  const errors = issues.filter((issue) => issue.level === "error");
  const first = errors[0];
  if (first !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `文档存在 ${errors.length} 个 error 级问题，请先修复后重试（第 ${first.line} 行：${first.message}）`,
      { _issues: errors },
    );
  }

  const courseId = resolveCourseId(db, input.courseId);

  return db.transaction((tx) => {
    const now = new Date().toISOString();
    const importId = crypto.randomUUID();

    // ---- 讲义：按 (courseId, title) 匹配替换 markdown，无则插入 ----
    const lectureReports: ImportLectureReport[] = [];
    const lectureIdByTitle = new Map<string, string>();
    const courseLectures = tx
      .select({ id: lectures.id, title: lectures.title })
      .from(lectures)
      .where(eq(lectures.courseId, courseId))
      .all();
    for (const row of courseLectures) lectureIdByTitle.set(row.title, row.id);
    let nextLectureOrder = courseLectures.length;

    for (const lecture of parsed.lectures) {
      const existingId = lectureIdByTitle.get(lecture.title);
      if (existingId !== undefined) {
        tx.update(lectures)
          .set({ markdown: lecture.markdown, updatedAt: now })
          .where(eq(lectures.id, existingId))
          .run();
        lectureReports.push({
          id: existingId,
          title: lecture.title,
          inserted: false,
          updated: true,
        });
      } else {
        const id = crypto.randomUUID();
        tx.insert(lectures)
          .values({
            id,
            courseId,
            title: lecture.title,
            markdown: lecture.markdown,
            order: nextLectureOrder,
            updatedAt: now,
          })
          .run();
        nextLectureOrder += 1;
        lectureIdByTitle.set(lecture.title, id);
        lectureReports.push({
          id,
          title: lecture.title,
          inserted: true,
          updated: false,
        });
      }
    }

    // ---- 单元：按 id 匹配（id 来自 DSL，全局唯一）→ 更新或插入 ----
    const unitReports: ImportUnitReport[] = [];
    const existingUnitIds = new Set(
      tx
        .select({ id: units.id })
        .from(units)
        .all()
        .map((row) => row.id),
    );
    let nextUnitOrder = tx
      .select({ id: units.id })
      .from(units)
      .where(eq(units.courseId, courseId))
      .all().length;

    for (const unit of parsed.units) {
      // lectureTitle 按 (courseId, title) 匹配讲义；匹配不到不关联（lectureId=null，不报错）
      const lectureId =
        unit.lectureTitle !== undefined
          ? (lectureIdByTitle.get(unit.lectureTitle) ?? null)
          : null;
      const patch = {
        courseId,
        lectureId,
        title: unit.title,
        topic: unit.topic ?? null,
        updatedAt: now,
      };
      if (existingUnitIds.has(unit.id)) {
        tx.update(units).set(patch).where(eq(units.id, unit.id)).run();
        unitReports.push({
          id: unit.id,
          title: unit.title,
          inserted: false,
          updated: true,
        });
      } else {
        tx.insert(units)
          .values({ id: unit.id, ...patch, order: nextUnitOrder })
          .run();
        nextUnitOrder += 1;
        existingUnitIds.add(unit.id);
        unitReports.push({
          id: unit.id,
          title: unit.title,
          inserted: true,
          updated: false,
        });
      }
    }

    // ---- 题目：id 已存在（含软删，视为恢复）→ 更新 + version+1；新 id → 插入 version=1 ----
    let insertedQuestions = 0;
    let updatedQuestions = 0;
    const existingQuestions = new Map(
      tx
        .select({ id: questions.id, version: questions.version })
        .from(questions)
        .all()
        .map((row) => [row.id, row.version] as const),
    );
    const knowledgeIdByName = new Map(
      tx
        .select({ id: knowledgePoints.id, name: knowledgePoints.name })
        .from(knowledgePoints)
        .all()
        .map((row) => [row.name, row.id] as const),
    );

    for (const unit of parsed.units) {
      for (const [index, question] of unit.questions.entries()) {
        const fields = questionFields(question, unit.id, index, now);
        const existingVersion = existingQuestions.get(question.id);
        if (existingVersion === undefined) {
          tx.insert(questions)
            .values({ id: question.id, ...fields, version: 1 })
            .run();
          existingQuestions.set(question.id, 1);
          insertedQuestions += 1;
        } else {
          // 跨单元同 id 同样按更新处理（unitId 已随 fields 更新）；软删行同时恢复
          tx.update(questions)
            .set({
              ...fields,
              version: existingVersion + 1,
              deletedAt: null,
            })
            .where(eq(questions.id, question.id))
            .run();
          existingQuestions.set(question.id, existingVersion + 1);
          updatedQuestions += 1;
        }
        syncQuestionKnowledge(tx, question, knowledgeIdByName);
      }
    }

    // ---- imports 留档（原文 = 老师提交的原文，v1 不存转换文本）----
    const report: ImportCommitData = {
      importId,
      courseId,
      units: unitReports,
      lectures: lectureReports,
      questions: { inserted: insertedQuestions, updated: updatedQuestions },
    };
    tx.insert(imports)
      .values({
        id: importId,
        filename: input.filename,
        kind: parsed.frontmatter?.kind ?? "practice",
        rawMd: input.markdown,
        reportJson: JSON.stringify(report),
        createdAt: now,
      })
      .run();
    return report;
  });
}

/** 题目结构化字段（不含 id/version；update 与 insert 共用） */
function questionFields(
  question: Question,
  unitId: string,
  order: number,
  now: string,
): {
  unitId: string;
  order: number;
  type: Question["type"];
  difficulty: number;
  stemMd: string;
  optionsJson: string | null;
  answersJson: string | null;
  hintsJson: string;
  solutionMd: string | null;
  sourceMd: string;
  updatedAt: string;
} {
  return {
    unitId,
    order,
    type: question.type,
    difficulty: question.difficulty,
    stemMd: question.stemMd,
    optionsJson:
      question.options !== undefined ? JSON.stringify(question.options) : null,
    answersJson:
      question.answers !== undefined ? JSON.stringify(question.answers) : null,
    hintsJson: JSON.stringify(question.hints),
    solutionMd: question.solutionMd ?? null,
    sourceMd: question.sourceMd,
    updatedAt: now,
  };
}

/** 同步题目的考点关联：同名 knowledge_point 复用（无则建），关联全量替换 */
function syncQuestionKnowledge(
  tx: Tx,
  question: Question,
  knowledgeIdByName: Map<string, string>,
): void {
  tx.delete(questionKnowledge)
    .where(eq(questionKnowledge.questionId, question.id))
    .run();
  const seen = new Set<string>();
  for (const name of question.knowledge) {
    if (seen.has(name)) continue; // 同名去重（关联表复合主键）
    seen.add(name);
    let pointId = knowledgeIdByName.get(name);
    if (pointId === undefined) {
      pointId = crypto.randomUUID();
      tx.insert(knowledgePoints).values({ id: pointId, name }).run();
      knowledgeIdByName.set(name, pointId);
    }
    tx.insert(questionKnowledge)
      .values({ questionId: question.id, knowledgePointId: pointId })
      .run();
  }
}

/** 解析实际导入的课程：显式 courseId 必须存在；缺省用默认课程（无则创建） */
function resolveCourseId(db: Db, courseId: string | undefined): string {
  if (courseId !== undefined) {
    const row = db
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (row === undefined) {
      throw new HttpError(404, "COURSE_NOT_FOUND", "指定的课程不存在");
    }
    return row.id;
  }
  const existing = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.title, DEFAULT_COURSE_TITLE))
    .get();
  if (existing !== undefined) return existing.id;
  const id = crypto.randomUUID();
  db.insert(courses)
    .values({
      id,
      title: DEFAULT_COURSE_TITLE,
      order: 0,
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

// ---------- 内容树：GET /api/teacher/content（T1.11） ----------

/**
 * 读取教师端内容页的树状结构：课程 → 讲义（标题+更新时间）/ 练习单元（展开题目摘要）。
 * - 软删题目（deletedAt 非空）不出现在摘要里（T1.12 起删除的题目从列表消失）；
 * - 讲义无题目数组；单元题目按单元内 order 排序，考点经关联表按考点名排序保证稳定输出；
 * - 未导入任何内容时 courses 为空数组（前端据此显示空态引导）。
 */
export function getContentTree(db: Db): ContentTree {
  const allCourses = db
    .select()
    .from(courses)
    .orderBy(asc(courses.order), asc(courses.title))
    .all();

  // 题目摘要（软删过滤）与考点关联，一次读全后在内存分组（教师端数据量：一对一辅导，量级很小）
  const liveQuestions = db
    .select({
      id: questions.id,
      unitId: questions.unitId,
      order: questions.order,
      type: questions.type,
      difficulty: questions.difficulty,
      version: questions.version,
    })
    .from(questions)
    .where(isNull(questions.deletedAt))
    // order 相同时按 id 兜底（不同来源导入可产生同 order，保证树输出稳定）
    .orderBy(asc(questions.unitId), asc(questions.order), asc(questions.id))
    .all();
  const knowledgeRows = db
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
    .all();
  const knowledgeByQuestion = new Map<string, string[]>();
  for (const row of knowledgeRows) {
    const list = knowledgeByQuestion.get(row.questionId);
    if (list === undefined) {
      knowledgeByQuestion.set(row.questionId, [row.name]);
    } else {
      list.push(row.name);
    }
  }
  const questionsByUnit = new Map<string, ContentTreeQuestion[]>();
  for (const q of liveQuestions) {
    const summary: ContentTreeQuestion = {
      id: q.id,
      type: q.type,
      difficulty: q.difficulty,
      knowledge: knowledgeByQuestion.get(q.id) ?? [],
      version: q.version,
    };
    const list = questionsByUnit.get(q.unitId);
    if (list === undefined) {
      questionsByUnit.set(q.unitId, [summary]);
    } else {
      list.push(summary);
    }
  }

  const treeCourses: ContentTreeCourse[] = allCourses.map((course) => {
    // 局部变量命名避开表名（同名 const 会在初始化前引用自身，TDZ ReferenceError）
    const lectureRows = db
      .select({
        id: lectures.id,
        title: lectures.title,
        updatedAt: lectures.updatedAt,
      })
      .from(lectures)
      .where(eq(lectures.courseId, course.id))
      .orderBy(asc(lectures.order), asc(lectures.title))
      .all();
    const unitRows = db
      .select({
        id: units.id,
        title: units.title,
        topic: units.topic,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .where(eq(units.courseId, course.id))
      .orderBy(asc(units.order), asc(units.title))
      .all()
      .map((unit) => ({
        ...unit,
        questions: questionsByUnit.get(unit.id) ?? [],
      }));
    return {
      id: course.id,
      title: course.title,
      lectures: lectureRows,
      units: unitRows,
    };
  });

  return { courses: treeCourses };
}
