import type {
  ContentTree,
  ContentTreeCourse,
  ContentTreeQuestion,
  CourseData,
  CourseUpdateRequest,
  ImportCommitData,
  ImportCommitRequest,
  ImportLectureReport,
  ImportPreviewData,
  ImportPreviewRequest,
  ImportSummary,
  ImportUnitReport,
  LectureDetail,
  LectureUpdateData,
  LintIssue,
  ParsedDocument,
  QuestionDetail,
  QuestionUpdateData,
  ReorderRequest,
  StudentLectureDetail,
  StudentLectureSummary,
} from "@tutor/contract";
import {
  detectVersion,
  LECTURE_PREFIX_LINES,
  lintDocument,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  v1ToV2,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { ensureCourseFolder } from "../db/backfill";
import type { Db } from "../db/client";
import {
  courseItems,
  courseStudents,
  courses,
  imports,
  knowledgePoints,
  lectures,
  questionKnowledge,
  questions,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { softDeleteLecture } from "./library-service";
import {
  loadKnowledgeIdByName,
  questionFields,
  syncQuestionKnowledge,
} from "./question-sync";

/**
 * ContentService（T1.10 导入、T1.11 内容树、T1.12 单条编辑/删除/排序/课程 CRUD）
 * 的业务层。路由只做鉴权/校验/包装，本模块承载：
 * - 版本识别与统一 lint：detectVersion → v1 则 v1ToV2 转换（原文照旧留档）→ 一律走
 *   v2 lintDocument（§5.1 末段「v1 兼容」：导入时自动识别）；
 * - preview：纯读，不写库（dry-run 预览，§5.1）；
 * - commit：有 error 级 issue 拒绝（422 LINT_ERROR）；否则事务内落库——
 *   imports 留档原文 → 讲义按 (folderId, title) 替换 markdown → 单元按 id 合并 →
 *   题目 id 已存在则更新 + version+1（跨单元同 id 也按更新，unitId 随之更新）→
 *   知识考点同名归一（knowledge_points 复用 + 关联全量替换）；
 * - getContentTree：课程 → 讲义/单元 → 题目摘要（软删题目过滤）；
 * - T1.12：单题编辑（id/unitId 不变、version+1）、题目软删、讲义整篇编辑与
 *   软删（T2A.1 起取消物理删除，D3）、reorder（order 按新顺序下标重写）、
 *   课程 CRUD（非空拒删）。
 *
 * T2A.1 兼容适配（Phase 2A 改进任务清单）：
 * - 导入 courseId 参数语义：内容进该课程同名文件夹（无则建）+ 追加 course_items
 *   （讲义 visible=true、单元 visible=false；重复资源跳过不报错——导入是幂等
 *   更新场景，不走 409）。资源归属资源库（folderId），课程只是引用；
 * - getContentTree 改为从 course_items 组装（响应结构保持原样，含单元 questions）；
 * - 讲义删除改软删（deleteLecture 委托 LibraryService）；
 * - 学生端讲义读路径全部过滤 deletedAt（D3 窗口期；可见性模型切换属 T2A.5）。
 *
 * 「原文是真相」（§5.1.1(4)）：questions.sourceMd / lectures.markdown / imports.rawMd
 * 保存原文；结构化字段（type/answers/…）只是判分与统计必需的抽取结果。
 */

/** 系统默认课程名（courseId 缺省时使用；不存在则自动创建） */
export const DEFAULT_COURSE_TITLE = "默认课程";

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
 *
 * T2A.1：内容归属资源库——courseId 用于定位「课程同名文件夹」（无则建）与追加
 * 课程目录条目（讲义 visible=true、单元 visible=false；已在该课程的资源跳过，
 * 导入是幂等更新场景，不走 409）。响应形状不变（courseId 仍为实际课程 id）。
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

    const course = tx
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (course === undefined) {
      throw new HttpError(404, "COURSE_NOT_FOUND", "指定的课程不存在");
    }
    // 课程同名文件夹（D23-1 同款规则：存在即复用，无则建）
    const folder = ensureCourseFolder(tx, course.title, now);

    // ---- 讲义：按 (folderId, title) 匹配替换 markdown，无则插入 ----
    const lectureReports: ImportLectureReport[] = [];
    const lectureIdByTitle = new Map<string, string>();
    const folderLectures = tx
      .select({ id: lectures.id, title: lectures.title })
      .from(lectures)
      .where(eq(lectures.folderId, folder.id))
      .all();
    for (const row of folderLectures) lectureIdByTitle.set(row.title, row.id);
    let nextLectureOrder = folderLectures.length;

    for (const lecture of parsed.lectures) {
      const existingId = lectureIdByTitle.get(lecture.title);
      if (existingId !== undefined) {
        // 命中即替换 markdown；软删行同时恢复（与题目「同 id 再导入即恢复」同口径）
        tx.update(lectures)
          .set({ markdown: lecture.markdown, updatedAt: now, deletedAt: null })
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
        // 注意：不写 courseId（@deprecated T2A，归属改 folderId）
        tx.insert(lectures)
          .values({
            id,
            folderId: folder.id,
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
      .where(eq(units.folderId, folder.id))
      .all().length;

    for (const unit of parsed.units) {
      // lectureTitle 按文件夹内标题匹配讲义；匹配不到不关联（lectureId=null，不报错）
      const lectureId =
        unit.lectureTitle !== undefined
          ? (lectureIdByTitle.get(unit.lectureTitle) ?? null)
          : null;
      if (existingUnitIds.has(unit.id)) {
        // 命中已有单元：保留其原文件夹（D18），软删行恢复；不写 courseId/folderId
        tx.update(units)
          .set({
            lectureId,
            title: unit.title,
            topic: unit.topic ?? null,
            updatedAt: now,
            deletedAt: null,
          })
          .where(eq(units.id, unit.id))
          .run();
        unitReports.push({
          id: unit.id,
          title: unit.title,
          inserted: false,
          updated: true,
        });
      } else {
        tx.insert(units)
          .values({
            id: unit.id,
            folderId: folder.id,
            lectureId,
            title: unit.title,
            topic: unit.topic ?? null,
            order: nextUnitOrder,
            updatedAt: now,
          })
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
    const knowledgeIdByName = loadKnowledgeIdByName(tx);

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

    // ---- 追加课程目录条目（T2A.1）：讲义 visible=true、单元 visible=false；
    //      已在该课程的资源跳过（唯一约束 + onConflictDoNothing，幂等不报错） ----
    let nextItemOrder =
      tx
        .select({ order: courseItems.order })
        .from(courseItems)
        .where(eq(courseItems.courseId, courseId))
        .all()
        .reduce((max, row) => Math.max(max, row.order), -1) + 1;
    for (const report of lectureReports) {
      tx.insert(courseItems)
        .values({
          id: crypto.randomUUID(),
          courseId,
          kind: "lecture",
          refId: report.id,
          title: null,
          order: nextItemOrder,
          visible: true,
          publishAt: null,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [courseItems.courseId, courseItems.kind, courseItems.refId],
        })
        .run();
      nextItemOrder += 1;
    }
    for (const report of unitReports) {
      tx.insert(courseItems)
        .values({
          id: crypto.randomUUID(),
          courseId,
          kind: "unit",
          refId: report.id,
          title: null,
          order: nextItemOrder,
          visible: false,
          publishAt: null,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [courseItems.courseId, courseItems.kind, courseItems.refId],
        })
        .run();
      nextItemOrder += 1;
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

// ---------- 内容树：GET /api/teacher/content（T1.11；T2A.1 改 course_items 组装） ----------

/**
 * 读取教师端内容页的树状结构：课程 → 讲义（标题+更新时间）/ 练习单元（展开题目摘要）。
 * **响应结构保持原样**（教师布置作业下拉与 E2E 依赖它）：
 * - T2A.1 起课程内容从 course_items 组装（讲义列表 = lecture 条目按 item 顺序；
 *   单元列表 = unit 条目按 item 顺序——两份列表各自保序，交错关系不体现）；
 * - 软删题目（deletedAt 非空）不出现在摘要里；软删讲义/单元同样不出现在树里
 *   （D3：教师课程页「已删除」标记属 T2A.2/T2A.4 的课程编辑页，本接口纯过滤）；
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

  // 存活资源（软删过滤）一次读全；目录条目引用已删资源时直接跳过该条目
  const lectureById = new Map(
    db
      .select({
        id: lectures.id,
        title: lectures.title,
        updatedAt: lectures.updatedAt,
      })
      .from(lectures)
      .where(isNull(lectures.deletedAt))
      .all()
      .map((row) => [row.id, row] as const),
  );
  const unitById = new Map(
    db
      .select({
        id: units.id,
        title: units.title,
        topic: units.topic,
        updatedAt: units.updatedAt,
      })
      .from(units)
      .where(isNull(units.deletedAt))
      .all()
      .map((row) => [row.id, row] as const),
  );

  const treeCourses: ContentTreeCourse[] = allCourses.map((course) => {
    const items = db
      .select({ kind: courseItems.kind, refId: courseItems.refId })
      .from(courseItems)
      .where(eq(courseItems.courseId, course.id))
      .orderBy(asc(courseItems.order), asc(courseItems.id))
      .all();
    const lectureNodes = items
      .filter((item) => item.kind === "lecture")
      .map((item) =>
        item.refId === null ? undefined : lectureById.get(item.refId),
      )
      .filter(
        (row): row is { id: string; title: string; updatedAt: string } =>
          row !== undefined,
      );
    const unitNodes = items
      .filter((item) => item.kind === "unit")
      .map((item) =>
        item.refId === null ? undefined : unitById.get(item.refId),
      )
      .filter(
        (
          row,
        ): row is {
          id: string;
          title: string;
          topic: string | null;
          updatedAt: string;
        } => row !== undefined,
      )
      .map((unit) => ({
        ...unit,
        questions: questionsByUnit.get(unit.id) ?? [],
      }));
    return {
      id: course.id,
      title: course.title,
      lectures: lectureNodes,
      units: unitNodes,
    };
  });

  return { courses: treeCourses };
}

// ---------- T1.12：单条编辑 / 删除 / 排序 / 课程 CRUD ----------

/** 读取题目完整内容（编辑抽屉用）。不存在或已软删 → 404（软删题不在列表，按不存在处理） */
export function getQuestionDetail(db: Db, id: string): QuestionDetail {
  const row = db.select().from(questions).where(eq(questions.id, id)).get();
  if (row === undefined || row.deletedAt !== null) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在（可能已被删除）",
    );
  }
  return {
    id: row.id,
    unitId: row.unitId,
    order: row.order,
    type: row.type,
    difficulty: row.difficulty,
    knowledge: knowledgeNamesOf(db, row.id),
    sourceMd: row.sourceMd,
    version: row.version,
  };
}

/** 某题关联的考点名列表（按名称排序，与内容树口径一致） */
function knowledgeNamesOf(db: Db, questionId: string): string[] {
  return db
    .select({ name: knowledgePoints.name })
    .from(questionKnowledge)
    .innerJoin(
      knowledgePoints,
      eq(questionKnowledge.knowledgePointId, knowledgePoints.id),
    )
    .where(eq(questionKnowledge.questionId, questionId))
    .orderBy(asc(knowledgePoints.name))
    .all()
    .map((row) => row.name);
}

/**
 * 单题编辑（PUT /api/teacher/questions/:id）：提交该题 sourceMd，服务端重新解析单题。
 * - 解析语境：wrapSingleQuestionMd(unitId, sourceMd) + ParseOptions{unitId,
 *   questionStartNumber: order+1}，缺省 id 按「单元id-序号」复现原 id；
 * - 0 题 / 多题 → 422 VALIDATION_ERROR；解析出 id ≠ 原 id → 422 ID_IMMUTABLE
 *   （id 不可变，学情统计跨版本延续，§5.1）；
 * - error 级 lint issue → 422 LINT_ERROR（_issues 行号已平移回 sourceMd 坐标）；
 * - 通过 → 结构化字段 + sourceMd 全量更新、version+1，id/unitId/order 不变。
 */
export function updateQuestion(
  db: Db,
  id: string,
  input: { sourceMd: string },
): QuestionUpdateData {
  const row = db.select().from(questions).where(eq(questions.id, id)).get();
  if (row === undefined || row.deletedAt !== null) {
    throw new HttpError(
      404,
      "QUESTION_NOT_FOUND",
      "题目不存在（可能已被删除）",
    );
  }

  const parseOptions = {
    unitId: row.unitId,
    questionStartNumber: row.order + 1,
  };
  const wrapped = wrapSingleQuestionMd(row.unitId, input.sourceMd);
  const { parsed, issues } = lintDocument(wrapped, parseOptions);

  // error 级 issue 最先拦（含"题目被解析器丢弃"的场景，如未知题型：
  // 此时题数检查给不出行号，LINT_ERROR 的 _issues 才能标红到具体行）
  const errors = issues.filter((issue) => issue.level === "error");
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `题目存在 ${errors.length} 个 error 级问题，请先修复后重试（第 ${Math.max(
        1,
        firstError.line - SINGLE_QUESTION_PREFIX_LINES,
      )} 行：${firstError.message}）`,
      {
        _issues: shiftLintIssuesToFragment(
          errors,
          SINGLE_QUESTION_PREFIX_LINES,
        ),
      },
    );
  }

  const parsedQuestions = parsed.units.flatMap((unit) => unit.questions);
  if (parsedQuestions.length === 0) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "未解析出任何题目：请保留完整的 ::::question 容器（含题干与结束围栏 ::::）",
    );
  }
  if (parsedQuestions.length > 1) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `一次只能编辑一道题（当前解析出 ${parsedQuestions.length} 道）；如需新增题目请走导入`,
    );
  }
  const next = parsedQuestions[0];
  if (next === undefined || next.id !== id) {
    throw new HttpError(
      422,
      "ID_IMMUTABLE",
      next === undefined
        ? "题目 id 不可变；如需新增题目请走导入"
        : `题目 id 不可变（原 id「${id}」，解析出「${next.id}」）；如需新增题目请走导入`,
    );
  }

  const now = new Date().toISOString();
  const version = row.version + 1;
  db.transaction((tx) => {
    tx.update(questions)
      .set({
        ...questionFields(next, row.unitId, row.order, now),
        version,
      })
      .where(eq(questions.id, id))
      .run();
    const knowledgeIdByName = loadKnowledgeIdByName(tx);
    syncQuestionKnowledge(tx, next, knowledgeIdByName);
  });

  return {
    id,
    version,
    type: next.type,
    difficulty: next.difficulty,
    knowledge: next.knowledge,
    issues: shiftLintIssuesToFragment(issues, SINGLE_QUESTION_PREFIX_LINES),
  };
}

/**
 * 题目软删（DELETE /api/teacher/questions/:id）：只写 deletedAt（§5.2 题目不物理删除，
 * 历史作答/统计保留；重新导入同 id 题目即恢复）。已软删时幂等成功。
 */
export function deleteQuestion(db: Db, id: string): void {
  const row = db
    .select({ id: questions.id, deletedAt: questions.deletedAt })
    .from(questions)
    .where(eq(questions.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在");
  }
  if (row.deletedAt !== null) return; // 幂等：重复删除同样成功
  db.update(questions)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(questions.id, id))
    .run();
}

/** 读取讲义完整内容（编辑抽屉用）。markdown 含 H1 标题行（原文是真相） */
export function getLectureDetail(db: Db, id: string): LectureDetail {
  const row = db.select().from(lectures).where(eq(lectures.id, id)).get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  return {
    id: row.id,
    title: row.title,
    markdown: row.markdown,
    updatedAt: row.updatedAt,
  };
}

/**
 * 讲义编辑（PUT /api/teacher/lectures/:id）：整篇 markdown 提交，title 从 H1 重取，
 * 讲义 id（数据库 uuid）保持不变。解析语境 wrapLectureMd；
 * 多个 H1 → 422（一篇讲义只能有一个 H1）；error 级 lint issue → 422 LINT_ERROR。
 */
export function updateLecture(
  db: Db,
  id: string,
  input: { markdown: string },
): LectureUpdateData {
  const row = db.select().from(lectures).where(eq(lectures.id, id)).get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }

  const wrapped = wrapLectureMd(input.markdown);
  const { parsed, issues } = lintDocument(wrapped);

  if (parsed.lectures.length > 1) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `讲义只能包含一个 H1 标题（当前解析出 ${parsed.lectures.length} 篇）；如需多篇讲义请走导入`,
    );
  }

  const errors = issues.filter((issue) => issue.level === "error");
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `讲义存在 ${errors.length} 个 error 级问题，请先修复后重试（第 ${Math.max(
        1,
        firstError.line - LECTURE_PREFIX_LINES,
      )} 行：${firstError.message}）`,
      { _issues: shiftLintIssuesToFragment(errors, LECTURE_PREFIX_LINES) },
    );
  }

  // 0 篇（无 H1）已被 MISSING_HEADING error 拦截，此处必有一篇；仍做类型收窄防御
  const title = parsed.lectures[0]?.title;
  if (title === undefined || title.trim().length === 0) {
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "讲义必须以「# 标题」开头（title 从 H1 重取）",
    );
  }

  const updatedAt = new Date().toISOString();
  db.update(lectures)
    .set({ markdown: input.markdown, title, updatedAt })
    .where(eq(lectures.id, id))
    .run();
  return { id, title, updatedAt };
}

