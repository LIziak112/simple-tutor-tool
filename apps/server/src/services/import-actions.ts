import type {
  ImportAction,
  ImportPreviewWarning,
  ParsedDocument,
} from "@tutor/contract";
import { hasExplicitQuestionId } from "@tutor/md-dsl";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assignments,
  assignmentUnits,
  lectures,
  libraryFolders,
  materialRefs,
  materials,
  questionGroups,
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
  readonly folderId: string | null;
  /** 软删时间；null = 未删除（回收站中的单元命中导入即恢复） */
  readonly deletedAt: string | null;
  /** 挂载讲义（units.lectureId）；讲练页嵌入单元接管预检用 */
  readonly lectureId: string | null;
  /** 单元标题（warning 文案用） */
  readonly title: string;
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
  /** 讲义形态（讲练页嵌入单元接管只对 kind='lesson' 讲义生效） */
  readonly kind: "lecture" | "lesson";
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
  /**
   * 材料 id → 快照（tt-06b / QM-05：同 id 匹配 + 跨单元移动警告 +
   * UNKNOWN_MATERIAL_REF 教师域解析）。含软删行（重导恢复判定）。
   */
  readonly materials: ReadonlyMap<string, SnapshotQmEntity>;
  /** 题组 id → 快照（同上） */
  readonly groups: ReadonlyMap<string, SnapshotQmEntity>;
  /** 材料 id → 引用它的 owner 清单（跨单元移动的受影响引用数；含全部 ownerKind） */
  readonly materialRefOwners: ReadonlyMap<
    string,
    ReadonlyArray<{ ownerKind: "group" | "question"; ownerId: string }>
  >;
  /** 教师域存活（未软删）材料 id 集（UNKNOWN_MATERIAL_REF 降级判定） */
  readonly liveMaterialIds: ReadonlySet<string>;
}

