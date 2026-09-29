import type {
  ImportAction,
  ImportPreviewWarning,
  ParsedDocument,
} from "@tutor/contract";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  assignmentUnits,
  lectures,
  libraryFolders,
  questions,
  units,
} from "../db/schema";

/**
 * 导入动作清单（D19）与预览 warning（D18/D19）的计算模块（T2A.3）。
 *
 * buildImportPlan 是纯函数：输入「解析结果 + 库内资源快照 + 目标文件夹」，输出
 * 动作清单与 warning，不触碰数据库——preview 与 preview-batch 复用同一份逻辑，
 * 且可直接单测（快照用字面量构造）。
 * loadLibrarySnapshot 负责把库读成快照（唯一 IO 点）。
 *
 * 口径与 commitImport 的写入逻辑严格一致（content-service）：
 * - 单元按 DSL unit id 全局匹配；命中保留原文件夹（D18）；
 * - 讲义按 (目标文件夹, 标题) 匹配（D18）；
 * - 题目同 id 更新 version+1，文件中缺失的已有题目保留（D18）；软删题再导入
 *   即恢复（按 updated 计）；
 * - 配套讲义指针（frontmatter lecture）：目标文件夹已有讲义或本文件产出讲义
 *   （title 覆盖后的值）按名字匹配；都未命中 → LECTURE_LINK_UNRESOLVED warning
 *   （内容模型与导入规范化方案 §4；commit 匹配不到仍静默 lectureId=null）；
 * - 命中回收站资源 → restore=true（自动恢复，D18）。
 */

/** 库内单元快照 */
export interface SnapshotUnit {
  /** 单元当前所在文件夹；null = 未归类 */
  readonly folderId: string | null;
  /** 软删时间；null = 未删除（回收站中的单元命中导入即恢复） */
  readonly deletedAt: string | null;
  /** 全部题目 id（含软删；inserted/updated 判定与 commit 的全量查询同口径） */
  readonly allQuestionIds: ReadonlySet<string>;
  /** 未删除题目 id（kept 计数：文件中未出现的未删题保留不删） */
  readonly liveQuestionIds: ReadonlySet<string>;
}

/** 库内讲义快照 */
export interface SnapshotLecture {
  readonly id: string;
  readonly title: string;
  /** 所在文件夹；null = 未归类 */
  readonly folderId: string | null;
  /** 软删时间；null = 未删除 */
  readonly deletedAt: string | null;
}

/** 库内资源快照（buildImportPlan 的输入；loadLibrarySnapshot 产出） */
export interface LibrarySnapshot {
  /** 单元 id → 快照 */
  readonly units: ReadonlyMap<string, SnapshotUnit>;
  /** 全部讲义（(folderId, title) 匹配与跨文件夹同名检查都用它，量级小直接线性扫） */
  readonly lectures: readonly SnapshotLecture[];
  /** 文件夹 id → 名称 */
  readonly folderNameById: ReadonlyMap<string, string>;
  /** 单元 id → 未截止（未删除且 dueAt 为空或未到）的作业数 */
  readonly openAssignmentCountByUnitId: ReadonlyMap<string, number>;
}

/** buildImportPlan 的输入 */
export interface ImportPlanInput {
  /** 解析结果（analyzeImport 的 parsed；issues 不参与动作计算） */
  readonly parsed: ParsedDocument;
  /** 本次导入的目标文件夹 id；null = 未归类（新资源落这里；已有单元保留原文件夹） */
  readonly folderId: string | null;
  readonly snapshot: LibrarySnapshot;
}

/** buildImportPlan 的输出（对应契约 importPreviewDataSchema 的 actions/warnings） */
export interface ImportPlan {
  readonly actions: readonly ImportAction[];
  readonly warnings: readonly ImportPreviewWarning[];
}

/** 快照内的文件夹名（folderId 非空但文件夹行缺失时兜底 null = 未归类展示） */
function folderNameOf(
  snapshot: LibrarySnapshot,
  folderId: string | null,
): string | null {
  if (folderId === null) return null;
  return snapshot.folderNameById.get(folderId) ?? null;
}