/**
 * 讲义删除（DELETE /api/teacher/lectures/:id）：软删（T2A.1 起取消 T1.12 的物理删除，
 * D3——进回收站可恢复）。委托 LibraryService.softDeleteLecture（幂等；行不存在 404）。
 * 关联单元的 lectureId 保留：恢复讲义即回到原状（「从课程移除」由目录条目删除承担，
 * 属 T2A.4）。
 */
export function deleteLecture(db: Db, id: string): void {
  softDeleteLecture(db, id);
}

/** reorder 各 kind 的元信息：错误码 + 中文名 + 存活 id 集合（软删实体视同不存在） */
function reorderLiveIds(
  db: Db,
  kind: ReorderRequest["kind"],
): { code: string; entityName: string; ids: Set<string> } {
  const meta = {
    question: { code: "QUESTION_NOT_FOUND", entityName: "题目" },
    lecture: { code: "LECTURE_NOT_FOUND", entityName: "讲义" },
    unit: { code: "UNIT_NOT_FOUND", entityName: "单元" },
    course: { code: "COURSE_NOT_FOUND", entityName: "课程" },
  }[kind];
  const ids =
    kind === "question"
      ? db
          .select({ id: questions.id })
          .from(questions)
          .where(isNull(questions.deletedAt))
          .all()
      : kind === "lecture"
        ? db
            .select({ id: lectures.id })
            .from(lectures)
            .where(isNull(lectures.deletedAt))
            .all()
        : kind === "unit"
          ? db
              .select({ id: units.id })
              .from(units)
              .where(isNull(units.deletedAt))
              .all()
          : db.select({ id: courses.id }).from(courses).all();
  return { ...meta, ids: new Set(ids.map((row) => row.id)) };
}

