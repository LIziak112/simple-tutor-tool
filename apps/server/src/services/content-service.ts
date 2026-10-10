import type {
  CapabilitySwitch,
  ContentTree,
  ContentTreeCourse,
  ContentTreeQuestion,
  CourseData,
  CourseUpdateRequest,
  ImportBatchConflict,
  ImportBatchData,
  ImportBatchFilePreview,
  ImportCommitData,
  ImportCommitRequest,
  ImportLectureReport,
  ImportPreviewBatchData,
  ImportPreviewBatchRequest,
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
} from "@tutor/contract";
import {
  IMPORT_MAX_BATCH_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES_PER_BATCH,
} from "@tutor/contract";
import {
  LECTURE_PREFIX_LINES,
  type LintOptions,
  type LintResult,
  lintDocument,
  SINGLE_QUESTION_PREFIX_LINES,
  shiftLintIssuesToFragment,
  wrapLectureMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ensureCourseFolder } from "../db/backfill";
import type { Db } from "../db/client";
import {
  courseItems,
  courseStudents,
  courses,
  imports,
  knowledgePoints,
  lectures,
  libraryFolders,
  questionKnowledge,
  questions,
  units,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { getCapabilityProfile } from "./capability-profile-service";
import { courseHasAttempts } from "./course-service";
import { buildImportPlan, loadLibrarySnapshot } from "./import-actions";
import { softDeleteLecture } from "./library-service";
import { missingMediaImageSrcs } from "./media-service";
import {
  loadKnowledgeIdByName,
  questionFields,
  syncQuestionKnowledge,
} from "./question-sync";

/**
 * ContentService（T1.10 导入、T1.11 内容树、T1.12 单条编辑/删除/排序/课程 CRUD）
 * 的业务层。路由只做鉴权/校验/包装，本模块承载：
 * - 统一 lint：一律走 v2 lintDocument（2026-10-05 起不再支持 v1 旧格式自动转换，
 *   v1 特征文档因无 frontmatter 被 MISSING_FRONTMATTER 拒绝，见架构文档 §10 决策 10）；
 * - preview：纯读，不写库（dry-run 预览，§5.1）；T2A.3 起输出动作清单（D19）与
 *   导入 warning（D18/D19），计算逻辑在 import-actions.buildImportPlan（纯函数复用）；
 * - previewImportBatch（T2A.3，D20）：每文件预览 + 跨文件冲突（同 unit id / 同目标
 *   文件夹同名讲义 → 两侧 error）+ 规模上限（≤50 文件 / 单文件 ≤1MB / 合计 ≤10MB，
 *   超 413 IMPORT_TOO_LARGE，按原始 markdown UTF-8 字节判定）；
 * - commit：有 error 级 issue 拒绝（422 LINT_ERROR）；否则单文件单事务落库——
 *   imports 留档原文（T2A.3 起含 sourcePath/batchId/folderId）→ 讲义按
 *   (folderId, title) 替换 markdown → 单元按 id 合并（命中保留原文件夹，D18）→
 *   题目 id 已存在则更新 + version+1（跨单元同 id 也按更新，unitId 随之更新）→
 *   知识考点同名归一（knowledge_points 复用 + 关联全量替换）；
 * - getImportBatch（T2A.3）：GET /import/batches/:batchId 回看批次内逐文件留档；
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
 * T2A.3 导入只进资源库（D17）：
 * - commit 归属优先级 folderId > folderName（按名查找/新建，D20「按子目录自动建
 *   文件夹」与就地新建共用）> courseId（兼容路径）> 未归类（folderId=null）；
 * - addToCourse（D17 快捷项）：追加 course_items 到目标课程末尾（幂等 onConflict
 *   DoNothing，visible 对讲义与单元统一生效），归属仍在资源库；
 * - 「默认课程」自动创建分支已删除（原 resolveCourseId）：无 folderId 且无
 *   courseId 的导入落「未归类」，不再新建任何课程（与 D23-7 一致）。
 *
 * 「原文是真相」（§5.1.1(4)）：questions.sourceMd / lectures.markdown / imports.rawMd
 * 保存原文；结构化字段（type/answers/…）只是判分与统计必需的抽取结果。
 *
 * T2B.3 域隔离（D12/D13）：preview / preview-batch / commit / batches 回看 /
 * 单题与讲义的详情、编辑、软删、排序全部按会话教师（teacherId 形参，路由传
 * c.var.teacher.id）过滤与写入；T2B.4 起课程 CRUD（createCourse / updateCourse /
 * deleteCourse）同样按会话教师；T2B.5 起 getContentTree 亦域化（域内读课程/
 * 题目/考点关联/讲义/单元，对外响应形状不变）。
 */

// ---------- 统一 lint ----------

/**
 * 对文档做完整 lint（v2 唯一口径）——lintDocument 的直通入口：收单个
 * LintOptions 对象原样透传（可选键显式传 undefined 合法，调用方无需条件展开
 * 体操）。保留为具名入口供 MCP lint_markdown 与导入预览/commit 共用，口径单点。
 *
 * fallbackUnitId（内容模型与导入规范化方案 §2）：frontmatter 未声明 unit 时单元名
 * 锚定文件名。
 *
 * enabledCapabilities（T7.7 / 方案 §4.5）：教师辅助能力启用集——提供时对
 * steps/手写题型回退给 CAPABILITY_DISABLED warning；未提供按全启用（不触发）。
 */
export function analyzeImport(
  markdown: string,
  options: LintOptions = {},
): LintResult {
  return lintDocument(markdown, options);
}

/**
 * 文件名/路径 → 单元名锚（方案 §2「文件名去扩展名」）：取 basename（"/" 与 "\"
 * 都按分隔符）→ 去掉最后一个 .md / .markdown（大小写不敏感）→ trim；
 * 结果为空（如文件名只剩扩展名）返回 undefined——不传 fallback，走解析器原兜底。
 */
function fallbackUnitIdOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const withoutExt = base.replace(/\.(?:markdown|md)$/i, "");
  const trimmed = withoutExt.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 由解析结果统计预览摘要（T4.6 起导出：MCP lint_markdown 复用） */
export function summarizeParsed(parsed: ParsedDocument): ImportSummary {
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

/** 校验目标文件夹存在（域内，404 FOLDER_NOT_FOUND）；null = 未归类直接放行 */
function assertFolderExists(
  db: Db,
  teacherId: string,
  folderId: string | null,
): void {
  if (folderId === null) return;
  const row = db
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(
      and(
        eq(libraryFolders.teacherId, teacherId),
        eq(libraryFolders.id, folderId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "FOLDER_NOT_FOUND", "目标文件夹不存在");
  }
}

/** 组装单文件预览（preview 与 preview-batch 共用；不写库；匹配范围=本教师域，D13） */
function buildPreview(
  db: Db,
  teacherId: string,
  markdown: string,
  folderId: string | null,
  fallbackUnitId?: string,
  dataDir?: string,
): ImportPreviewData {
  // T7.7：携带教师启用集（steps/手写回退提示随预览可见）
  const { issues, parsed } = analyzeImport(markdown, {
    fallbackUnitId,
    enabledCapabilities: getCapabilityProfile(db, teacherId)
      .enabledCapabilities,
  });
  const plan = buildImportPlan({
    parsed,
    folderId,
    snapshot: loadLibrarySnapshot(db, new Date().toISOString(), teacherId),
  });
  return {
    summary: summarizeParsed(parsed),
    issues: [...issues, ...mediaImageExistenceIssues(markdown, dataDir)],
    actions: [...plan.actions],
    warnings: [...plan.warnings],
  };
}

/**
 * ::image 引用图片的文件存在性核对（IMAGE_SRC_NOT_FOUND，warning 不阻断）：
 * 对导入 md **原文**（覆盖文档内全部引用，含未进解析产物的文本）的严格形态
 * src 逐一核对 DATA_DIR 落盘文件，缺失的每个 src 报一条 warning（同文档同图
 * 多次引用经提取侧去重，只报一次），行号取该 src 首次出现的行、列 1（与
 * IMAGE_SRC_NOT_BLOBS 报在指令行的口径一致）。
 * dataDir 缺省（seed-demo 无 DATA_DIR 语境、不关心该项的旧测试直调）时跳过
 * 核对——生产导入入口（路由 /import、/shared、MCP import_markdown）全部传参。
 * warning 不阻断 commit：保留「先导 md 后补图」的工作流，文案给出修复指引。
 */
function mediaImageExistenceIssues(
  markdown: string,
  dataDir?: string,
): LintIssue[] {
  if (dataDir === undefined) return [];
  return missingMediaImageSrcs(dataDir, [markdown]).map((src) => {
    const at = markdown.indexOf(src);
    const line = at < 0 ? 1 : markdown.slice(0, at).split("\n").length;
    return {
      level: "warning" as const,
      line,
      column: 1,
      code: "IMAGE_SRC_NOT_FOUND",
      message: `::image（第 ${line} 行）引用的图片文件不存在：${src}。请把本文件与其引用的图片（或整个文件夹）一起在导入页选择导入，系统会自动上传被引用的图片并替换引用；AI 生成或手写的哈希路径不会与真实文件对应，必须在随图导入时自动替换（或经 MCP upload_image 上传后用返回的新 src 替换）`,
      fix: "在导入页把 md 与其引用的图片一起选择（随行自动上传改写），或上传图片后用返回的 blobs/media/… src 替换原引用",
    };
  });
}

/**
 * 导入预览：摘要 + 全部 lint issues（含 IMAGE_SRC_NOT_FOUND
 * 图片存在性 warning）+ 动作清单（D19）与 warning（D18/D19）（不写库）。
 * folderId = 目标文件夹（null/缺省 = 未归类）。
 */
export function previewImport(
  db: Db,
  teacherId: string,
  input: ImportPreviewRequest,
  dataDir?: string,
): ImportPreviewData {
  const folderId = input.folderId ?? null;
  assertFolderExists(db, teacherId, folderId);
  return buildPreview(
    db,
    teacherId,
    input.markdown,
    folderId,
    fallbackUnitIdOf(input.filename),
    dataDir,
  );
}

// ---------- preview-batch：批量预览 + 跨文件冲突（D20，不写库） ----------

/** 单文件 markdown 的 UTF-8 字节数（D20：按原始 markdown 字节判定，不以 JSON 体积为准） */
function markdownBytes(markdown: string): number {
  return Buffer.byteLength(markdown, "utf8");
}

/** 批量规模上限校验（≤50 文件 / 单文件 ≤1MB / 合计 ≤10MB → 413 IMPORT_TOO_LARGE） */
function assertBatchLimits(
  files: readonly { path: string; markdown: string }[],
): void {
  if (files.length > IMPORT_MAX_FILES_PER_BATCH) {
    throw new HttpError(
      413,
      "IMPORT_TOO_LARGE",
      `单批最多导入 ${IMPORT_MAX_FILES_PER_BATCH} 个文件（当前 ${files.length} 个），请分批导入`,
    );
  }
  let total = 0;
  for (const file of files) {
    const size = markdownBytes(file.markdown);
    if (size > IMPORT_MAX_FILE_BYTES) {
      throw new HttpError(
        413,
        "IMPORT_TOO_LARGE",
        `文件「${file.path}」超过单文件 1 MB 上限，请拆分后再导入`,
      );
    }
    total += size;
  }
  if (total > IMPORT_MAX_BATCH_BYTES) {
    throw new HttpError(
      413,
      "IMPORT_TOO_LARGE",
      `单批 markdown 合计超过 10 MB 上限（当前约 ${Math.round(total / 1024 / 1024)} MB），请分批导入`,
    );
  }
}

/** 相对路径的直接父目录名（"/" 与 "\" 都按分隔符处理）；根目录文件返回 null */
function subdirNameOf(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return null; // 无分隔符（根目录）或以 / 开头的首段
  const subdir = normalized.slice(0, lastSlash).split("/").pop();
  return subdir !== undefined && subdir.length > 0 ? subdir : null;
}

/** 跨文件冲突检测（D20）：同 unit id / 同目标文件夹同名讲义 → 涉及文件都标红 */
function detectCrossFileConflicts(
  entries: ImportBatchFilePreview[],
): ImportBatchConflict[][] {
  const conflictsByIndex: ImportBatchConflict[][] = entries.map(() => []);

  // 同一 unit id 出现在多个文件
  const filesByUnitId = new Map<string, number[]>();
  for (const [index, entry] of entries.entries()) {
    for (const action of entry.preview.actions) {
      if (action.unitId === null) continue;
      const list = filesByUnitId.get(action.unitId);
      if (list === undefined) filesByUnitId.set(action.unitId, [index]);
      else list.push(index);
    }
  }
  for (const [unitId, indexes] of filesByUnitId) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      for (const other of indexes) {
        if (other === index) continue;
        conflictsByIndex[index]?.push({
          code: "DUPLICATE_UNIT_ID",
          message: `与「${entries[other]?.path ?? ""}」都定义了单元「${unitId}」，请合并到同一文件或修改 unit id`,
          otherPath: entries[other]?.path ?? "",
        });
      }
    }
  }

  // 同一目标文件夹下的同名讲义（目标文件夹标识：已有 id 或将新建的名字）
  const filesByLectureKey = new Map<string, number[]>();
  for (const [index, entry] of entries.entries()) {
    const folderKey =
      entry.folderId !== null
        ? `id:${entry.folderId}`
        : `name:${entry.folderName ?? ""}`;
    for (const action of entry.preview.actions) {
      if (action.unitId !== null) continue; // 讲义动作
      const key = `${folderKey}\0${action.title}`;
      const list = filesByLectureKey.get(key);
      if (list === undefined) filesByLectureKey.set(key, [index]);
      else list.push(index);
    }
  }
  for (const [key, indexes] of filesByLectureKey) {
    if (indexes.length < 2) continue;
    const title = key.split("\0")[1] ?? "";
    const firstIndex = indexes[0];
    const folderLabel =
      firstIndex === undefined
        ? "未归类"
        : (entries[firstIndex]?.folderName ?? "未归类");
    for (const index of indexes) {
      for (const other of indexes) {
        if (other === index) continue;
        conflictsByIndex[index]?.push({
          code: "DUPLICATE_LECTURE_TITLE",
          message: `与「${entries[other]?.path ?? ""}」在文件夹「${folderLabel}」下都定义了同名讲义「${title}」`,
          otherPath: entries[other]?.path ?? "",
        });
      }
    }
  }
  return conflictsByIndex;
}

/**
 * 批量导入预览（D20）：每文件预览（动作清单/警告/统计/issues）+ 跨文件冲突 +
 * autoFolderBySubdir 的目标文件夹解析（已存在同名复用、否则标记将新建）。
 * 不写库——「将新建」的文件夹在 commit（前端逐文件调用）时按 folderName 落地。
 * 匹配与文件夹解析都在本教师域内（D13，T2B.3）。
 * dataDir 传入时逐文件附 IMAGE_SRC_NOT_FOUND 图片存在性 warning（各自缺失各自报）。
 */
export function previewImportBatch(
  db: Db,
  teacherId: string,
  input: ImportPreviewBatchRequest,
  dataDir?: string,
): ImportPreviewBatchData {
  assertBatchLimits(input.files);
  const baseFolderId = input.folderId ?? null;
  assertFolderExists(db, teacherId, baseFolderId);
  const snapshot = loadLibrarySnapshot(db, new Date().toISOString(), teacherId);
  // T7.7：启用集整批查一次（循环内逐文件复用，不逐文件打库）
  const enabledCapabilities = getCapabilityProfile(
    db,
    teacherId,
  ).enabledCapabilities;
  // 名称 → id（同名取 order 首个，与 ensureCourseFolder 复用口径一致）
  const folderIdByName = new Map<string, string>();
  for (const [id, name] of snapshot.folderNameById) {
    if (!folderIdByName.has(name)) folderIdByName.set(name, id);
  }

  const entries: ImportBatchFilePreview[] = input.files.map((file) => {
    let folderId = baseFolderId;
    let folderToCreate = false;
    if (input.autoFolderBySubdir) {
      const subdir = subdirNameOf(file.path);
      if (subdir !== null) {
        const existingId = folderIdByName.get(subdir);
        folderId = existingId ?? null;
        folderToCreate = existingId === undefined;
      }
    }
    const folderName =
      folderId !== null
        ? (snapshot.folderNameById.get(folderId) ?? null)
        : folderToCreate
          ? subdirNameOf(file.path)
          : null;
    const { issues, parsed } = analyzeImport(file.markdown, {
      // 单元名锚定文件名（方案 §2）：批量路径取相对路径的 basename
      fallbackUnitId: fallbackUnitIdOf(file.path),
      enabledCapabilities,
    });
    const plan = buildImportPlan({ parsed, folderId, snapshot });
    return {
      path: file.path,
      folderId,
      folderName,
      folderToCreate,
      preview: {
        summary: summarizeParsed(parsed),
        issues: [
          ...issues,
          ...mediaImageExistenceIssues(file.markdown, dataDir),
        ],
        actions: [...plan.actions],
        warnings: [...plan.warnings],
      },
      conflicts: [],
      hasError: false,
    };
  });

  // 跨文件冲突（D20：视为 error，涉及文件都标红）
  const conflictsByIndex = detectCrossFileConflicts(entries);
  for (const [index, conflicts] of conflictsByIndex.entries()) {
    const entry = entries[index];
    if (entry === undefined) continue;
    entry.conflicts = conflicts;
    entry.hasError =
      conflicts.length > 0 ||
      entry.preview.issues.some((issue) => issue.level === "error");
  }
  return { files: entries };
}

// ---------- commit：lint 拒绝 + 事务落库 ----------

/**
 * 导入提交（单文件单事务）。有 error 级 issue 时抛 422 LINT_ERROR（extra._issues
 * 附错误列表，响应体为统一错误壳的超集）。
 *
 * T2B.3：teacherId = 会话教师，全部匹配/写入/课程与文件夹校验都在本教师域内
 * （D13：单元 (teacherId, dslId)、讲义 (teacherId, folderId, title)、题目
 * (teacherId, id)；越权 courseId/folderId → 404，与 D12 口径一致）。
 *
 * T2A.3 目标文件夹解析（D17：导入只进资源库；优先级从高到低）：
 * 1. folderId（含 null = 未归类；非 null 校验存在，404 FOLDER_NOT_FOUND）；
 * 2. folderName：按名称查找/新建（「按子目录自动建文件夹」与就地新建共用，
 *    同名已存在则复用，事务内落定）；
 * 3. courseId（T2A.1 兼容路径）：课程同名文件夹（无则建）+ 追加 course_items
 *    （讲义 visible=true、单元 visible=false；重复跳过不报错）；
 * 4. 全部缺省 → 未归类（folderId=null），**不创建任何课程**（「默认课程」自动
 *    创建分支已随 resolveCourseId 删除，防止与 D23-7 冲突）。
 * addToCourse（D17 快捷项）独立于归属：追加 course_items 到目标课程末尾
 * （visible 统一生效、幂等跳过），响应 courseId 返回该课程 id。
 * 成功返回导入统计报告（同时序列化进 imports.reportJson 留档，含
 * sourcePath/batchId/folderId）。
 */
export function commitImport(
  db: Db,
  teacherId: string,
  input: ImportCommitRequest,
  dataDir?: string,
  /** T7.7：批量导入路径整批查一次后传入；缺省本函数自查（单文件路径） */
  enabledCapabilities?: readonly CapabilitySwitch[],
): ImportCommitData {
  // 图片存在性核对与 lint 合并为完整 issue 集（IMAGE_SRC_NOT_FOUND 是 warning
  // 级、不阻断提交——保留「先导 md 后补图」的工作流，问题在预览响应可见）
  const { issues, parsed } = analyzeImport(input.markdown, {
    fallbackUnitId: fallbackUnitIdOf(input.filename),
    enabledCapabilities:
      enabledCapabilities ??
      getCapabilityProfile(db, teacherId).enabledCapabilities,
  });
  const allIssues = [
    ...issues,
    ...mediaImageExistenceIssues(input.markdown, dataDir),
  ];

  // error 级 issue → 拒绝写入（此时连文件夹/课程都不动）
  const errors = allIssues.filter((issue) => issue.level === "error");
  const first = errors[0];
  if (first !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `文档存在 ${errors.length} 个 error 级问题，请先修复后重试（第 ${first.line} 行：${first.message}）`,
      { _issues: errors },
    );
  }

  // ---- 事务外校验（fail fast，不占事务；课程/文件夹都须属本教师域） ----
  if (input.folderId !== undefined && input.folderId !== null) {
    assertFolderExists(db, teacherId, input.folderId);
  }
  let legacyCourseTitle: string | undefined;
  if (input.courseId !== undefined) {
    const course = db
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(
        and(eq(courses.teacherId, teacherId), eq(courses.id, input.courseId)),
      )
      .get();
    if (course === undefined) {
      throw new HttpError(404, "COURSE_NOT_FOUND", "指定的课程不存在");
    }
    legacyCourseTitle = course.title;
  }
  if (input.addToCourse !== undefined) {
    const course = db
      .select({ id: courses.id })
      .from(courses)
      .where(
        and(
          eq(courses.teacherId, teacherId),
          eq(courses.id, input.addToCourse.courseId),
        ),
      )
      .get();
    if (course === undefined) {
      throw new HttpError(
        404,
        "COURSE_NOT_FOUND",
        "「同时加入课程」指定的课程不存在",
      );
    }
  }

  return db.transaction((tx) => {
    const now = new Date().toISOString();
    const importId = crypto.randomUUID();

    // T7.8：教学包声明整份导入共享（讲义与单元各存一份；普通 MD = null——
    // 重导按新文件覆盖，无声明即清空）。形态来自 frontmatter 契约解析，
    // 写入侧无需再校验（lint 已过，error 级问题在上面被拒）。
    const teachingPackJson =
      parsed.frontmatter?.teachingPack === undefined
        ? null
        : JSON.stringify(parsed.frontmatter.teachingPack);

    // ---- 目标文件夹落定（见函数头注释的优先级） ----
    let folderId: string | null;
    if (input.folderId !== undefined) {
      folderId = input.folderId;
    } else if (input.folderName !== undefined) {
      // 按名称查找/新建（ensureCourseFolder = find-or-create by name，D20 复用口径）
      folderId = ensureCourseFolder(tx, input.folderName, now, teacherId).id;
    } else if (legacyCourseTitle !== undefined) {
      folderId = ensureCourseFolder(tx, legacyCourseTitle, now, teacherId).id;
    } else {
      folderId = null; // 未归类
    }

    // ---- 讲义：按 (teacherId, folderId, title) 匹配替换 markdown，无则插入 ----
    const lectureReports: ImportLectureReport[] = [];
    const lectureIdByTitle = new Map<string, string>();
    const folderLectures = tx
      .select({ id: lectures.id, title: lectures.title })
      .from(lectures)
      .where(
        and(
          eq(lectures.teacherId, teacherId),
          folderId === null
            ? isNull(lectures.folderId)
            : eq(lectures.folderId, folderId),
        ),
      )
      .all();
    for (const row of folderLectures) lectureIdByTitle.set(row.title, row.id);
    let nextLectureOrder = folderLectures.length;

    for (const lecture of parsed.lectures) {
      const existingId = lectureIdByTitle.get(lecture.title);
      if (existingId !== undefined) {
        // 命中即替换 markdown；软删行同时恢复（与题目「同 id 再导入即恢复」同口径）
        tx.update(lectures)
          .set({
            markdown: lecture.markdown,
            updatedAt: now,
            deletedAt: null,
            teachingPackJson,
          })
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
            teacherId,
            folderId,
            title: lecture.title,
            markdown: lecture.markdown,
            order: nextLectureOrder,
            updatedAt: now,
            teachingPackJson,
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

    // ---- 单元：按 (teacherId, id) 匹配（D13 域内匹配；id 来自 DSL，域内唯一）
    //      → 更新或插入 ----
    const unitReports: ImportUnitReport[] = [];
    const existingUnitIds = new Set(
      tx
        .select({ id: units.id })
        .from(units)
        .where(eq(units.teacherId, teacherId))
        .all()
        .map((row) => row.id),
    );
    let nextUnitOrder = tx
      .select({ id: units.id })
      .from(units)
      .where(
        and(
          eq(units.teacherId, teacherId),
          folderId === null
            ? isNull(units.folderId)
            : eq(units.folderId, folderId),
        ),
      )
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
            teachingPackJson,
          })
          .where(and(eq(units.teacherId, teacherId), eq(units.id, unit.id)))
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
            teacherId,
            folderId,
            lectureId,
            title: unit.title,
            topic: unit.topic ?? null,
            order: nextUnitOrder,
            updatedAt: now,
            teachingPackJson,
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

    // ---- 题目：id 已存在（含软删，视为恢复）→ 更新 + version+1；新 id → 插入 version=1。
    //      匹配与写入都带 teacherId（复合主键，D10/D13）----
    let insertedQuestions = 0;
    let updatedQuestions = 0;
    const existingQuestions = new Map(
      tx
        .select({ id: questions.id, version: questions.version })
        .from(questions)
        .where(eq(questions.teacherId, teacherId))
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
            .values({ id: question.id, teacherId, ...fields, version: 1 })
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
            .where(
              and(
                eq(questions.teacherId, teacherId),
                eq(questions.id, question.id),
              ),
            )
            .run();
          existingQuestions.set(question.id, existingVersion + 1);
          updatedQuestions += 1;
        }
        syncQuestionKnowledge(tx, question, knowledgeIdByName, teacherId);
      }
    }

    // ---- 追加课程目录条目：兼容路径（courseId，讲义可见、单元隐藏）与
    //      addToCourse（D17 快捷项，visible 统一）；重复资源幂等跳过（不走 409）。
    //      同一课程被两种参数同时指定时 addToCourse 优先（显式新语义覆盖兼容口径） ----
    const appendByKey = new Map<
      string,
      {
        courseId: string;
        kind: "lecture" | "unit";
        refId: string;
        visible: boolean;
      }
    >();
    const collectAppends = (
      courseId: string,
      lectureVisible: boolean,
      unitVisible: boolean,
    ): void => {
      for (const report of lectureReports) {
        appendByKey.set(`${courseId}:lecture:${report.id}`, {
          courseId,
          kind: "lecture",
          refId: report.id,
          visible: lectureVisible,
        });
      }
      for (const report of unitReports) {
        appendByKey.set(`${courseId}:unit:${report.id}`, {
          courseId,
          kind: "unit",
          refId: report.id,
          visible: unitVisible,
        });
      }
    };
    if (input.courseId !== undefined) {
      collectAppends(input.courseId, true, false); // T2A.1 兼容口径
    }
    if (input.addToCourse !== undefined) {
      collectAppends(
        input.addToCourse.courseId,
        input.addToCourse.visible,
        input.addToCourse.visible,
      );
    }
    // 各课程内 order 接在该课程现有条目末尾
    const nextOrderByCourse = new Map<string, number>();
    for (const append of appendByKey.values()) {
      let nextOrder = nextOrderByCourse.get(append.courseId);
      if (nextOrder === undefined) {
        nextOrder =
          tx
            .select({ order: courseItems.order })
            .from(courseItems)
            .where(eq(courseItems.courseId, append.courseId))
            .all()
            .reduce((max, row) => Math.max(max, row.order), -1) + 1;
      }
      tx.insert(courseItems)
        .values({
          id: crypto.randomUUID(),
          courseId: append.courseId,
          kind: append.kind,
          refId: append.refId,
          title: null,
          order: nextOrder,
          visible: append.visible,
          publishAt: null,
          createdAt: now,
        })
        // 幂等兜底：唯一约束 (courseId, kind, refId) 命中即跳过（已在本课程的资源不动）
        .onConflictDoNothing({
          target: [courseItems.courseId, courseItems.kind, courseItems.refId],
        })
        .run();
      nextOrderByCourse.set(append.courseId, nextOrder + 1);
    }

    // ---- imports 留档（原文 = 老师提交的原文；T2A.3 起含
    //      sourcePath/batchId/folderId）----
    const report: ImportCommitData = {
      importId,
      courseId: input.courseId ?? input.addToCourse?.courseId ?? null,
      folderId,
      units: unitReports,
      lectures: lectureReports,
      questions: { inserted: insertedQuestions, updated: updatedQuestions },
    };
    tx.insert(imports)
      .values({
        id: importId,
        teacherId,
        filename: input.filename,
        kind: parsed.frontmatter?.kind ?? "practice",
        rawMd: input.markdown,
        reportJson: JSON.stringify(report),
        sourcePath: input.sourcePath ?? null,
        batchId: input.batchId ?? null,
        folderId,
        createdAt: now,
      })
      .run();
    return report;
  });
}