/**
 * 计算动作清单与 warning（纯函数，D18/D19）。
 * 顺序：先讲义后单元（与 commitImport 的写入顺序一致，展示顺序稳定）。
 */
export function buildImportPlan(input: ImportPlanInput): ImportPlan {
  const { parsed, folderId, snapshot } = input;
  const actions: ImportAction[] = [];
  const warnings: ImportPreviewWarning[] = [];
  const targetFolderName = folderNameOf(snapshot, folderId);

  // ---- 讲义：按 (目标文件夹, 标题) 匹配（D18） ----
  for (const lecture of parsed.lectures) {
    const existing = snapshot.lectures.find(
      (row) => row.folderId === folderId && row.title === lecture.title,
    );
    if (existing !== undefined) {
      actions.push({
        kind: "updateLecture",
        title: lecture.title,
        unitId: null,
        folderName: targetFolderName,
        restore: existing.deletedAt !== null,
      });
      continue;
    }
    actions.push({
      kind: "createLecture",
      title: lecture.title,
      unitId: null,
      folderName: targetFolderName,
      restore: false,
    });
    // 其他文件夹已有同名讲义 → 重复导入提醒（D18 warning）
    for (const other of snapshot.lectures) {
      if (other.folderId === folderId || other.title !== lecture.title)
        continue;
      const otherName = folderNameOf(snapshot, other.folderId);
      warnings.push({
        code: "DUPLICATE_LECTURE_TITLE_IN_OTHER_FOLDER",
        message: `资源库「${otherName ?? "未归类"}」已有同名讲义「${lecture.title}」，确认不是重复导入`,
      });
    }
  }

  // ---- 单元：按 DSL unit id 全局匹配（D18） ----
  for (const unit of parsed.units) {
    // 配套讲义指针解析（内容模型与导入规范化方案 §4）：按最终讲义名匹配
    // 目标文件夹内已有讲义（快照口径与 commit 一致，含回收站行）或本文件解析
    // 产出的讲义（title 覆盖后的值）；两者皆无 → warning（不阻断导入；commit
    // 行为不变：匹配不到仍静默 lectureId=null）
    const { lectureTitle } = unit;
    if (lectureTitle !== undefined) {
      const inTargetFolder = snapshot.lectures.some(
        (row) => row.folderId === folderId && row.title === lectureTitle,
      );
      const inThisFile = parsed.lectures.some(
        (lecture) => lecture.title === lectureTitle,
      );
      if (!inTargetFolder && !inThisFile) {
        warnings.push({
          code: "LECTURE_LINK_UNRESOLVED",
          message: `配套讲义「${lectureTitle}」在目标文件夹与本文件中都未找到：练习将暂不关联讲义；若讲义在其他文件夹或尚未导入，请调整后再试`,
        });
      }
    }

    const existing = snapshot.units.get(unit.id);
    if (existing === undefined) {
      actions.push({
        kind: "createUnit",
        title: unit.title,
        unitId: unit.id,
        folderName: targetFolderName,
        restore: false,
      });
      continue;
    }

    // 更新单元：题目细分（与 commit 的 inserted/updated 判定同口径——含软删）
    let inserted = 0;
    let updated = 0;
    for (const question of unit.questions) {
      if (existing.allQuestionIds.has(question.id)) updated += 1;
      else inserted += 1;
    }
    // kept：库中未删除、文件中未出现的题目数（保留不删，D18）
    const fileQuestionIds = new Set(unit.questions.map((q) => q.id));
    let kept = 0;
    for (const id of existing.liveQuestionIds) {
      if (!fileQuestionIds.has(id)) kept += 1;
    }
    actions.push({
      kind: "updateUnit",
      title: unit.title,
      unitId: unit.id,
      // 命中已有单元保留其原文件夹（D18），预览标注「更新（位于文件夹 X）」
      folderName: folderNameOf(snapshot, existing.folderId),
      restore: existing.deletedAt !== null,
      questions: { inserted, updated, kept },
    });
    if (kept > 0) {
      warnings.push({
        code: "KEPT_QUESTIONS",
        message: `单元「${unit.title}」文件中未出现的 ${kept} 道已有题目将保留`,
      });
    }
    // 被未截止作业使用 → 新版本影响未交卷学生（D19 warning）
    const openCount = snapshot.openAssignmentCountByUnitId.get(unit.id) ?? 0;
    if (openCount > 0) {
      warnings.push({
        code: "UNIT_USED_BY_OPEN_ASSIGNMENTS",
        message: `该单元「${unit.title}」被 ${openCount} 个未截止作业使用：已交卷学生不受影响，未交卷学生将看到新版本`,
      });
    }
  }

  return { actions, warnings };
}