/**
 * 讲义/单元全局排序后，把各课程内同类目录条目的顺序同步为新相对顺序。
 * 槽位保持：条目只在本课程同类条目已占据的 order 槽位内重排——与分节/其他类型
 * 条目的交错关系不变（course_items.order 是全 kind 共用一个序列）。
 * 已删资源不在全局顺序中（排最末，保持其原相对顺序——sort 稳定）。
 */
function reorderCourseItemSlots(db: Db, kind: "lecture" | "unit"): void {
  const resourceIds =
    kind === "lecture"
      ? db
          .select({ id: lectures.id })
          .from(lectures)
          .where(isNull(lectures.deletedAt))
          .orderBy(asc(lectures.order), asc(lectures.title))
          .all()
          .map((row) => row.id)
      : db
          .select({ id: units.id })
          .from(units)
          .where(isNull(units.deletedAt))
          .orderBy(asc(units.order), asc(units.title))
          .all()
          .map((row) => row.id);
  const position = new Map(
    resourceIds.map((id, index) => [id, index] as const),
  );

  const courseIds = [
    ...new Set(
      db
        .select({ courseId: courseItems.courseId })
        .from(courseItems)
        .where(eq(courseItems.kind, kind))
        .all()
        .map((row) => row.courseId),
    ),
  ];
  for (const courseId of courseIds) {
    const rows = db
      .select({
        id: courseItems.id,
        refId: courseItems.refId,
        order: courseItems.order,
      })
      .from(courseItems)
      .where(
        and(eq(courseItems.courseId, courseId), eq(courseItems.kind, kind)),
      )
      .orderBy(asc(courseItems.order), asc(courseItems.id))
      .all();
    if (rows.length < 2) continue;
    const slots = rows.map((row) => row.order); // 升序槽位（保持交错关系）
    const sorted = [...rows].sort(
      (a, b) =>
        (position.get(a.refId ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.refId ?? "") ?? Number.MAX_SAFE_INTEGER),
    );
    db.transaction((tx) => {
      for (const [index, row] of sorted.entries()) {
        if (row.order !== slots[index]) {
          tx.update(courseItems)
            .set({ order: slots[index] })
            .where(eq(courseItems.id, row.id))
            .run();
        }
      }
    });
  }
}