// ---------- 批次回看（T2A.3，GET /api/teacher/import/batches/:batchId） ----------

/**
 * 批次记录回看：batchId 是前端在批量预览时生成的 UUID，逐文件 commit 携带；
 * 无任何成功记录（全部被跳过/失败）时返回空 files（200——合法批次）。
 * 按会话教师域过滤（D13）：乙查不到甲的批次（batchId 相同也只返回乙的记录）。
 */
export function getImportBatch(
  db: Db,
  teacherId: string,
  batchId: string,
): ImportBatchData {
  const rows = db
    .select()
    .from(imports)
    .where(and(eq(imports.teacherId, teacherId), eq(imports.batchId, batchId)))
    .orderBy(asc(imports.createdAt), asc(imports.id))
    .all();
  return {
    batchId,
    files: rows.map((row) => ({
      importId: row.id,
      filename: row.filename,
      sourcePath: row.sourcePath,
      folderId: row.folderId,
      createdAt: row.createdAt,
      report: JSON.parse(row.reportJson) as ImportCommitData,
    })),
  };
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
 * T2B.5：按会话教师域化（课程/题目/考点关联/讲义/单元全部域内读——复合主键后
 * 同 id 单元/题目分属不同教师，乙视角甲的内容零出现）。
 */
export function getContentTree(db: Db, teacherId: string): ContentTree {
  const allCourses = db
    .select()
    .from(courses)
    .where(eq(courses.teacherId, teacherId))
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
    .where(and(eq(questions.teacherId, teacherId), isNull(questions.deletedAt)))
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
    .where(eq(questionKnowledge.teacherId, teacherId))
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

  // 存活资源（软删过滤）一次读全；目录条目引用已删资源时直接跳过该条目（域内读，T2B.5）
  const lectureById = new Map(
    db
      .select({
        id: lectures.id,
        title: lectures.title,
        updatedAt: lectures.updatedAt,
      })
      .from(lectures)
      .where(and(eq(lectures.teacherId, teacherId), isNull(lectures.deletedAt)))
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
      .where(and(eq(units.teacherId, teacherId), isNull(units.deletedAt)))
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
export function getQuestionDetail(
  db: Db,
  teacherId: string,
  id: string,
): QuestionDetail {
  const row = db
    .select()
    .from(questions)
    .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
    .get();
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
    knowledge: knowledgeNamesOf(db, teacherId, row.id),
    sourceMd: row.sourceMd,
    version: row.version,
  };
}

/** 某题关联的考点名列表（按名称排序，与内容树口径一致；关联表按教师域过滤） */
function knowledgeNamesOf(
  db: Db,
  teacherId: string,
  questionId: string,
): string[] {
  return db
    .select({ name: knowledgePoints.name })
    .from(questionKnowledge)
    .innerJoin(
      knowledgePoints,
      eq(questionKnowledge.knowledgePointId, knowledgePoints.id),
    )
    .where(
      and(
        eq(questionKnowledge.teacherId, teacherId),
        eq(questionKnowledge.questionId, questionId),
      ),
    )
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
  teacherId: string,
  id: string,
  input: { sourceMd: string },
): QuestionUpdateData {
  const row = db
    .select()
    .from(questions)
    .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
    .get();
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
      .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
      .run();
    const knowledgeIdByName = loadKnowledgeIdByName(tx);
    syncQuestionKnowledge(tx, next, knowledgeIdByName, teacherId);
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
 * 历史作答/统计保留；重新导入同 id 题目即恢复）。已软删时幂等成功。域内取行（D12）。
 */
export function deleteQuestion(db: Db, teacherId: string, id: string): void {
  const row = db
    .select({ id: questions.id, deletedAt: questions.deletedAt })
    .from(questions)
    .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "QUESTION_NOT_FOUND", "题目不存在");
  }
  if (row.deletedAt !== null) return; // 幂等：重复删除同样成功
  db.update(questions)
    .set({ deletedAt: new Date().toISOString() })
    .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
    .run();
}

/** 读取讲义完整内容（编辑抽屉用）。markdown 含 H1 标题行（原文是真相）。域内取行 */
export function getLectureDetail(
  db: Db,
  teacherId: string,
  id: string,
): LectureDetail {
  const row = db
    .select()
    .from(lectures)
    .where(and(eq(lectures.teacherId, teacherId), eq(lectures.id, id)))
    .get();
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
  teacherId: string,
  id: string,
  input: { markdown: string },
): LectureUpdateData {
  const row = db
    .select()
    .from(lectures)
    .where(and(eq(lectures.teacherId, teacherId), eq(lectures.id, id)))
    .get();
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
export function deleteLecture(db: Db, teacherId: string, id: string): void {
  softDeleteLecture(db, teacherId, id);
}

/** reorder 各 kind 的元信息：错误码 + 中文名 + 存在活 id 集合（软删实体视同不存在；域内） */
function reorderLiveIds(
  db: Db,
  teacherId: string,
  kind: ReorderRequest["kind"],
): { code: string; entityName: string; ids: Set<string> } {
  const meta = {
    question: { code: "QUESTION_NOT_FOUND", entityName: "题目" },
    lecture: { code: "LECTURE_NOT_FOUND", entityName: "讲义" },
    unit: { code: "UNIT_NOT_FOUND", entityName: "单元" },
    course: { code: "COURSE_NOT_FOUND", entityName: "课程" },
  }[kind];
  // course 的域化属 T2B.4（课程域隔离）；question/lecture/unit 自 T2B.3 起域内
  const ids =
    kind === "question"
      ? db
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(
              eq(questions.teacherId, teacherId),
              isNull(questions.deletedAt),
            ),
          )
          .all()
      : kind === "lecture"
        ? db
            .select({ id: lectures.id })
            .from(lectures)
            .where(
              and(
                eq(lectures.teacherId, teacherId),
                isNull(lectures.deletedAt),
              ),
            )
            .all()
        : kind === "unit"
          ? db
              .select({ id: units.id })
              .from(units)
              .where(
                and(eq(units.teacherId, teacherId), isNull(units.deletedAt)),
              )
              .all()
          : db.select({ id: courses.id }).from(courses).all();
  return { ...meta, ids: new Set(ids.map((row) => row.id)) };
}

/**
 * 讲义/单元全局排序后，把各课程内同类目录条目的顺序同步为新相对顺序。
 * 槽位保持：条目只在本课程同类条目已占据的 order 槽位内重排——与分节/其他类型
 * 条目的交错关系不变（course_items.order 是全 kind 共用一个序列）。
 * 已删资源不在全局顺序中（排最末，保持其原相对顺序——sort 稳定）。
 * T2B.3：资源位置图与课程循环都限定本教师域（乙排序不得改写甲的课程条目）。
 */
function reorderCourseItemSlots(
  db: Db,
  teacherId: string,
  kind: "lecture" | "unit",
): void {
  const resourceIds =
    kind === "lecture"
      ? db
          .select({ id: lectures.id })
          .from(lectures)
          .where(
            and(eq(lectures.teacherId, teacherId), isNull(lectures.deletedAt)),
          )
          .orderBy(asc(lectures.order), asc(lectures.title))
          .all()
          .map((row) => row.id)
      : db
          .select({ id: units.id })
          .from(units)
          .where(and(eq(units.teacherId, teacherId), isNull(units.deletedAt)))
          .orderBy(asc(units.order), asc(units.title))
          .all()
          .map((row) => row.id);
  const position = new Map(
    resourceIds.map((id, index) => [id, index] as const),
  );

  // 只处理本教师的课程（join courses 判归属；course 的完整域化属 T2B.4）
  const courseIds = [
    ...new Set(
      db
        .select({ courseId: courseItems.courseId })
        .from(courseItems)
        .innerJoin(courses, eq(courseItems.courseId, courses.id))
        .where(
          and(eq(courseItems.kind, kind), eq(courses.teacherId, teacherId)),
        )
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
 * 任一 id 不存在或不属本教师（题目/讲义/单元软删视同不存在）→ 404，
 * 事务回滚保持原顺序。
 * 讲义/单元排序同时同步各课程目录条目的相对顺序（T2A.1 起内容页顺序取自
 * course_items，见 reorderCourseItemSlots）。course kind 的域化属 T2B.4。
 */
export function reorderContent(
  db: Db,
  teacherId: string,
  input: ReorderRequest,
): void {
  const {
    code,
    entityName,
    ids: liveIds,
  } = reorderLiveIds(db, teacherId, input.kind);
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
          .where(and(eq(questions.teacherId, teacherId), eq(questions.id, id)))
          .run();
      } else if (input.kind === "lecture") {
        tx.update(lectures)
          .set({ order: index })
          .where(and(eq(lectures.teacherId, teacherId), eq(lectures.id, id)))
          .run();
      } else if (input.kind === "unit") {
        tx.update(units)
          .set({ order: index })
          .where(and(eq(units.teacherId, teacherId), eq(units.id, id)))
          .run();
      } else {
        tx.update(courses)
          .set({ order: index })
          .where(eq(courses.id, id))
          .run();
      }
    }
  });
  if (input.kind === "lecture" || input.kind === "unit") {
    reorderCourseItemSlots(db, teacherId, input.kind);
  }
}