/** 材料/组的库内快照（QM 实体；unitId 供跨单元移动判定） */
export interface SnapshotQmEntity {
  readonly unitId: string;
  readonly deletedAt: string | null;
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
  /** 命中的快照讲义（title → 行）：接管预检复用同一匹配，不再二次扫描 */
  const matchedLectureByTitle = new Map<string, SnapshotLecture>();
  for (const lecture of parsed.lectures) {
    const existing = snapshot.lectures.find(
      (row) => row.folderId === folderId && row.title === lecture.title,
    );
    if (existing !== undefined) {
      matchedLectureByTitle.set(lecture.title, existing);
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

  // ---- 讲练页嵌入单元接管预检（2026-10-28 修复；与 commitImport 接管段同口径）----
  // lesson 文档重导命中同名讲练页（快照 kind=lesson）时：未挂载的旧嵌入单元将
  // 软删、挂载单元内缺席题将移出——warning 亮给教师与 MCP AI（dry-run 可见）。
  // 嵌入单元不发 KEPT_QUESTIONS（「保留」与实际「移出」矛盾，计数由接管 warning 承载）。
  const embeddedTakeoverUnitIds = new Set<string>();
  if (parsed.frontmatter?.kind === "lesson") {
    for (const lecture of parsed.lectures) {
      const existing = matchedLectureByTitle.get(lecture.title);
      if (existing === undefined || existing.kind !== "lesson") continue;
      // 本文件挂载到该讲练页的单元（一次过滤取对象，id 集与文件题集都从对象直接取）
      const attachedUnits = parsed.units.filter(
        (unit) => unit.lectureTitle === lecture.title,
      );
      const attachedUnitIds = new Set(attachedUnits.map((unit) => unit.id));
      for (const [unitId, unit] of snapshot.units) {
        if (unit.deletedAt !== null || unit.lectureId !== existing.id) continue;
        if (attachedUnitIds.has(unitId)) continue;
        warnings.push({
          code: "LESSON_EMBEDDED_UNIT_SUPERSEDED",
          message: `讲练页「${lecture.title}」的旧随堂练习单元「${unit.title}」将被替换（移入回收站，作答历史保留）`,
        });
      }
      for (const attachedUnit of attachedUnits) {
        const existingUnit = snapshot.units.get(attachedUnit.id);
        if (existingUnit === undefined) continue; // 新单元无既有题可移出
        const fileQuestionIds = new Set(
          attachedUnit.questions.map((question) => question.id),
        );
        let removed = 0;
        for (const id of existingUnit.liveQuestionIds) {
          if (!fileQuestionIds.has(id)) removed += 1;
        }
        if (removed > 0) {
          warnings.push({
            code: "LESSON_EMBEDDED_QUESTIONS_SUPERSEDED",
            message: `随堂练习单元「${existingUnit.title}」中 ${removed} 道不在本次讲练页的题目将移出（移入回收站）`,
          });
          embeddedTakeoverUnitIds.add(attachedUnit.id);
        }
      }
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

    // ---- 材料/组动作（tt-06b / QM-05：按 (teacherId, id) 匹配，单元内文档序；
    //      新建与既有单元都产出——材料/组是单元的叠加元数据，不随单元新建跳过） ----
    for (const material of unit.materials ?? []) {
      const existingMaterial = snapshot.materials.get(material.id);
      const displayTitle = material.title ?? `材料 ${material.id}`;
      if (existingMaterial === undefined) {
        actions.push({
          kind: "createMaterial",
          title: displayTitle,
          unitId: unit.id,
          folderName: targetFolderName,
          restore: false,
        });
        continue;
      }
      actions.push({
        kind: "updateMaterial",
        title: displayTitle,
        unitId: unit.id,
        // 材料/组按单元归属展示所在文件夹（其所属单元的当前文件夹）
        folderName: folderNameOf(
          snapshot,
          snapshot.units.get(existingMaterial.unitId)?.folderId ?? null,
        ),
        restore: existingMaterial.deletedAt !== null,
      });
      // 跨单元移动：同 id 材料已在其他单元（§4.3 预览必须提示移动及引用影响）
      if (
        existingMaterial.unitId !== unit.id &&
        existingMaterial.deletedAt === null
      ) {
        const owners = snapshot.materialRefOwners.get(material.id) ?? [];
        warnings.push({
          code: "MATERIAL_MOVED_ACROSS_UNITS",
          message: `材料「${material.id}」当前在单元「${existingMaterial.unitId}」，本次导入将移动到单元「${unit.id}」；${owners.length} 处组/题引用仍指向该材料（引用按 id 解析不断链，但请确认移动符合预期）`,
        });
      }
    }
    for (const group of unit.groups ?? []) {
      const existingGroup = snapshot.groups.get(group.id);
      const displayTitle = group.title ?? `题组 ${group.id}`;
      if (existingGroup === undefined) {
        actions.push({
          kind: "createGroup",
          title: displayTitle,
          unitId: unit.id,
          folderName: targetFolderName,
          restore: false,
        });
        continue;
      }
      actions.push({
        kind: "updateGroup",
        title: displayTitle,
        unitId: unit.id,
        folderName: folderNameOf(
          snapshot,
          snapshot.units.get(existingGroup.unitId)?.folderId ?? null,
        ),
        restore: existingGroup.deletedAt !== null,
      });
      if (
        existingGroup.unitId !== unit.id &&
        existingGroup.deletedAt === null
      ) {
        warnings.push({
          code: "MATERIAL_MOVED_ACROSS_UNITS",
          message: `题组「${group.id}」当前在单元「${existingGroup.unitId}」，本次导入将移动到单元「${unit.id}」；组内子题引用按 id 解析不受影响，请确认移动符合预期`,
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
    // updated 中「文件里未写显式 id（缺省派生）」的题数（P2b 错位预警面）：
    // 缺省 id 按 单元id-序号 由文档内位置推导，文件里插题/删题会使后续题错位
    // 更新到别的题、学情张冠李戴——围栏带 id=（显式或 lesson 导出注入）不算
    let updatedDerived = 0;
    for (const question of unit.questions) {
      if (existing.allQuestionIds.has(question.id)) {
        updated += 1;
        if (!hasExplicitQuestionId(question.sourceMd)) updatedDerived += 1;
      } else {
        inserted += 1;
      }
    }
    // kept：库中未删除、文件中未出现的题目数（保留不删，D18）。讲练页挂载单元
    // 走接管语义（缺席题移出回收站）——kept 记 0，移出计数由接管 warning 承载
    const fileQuestionIds = new Set(unit.questions.map((q) => q.id));
    let kept = 0;
    for (const id of existing.liveQuestionIds) {
      if (!fileQuestionIds.has(id)) kept += 1;
    }
    const embeddedTakeover = embeddedTakeoverUnitIds.has(unit.id);
    actions.push({
      kind: "updateUnit",
      title: unit.title,
      unitId: unit.id,
      // 命中已有单元保留其原文件夹（D18），预览标注「更新（位于文件夹 X）」
      folderName: folderNameOf(snapshot, existing.folderId),
      restore: existing.deletedAt !== null,
      questions: {
        inserted,
        updated,
        kept: embeddedTakeover ? 0 : kept,
        ...(updatedDerived > 0 ? { updatedDerived } : {}),
      },
    });
    if (updatedDerived > 0) {
      warnings.push({
        code: "DERIVED_ID_UPDATED_QUESTIONS",
        message: `单元「${unit.title}」有 ${updatedDerived} 道题使用缺省题号且将更新既有题：文件中插题/删题会使题号错位、学情张冠李戴；建议先导出一次（自动注入题号）再修改，或为题容器补显式 id`,
      });
    }
    if (kept > 0 && !embeddedTakeover) {
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
      title: units.title,
      folderId: units.folderId,
      lectureId: units.lectureId,
      deletedAt: units.deletedAt,
    })
    .from(units)
    .where(eq(units.teacherId, teacherId))
    .all()) {
    unitSnapshot.set(row.id, {
      title: row.title,
      folderId: row.folderId,
      lectureId: row.lectureId,
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
      kind: lectures.kind,
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

  // tt-06b / QM-05：材料/组快照（同 id 匹配与跨单元移动）、引用反查、存活材料集
  const materialSnapshot = new Map<string, SnapshotQmEntity>();
  const liveMaterialIds = new Set<string>();
  for (const row of db
    .select({
      id: materials.id,
      unitId: materials.unitId,
      deletedAt: materials.deletedAt,
    })
    .from(materials)
    .where(eq(materials.teacherId, teacherId))
    .all()) {
    materialSnapshot.set(row.id, {
      unitId: row.unitId,
      deletedAt: row.deletedAt,
    });
    if (row.deletedAt === null) liveMaterialIds.add(row.id);
  }
  const groupSnapshot = new Map<string, SnapshotQmEntity>();
  for (const row of db
    .select({
      id: questionGroups.id,
      unitId: questionGroups.unitId,
      deletedAt: questionGroups.deletedAt,
    })
    .from(questionGroups)
    .where(eq(questionGroups.teacherId, teacherId))
    .all()) {
    groupSnapshot.set(row.id, {
      unitId: row.unitId,
      deletedAt: row.deletedAt,
    });
  }
  const materialRefOwners = new Map<
    string,
    Array<{ ownerKind: "group" | "question"; ownerId: string }>
  >();
  for (const row of db
    .select({
      materialId: materialRefs.materialId,
      ownerKind: materialRefs.ownerKind,
      ownerId: materialRefs.ownerId,
    })
    .from(materialRefs)
    .where(eq(materialRefs.teacherId, teacherId))
    .all()) {
    const list = materialRefOwners.get(row.materialId);
    const entry = { ownerKind: row.ownerKind, ownerId: row.ownerId };
    if (list === undefined) materialRefOwners.set(row.materialId, [entry]);
    else list.push(entry);
  }

  return {
    units: unitSnapshot,
    lectures: lectureRows,
    folderNameById,
    openAssignmentCountByUnitId,
    materials: materialSnapshot,
    groups: groupSnapshot,
    materialRefOwners,
    liveMaterialIds,
  };
}