/**
 * 排序（POST /api/teacher/reorder）：order 按 ids 数组下标（0 起）重写。
 * ids 为该 kind 下排序作用域内实体的完整新顺序（题目 = 所属单元内的题目）；
 * 任一 id 不存在（题目/讲义/单元软删视同不存在）→ 404，事务回滚保持原顺序。
 * 讲义/单元排序同时同步各课程目录条目的相对顺序（T2A.1 起内容页顺序取自
 * course_items，见 reorderCourseItemSlots）。
 */
export function reorderContent(db: Db, input: ReorderRequest): void {
  const { code, entityName, ids: liveIds } = reorderLiveIds(db, input.kind);
  const missing = input.ids.find((id) => !liveIds.has(id));
  if (missing !== undefined) {
    throw new HttpError(
      404,
      code,
      `排序失败：${entityName}「${missing}」不存在`,
    );
  }

  db.transaction((tx) => {
    for (const [index, id] of input.ids.entries()) {
      if (input.kind === "question") {
        tx.update(questions)
          .set({ order: index })
          .where(eq(questions.id, id))
          .run();
      } else if (input.kind === "lecture") {
        tx.update(lectures)
          .set({ order: index })
          .where(eq(lectures.id, id))
          .run();
      } else if (input.kind === "unit") {
        tx.update(units).set({ order: index }).where(eq(units.id, id)).run();
      } else {
        tx.update(courses)
          .set({ order: index })
          .where(eq(courses.id, id))
          .run();
      }
    }
  });
  if (input.kind === "lecture" || input.kind === "unit") {
    reorderCourseItemSlots(db, input.kind);
  }
}