/**
 * 新建课程（POST /api/teacher/courses）：order 追加到末尾（T2B.4：按会话教师的
 * 课程数计数，写 courses.teacherId）；description 可选（T2A.4）。
 */
export function createCourse(
  db: Db,
  teacherId: string,
  input: { title: string; description?: string | null | undefined },
): CourseData {
  const count = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.teacherId, teacherId))
    .all().length;
  const id = crypto.randomUUID();
  const order = count;
  const description =
    input.description !== undefined && input.description !== null
      ? input.description
      : null;
  db.insert(courses)
    .values({
      id,
      teacherId,
      title: input.title,
      order,
      description,
      createdAt: new Date().toISOString(),
    })
    .run();
  return {
    id,
    title: input.title,
    order,
    description,
    archived: false,
    archivedAt: null,
  };
}

/**
 * 课程更新（PATCH /api/teacher/courses/:id，T2A.4 扩展）：
 * - name / title 同义（name 为 Phase 2A 术语口径，title 兼容旧调用方），缺省 = 不改；
 * - description 显式 null = 清空；archived：true 归档（D4，学生端不可见）、false 恢复。
 * T2B.4：按会话教师取课程行（非本人课程 → 404 COURSE_NOT_FOUND，D12）。
 */
export function updateCourse(
  db: Db,
  teacherId: string,
  id: string,
  input: CourseUpdateRequest,
): CourseData {
  const row = db
    .select()
    .from(courses)
    .where(and(eq(courses.teacherId, teacherId), eq(courses.id, id)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  const patch: Partial<typeof courses.$inferInsert> = {};
  const title = input.name ?? input.title;
  if (title !== undefined && title !== row.title) {
    patch.title = title;
  }
  if (input.description !== undefined) {
    patch.description =
      input.description === null || input.description.length === 0
        ? null
        : input.description;
  }
  if (input.archived !== undefined) {
    // true 归档（已归档保持原时间，幂等）；false 恢复（置 null）
    patch.archivedAt = input.archived
      ? (row.archivedAt ?? new Date().toISOString())
      : null;
  }
  if (Object.keys(patch).length > 0) {
    db.update(courses).set(patch).where(eq(courses.id, id)).run();
  }
  return {
    id,
    title: patch.title ?? row.title,
    order: row.order,
    description:
      patch.description !== undefined ? patch.description : row.description,
    archived:
      patch.archivedAt !== undefined
        ? patch.archivedAt !== null
        : row.archivedAt !== null,
    archivedAt:
      patch.archivedAt !== undefined ? patch.archivedAt : row.archivedAt,
  };
}

/**
 * 课程删除（DELETE /api/teacher/courses/:id，D4，T2A.4 起语义升级）：
 * 仅在该课程**没有作答记录且没有按课程布置的作业**时允许（判定见
 * CourseService.courseHasAttempts——attempts.courseId OR assignments.courseId，
 * 保守口径），否则 409 COURSE_HAS_ATTEMPTS（提示改用归档）。删除不触碰
 * 资源库内容（D1 引用制），目录条目与成员随课程一并清理，成功后资源库原样保留。
 * T2B.4：按会话教师取课程行（非本人课程 → 404 COURSE_NOT_FOUND，D12）。
 */
export function deleteCourse(db: Db, teacherId: string, id: string): void {
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.teacherId, teacherId), eq(courses.id, id)))
    .get();
  if (row === undefined) {
    throw new HttpError(404, "COURSE_NOT_FOUND", "课程不存在");
  }
  if (courseHasAttempts(db, id)) {
    throw new HttpError(
      409,
      "COURSE_HAS_ATTEMPTS",
      "该课程已有作答记录或布置的作业，不能删除；请改用归档（归档后学生看不到，数据保留）",
    );
  }
  db.transaction((tx) => {
    tx.delete(courseItems).where(eq(courseItems.courseId, id)).run();
    tx.delete(courseStudents).where(eq(courseStudents.courseId, id)).run();
    tx.delete(courses).where(eq(courses.id, id)).run();
  });
}

// ---------- 学生端：讲义（T2.3 起服务入口；T2A.5 迁移至 student-course-service） ----------
// T2A.5 核心切换：学生端可见性模型从「全量讲义 + deletedAt 过滤」窗口期实现切换到
// D5（课程成员 + 目录条目可见），listStudentLectures / getStudentLecture 已迁至
// student-course-service.ts（复用 listVisibleItems → canStudentSeeItem 唯一判定）。