/**
 * 读库生成资源快照（buildImportPlan 的唯一 IO 来源）。
 * nowIso 用于「未截止作业」判定：未删除且（无截止或截止时间未到）。
 * teacherId（T2B.1/D13）：单元、题目、讲义、文件夹与未截止作业计数全部按教师域
 * 过滤——复合主键 (teacherId, id) 下同 id 可能存在于多个域，匹配快照只取本教师
 * 域的行（单教师期与原行为等价；T2B.3 起调用方传会话教师）。
 */
export function loadLibrarySnapshot(
  db: Db,
  nowIso: string,
  teacherId: string,
): LibrarySnapshot {
  const folderNameById = new Map(
    db
      .select({ id: libraryFolders.id, name: libraryFolders.name })
      .from(libraryFolders)
      .where(eq(libraryFolders.teacherId, teacherId))
      .all()
      .map((row) => [row.id, row.name] as const),
  );

  // 各单元的题目 id（全量含软删 → inserted/updated；未删 → kept）
  const allByUnit = new Map<string, Set<string>>();
  const liveByUnit = new Map<string, Set<string>>();
  for (const row of db
    .select({
      unitId: questions.unitId,
      id: questions.id,
      deletedAt: questions.deletedAt,
    })
    .from(questions)
    .where(eq(questions.teacherId, teacherId))
    .all()) {
    let all = allByUnit.get(row.unitId);
    if (all === undefined) {
      all = new Set();
      allByUnit.set(row.unitId, all);
    }
    all.add(row.id);
    if (row.deletedAt !== null) continue;
    let live = liveByUnit.get(row.unitId);
    if (live === undefined) {
      live = new Set();
      liveByUnit.set(row.unitId, live);
    }
    live.add(row.id);
  }

  const unitSnapshot = new Map<string, SnapshotUnit>();
  for (const row of db
    .select({
      id: units.id,
      folderId: units.folderId,
      deletedAt: units.deletedAt,
    })
    .from(units)
    .where(eq(units.teacherId, teacherId))
    .all()) {
    unitSnapshot.set(row.id, {
      folderId: row.folderId,
      deletedAt: row.deletedAt,
      allQuestionIds: allByUnit.get(row.id) ?? new Set<string>(),
      liveQuestionIds: liveByUnit.get(row.id) ?? new Set<string>(),
    });
  }

  const lectureRows = db
    .select({
      id: lectures.id,
      title: lectures.title,
      folderId: lectures.folderId,
      deletedAt: lectures.deletedAt,
    })
    .from(lectures)
    .where(eq(lectures.teacherId, teacherId))
    .all();

  // 未截止作业按单元计数（T2A.7 起走 assignment_units 关联；D19 warning 数据源；
  // 只数本教师的作业——同 dslId 单元在其他教师域的作业与本次导入无关，D13）
  const openAssignmentCountByUnitId = new Map<string, number>();
  for (const row of db
    .select({ unitId: assignmentUnits.unitId })
    .from(assignmentUnits)
    .innerJoin(assignments, eq(assignmentUnits.assignmentId, assignments.id))
    .where(
      and(
        eq(assignments.teacherId, teacherId),
        isNull(assignments.deletedAt),
        or(isNull(assignments.dueAt), gt(assignments.dueAt, nowIso)),
      ),
    )
    .all()) {
    openAssignmentCountByUnitId.set(
      row.unitId,
      (openAssignmentCountByUnitId.get(row.unitId) ?? 0) + 1,
    );
  }

  return {
    units: unitSnapshot,
    lectures: lectureRows,
    folderNameById,
    openAssignmentCountByUnitId,
  };
}