/** 新建课程（POST /api/teacher/courses）：order 追加到末尾 */
export function createCourse(db: Db, input: { title: string }): CourseData {
  const count = db.select({ id: courses.id }).from(courses).all().length;
  const id = crypto.randomUUID();
  const order = count;
  db.insert(courses)
    .values({
      id,
      title: input.title,
      order,
      createdAt: new Date().toISOString(),
    })
    .run();
  return { id, title: input.title, order };
}

/** 课程重命名（PATCH /api/teacher/courses/:id）：title 缺省 = 不改 */
export function updateCourse(
  db: Db,
  id: string,
  input: CourseUpdateRequest,
): CourseData {
  const row = db.select().from(courses).where(eq(courses.id, id)).get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const title = input.title ?? row.title;
  if (title !== row.title) {
    db.update(courses).set({ title }).where(eq(courses.id, id)).run();
  }
  return { id, title, order: row.order };
}

/**
 * 课程删除（DELETE /api/teacher/courses/:id）：课程下仍有讲义或单元时拒绝
 * （409 COURSE_NOT_EMPTY，避免孤儿数据）；空课程直接物理删除。
 *
 * T2A.1 兼容口径：内容判定以 course_items 为准（资源库改引用制），旧列
 * lectures.courseId / units.courseId 仅对迁移前数据兜底；有成员同样拒绝
 * （course_students 外键保护——T2A.4 改为 D4 语义：按作答记录判定 + 清理
 * 目录条目与成员后删除）。
 */
export function deleteCourse(db: Db, id: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, id))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const hasItems =
    db
      .select({ id: courseItems.id })
      .from(courseItems)
      .where(eq(courseItems.courseId, id))
      .get() !== undefined;
  // @deprecated T2A：旧列兜底（迁移前数据 folderId 回填前的归属痕迹）
  const hasLegacyLecture =
    db
      .select({ id: lectures.id })
      .from(lectures)
      .where(eq(lectures.courseId, id))
      .get() !== undefined;
  const hasLegacyUnit =
    db
      .select({ id: units.id })
      .from(units)
      .where(eq(units.courseId, id))
      .get() !== undefined;
  if (hasItems || hasLegacyLecture || hasLegacyUnit) {
    throw new HttpError(
      409,
      "COURSE_NOT_EMPTY",
      "课程下还有讲义或练习单元，请先删除或移出它们，再删除课程",
    );
  }
  const hasMembers =
    db
      .select({ courseId: courseStudents.courseId })
      .from(courseStudents)
      .where(eq(courseStudents.courseId, id))
      .get() !== undefined;
  if (hasMembers) {
    throw new HttpError(
      409,
      "COURSE_NOT_EMPTY",
      "课程下还有成员，请先移出全部成员，再删除课程",
    );
  }
  db.delete(courses).where(eq(courses.id, id)).run();
}

// ---------- 学生端：讲义（T2.3；T2A.1 加软删过滤） ----------

/**
 * 讲义 id → 关联单元主题（units.lectureId 指向本讲义）。
 * 一篇讲义可能被多个单元关联：取单元 order 最靠前且标注了 topic 的那个；
 * 无关联单元 / 关联单元都未标注主题时映射缺席（调用方兜底 null）。
 * T2A.1：已软删单元不再贡献 topic（D3 窗口期过滤）。
 */
function lectureTopics(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  const rows = db
    .select({ lectureId: units.lectureId, topic: units.topic })
    .from(units)
    .where(and(isNotNull(units.lectureId), isNull(units.deletedAt)))
    .orderBy(asc(units.order))
    .all();
  for (const row of rows) {
    if (row.lectureId === null || row.topic === null) continue;
    if (!map.has(row.lectureId)) map.set(row.lectureId, row.topic);
  }
  return map;
}

/**
 * GET /api/student/lectures：全部讲义摘要。
 *
 * T2A.1 窗口期口径（可见性模型切换到 D5 属 T2A.5，此处不引入）：
 * - 软删讲义（deletedAt 非空）立即不出现在列表（D3 窗口期过滤）；
 * - 排序改按课程目录条目顺序（course.order → course_items.order）；
 *   未被任何课程引用的讲义按 lectures.order 排在末尾；同一讲义被多个课程
 *   引用时只出现一次（D5 并集方向的过渡行为）。
 *
 * 安全口径（AGENTS.md 第 3 条）：只 SELECT id/title/updatedAt 三列——列表接口
 * 不读 markdown 内容列，更不触碰 questions 表任何字段；泄露测试见
 * routes/student-lectures.test.ts。
 */
export function listStudentLectures(db: Db): {
  lectures: StudentLectureSummary[];
} {
  const rows = db
    .select({
      id: lectures.id,
      title: lectures.title,
      updatedAt: lectures.updatedAt,
      order: lectures.order,
    })
    .from(lectures)
    .where(isNull(lectures.deletedAt))
    .all();

  // 每篇讲义在课程目录中的最优（最靠前）位置
  const itemRows = db
    .select({
      refId: courseItems.refId,
      courseOrder: courses.order,
      itemOrder: courseItems.order,
    })
    .from(courseItems)
    .innerJoin(courses, eq(courseItems.courseId, courses.id))
    .where(eq(courseItems.kind, "lecture"))
    .all();
  const bestKeyByLecture = new Map<string, readonly [number, number]>();
  for (const row of itemRows) {
    if (row.refId === null) continue;
    const key: readonly [number, number] = [row.courseOrder, row.itemOrder];
    const existing = bestKeyByLecture.get(row.refId);
    if (
      existing === undefined ||
      key[0] < existing[0] ||
      (key[0] === existing[0] && key[1] < existing[1])
    ) {
      bestKeyByLecture.set(row.refId, key);
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const ka = bestKeyByLecture.get(a.id) ?? [Number.MAX_SAFE_INTEGER, a.order];
    const kb = bestKeyByLecture.get(b.id) ?? [Number.MAX_SAFE_INTEGER, b.order];
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return a.order === b.order
      ? a.title.localeCompare(b.title)
      : a.order - b.order;
  });

  const topics = lectureTopics(db);
  return {
    lectures: sorted.map((row) => ({
      id: row.id,
      title: row.title,
      topic: topics.get(row.id) ?? null,
      updatedAt: row.updatedAt,
    })),
  };
}

/**
 * GET /api/student/lectures/:id：讲义全文 markdown（含 H1 标题行）。
 *
 * 讲义全量下发是设计如此（§5.3）：讲义里的 :::solution 是讲解内容而非题目答案，
 * 学生端应见（前端默认折叠、点开查看）；但本函数只读 lectures 表行，
 * 不附带任何 questions 表字段（stemMd/answers/solutionMd/hintsJson/optionsJson）。
 * T2A.1：已软删讲义按不存在处理（404，D3 窗口期过滤）。
 */
export function getStudentLecture(db: Db, id: string): StudentLectureDetail {
  const row = db
    .select({
      id: lectures.id,
      title: lectures.title,
      markdown: lectures.markdown,
      updatedAt: lectures.updatedAt,
    })
    .from(lectures)
    .where(and(eq(lectures.id, id), isNull(lectures.deletedAt)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  return row;
}
