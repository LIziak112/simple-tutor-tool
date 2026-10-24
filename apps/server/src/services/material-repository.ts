import type {
  Material,
  MaterialPublic,
  MaterialRef,
  QuestionGroup,
  QuestionGroupPublic,
} from "@tutor/contract";
import { and, asc, eq, isNull, isNotNull, or } from "drizzle-orm";
// 本模块被导入/重导（QM-05）与开卷冻结（QM-06/TT-07）共用，也可能被 reparse CLI
// （Node 24 原生类型剥离运行）经服务层间接导入——相对导入带 .ts 扩展名（仓库约定）
import type { Db } from "../db/client.ts";
import {
  type AttemptContextSnapshotRow,
  attemptContextSnapshots,
  type MaterialRow,
  materials,
  materialRefs,
  questions,
  type QuestionGroupRow,
  questionGroupMembers,
  questionGroups,
} from "../db/schema.ts";

/**
 * 材料/组/引用索引/冻结快照的仓储层（tt-05b / QM-03）。
 *
 * 职责边界（决策记录 §5.2 / 设计方案 §5.1/§5.2）：
 * - **教师域过滤在仓储层强制**：本模块全部读写按 (teacherId, id) 定位，调用方
 *   不传教师域无法触达数据；不提供任何按全局 id 的裸查询（实施清单 §3.1）；
 * - **原文是真相**：sourceMd 全量保存，anchors/slots/mediaPaths/引用索引只是
 *   抽取副本——本模块只提供「整实体保存」入口（导入/reparse 的写入函数经
 *   同一解析产出实体后调用），不提供绕开源文的抽取字段单独修改；
 * - **版本策略**：version 在 sourceMd 变更时 +1（内容身份即版本）；抽取字段
 *   重建不升版；软删后重导复活（deletedAt 清空，题目软删同款规则延续）；
 * - **引用索引不是第二份真相**：question_group_members / material_refs 行
 *   随实体保存同事务替换（删除 + 按序重插），仅服务反查与悬垂检测；
 * - 输入形态为契约实体（material.ts / content.ts 的 QuestionGroup /
 *   MaterialPublic）——契约校验在导入/解析层（TT-06/QM-05），本层做结构映射。
 * API 路由层留 TT-07；本模块是服务端内部读写接口。
 */

/** 引用方类型（material_refs.ownerKind 值域） */
export type MaterialRefOwnerKind = "group" | "question";

/** 冻结快照实体类型（attempt_context_snapshots.kind 值域） */
export type AttemptContextKind = "material" | "group";

/** 列表/读取选项：includeDeleted=true 时把软删行一并返回（默认排除） */
export interface IncludeDeletedOptions {
  readonly includeDeleted?: boolean;
}

/** saveMaterial 的输入（契约 Material 形态直落，§5.2.5） */
export interface SaveMaterialInput {
  readonly teacherId: string;
  readonly unitId: string;
  /** 契约材料实体（::::material 的解析产物） */
  readonly material: Material;
  /** 文档内出现顺序（0 起） */
  readonly order: number;
  /** 本次写入时间（UTC ISO） */
  readonly now: string;
}

/**
 * 保存材料（upsert by (teacherId, id)）：新插入 version=1；已存在时 sourceMd
 * 变更 → version+1、未变 → version 保持（抽取字段照常刷新）；软删行重导复活
 * （deletedAt 清空）。返回保存后的行。
 */
export function saveMaterial(db: Db, input: SaveMaterialInput): MaterialRow {
  const { teacherId, material, now } = input;
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(materials)
      .where(and(eq(materials.teacherId, teacherId), eq(materials.id, material.id)))
      .get();
    const fields = {
      unitId: input.unitId,
      title: material.title ?? null,
      sourceMd: material.sourceMd,
      contentMd: material.contentMd,
      anchorsJson: JSON.stringify(material.anchors),
      slotsJson: JSON.stringify(material.slots),
      mediaPathsJson: JSON.stringify(material.mediaPaths),
      order: input.order,
      updatedAt: now,
    };
    if (existing === undefined) {
      tx.insert(materials)
        .values({ id: material.id, teacherId, ...fields, deletedAt: null })
        .run();
    } else {
      tx.update(materials)
        .set({
          ...fields,
          version:
            existing.sourceMd === material.sourceMd
              ? existing.version
              : existing.version + 1,
          deletedAt: null,
        })
        .where(and(eq(materials.teacherId, teacherId), eq(materials.id, material.id)))
        .run();
    }
    return tx
      .select()
      .from(materials)
      .where(and(eq(materials.teacherId, teacherId), eq(materials.id, material.id)))
      .get()!;
  });
}

/** 按 (teacherId, id) 读材料；默认排除软删行（includeDeleted 可见） */
export function getMaterial(
  db: Db,
  teacherId: string,
  id: string,
  options: IncludeDeletedOptions = {},
): MaterialRow | null {
  const conditions = [
    eq(materials.teacherId, teacherId),
    eq(materials.id, id),
  ];
  if (options.includeDeleted !== true) {
    conditions.push(isNull(materials.deletedAt));
  }
  return db.select().from(materials).where(and(...conditions)).get() ?? null;
}

/** 单元内材料列表（unit.materials 重建入口；按文档序 order 升序） */
export function listMaterialsByUnit(
  db: Db,
  teacherId: string,
  unitId: string,
  options: IncludeDeletedOptions = {},
): MaterialRow[] {
  const conditions = [
    eq(materials.teacherId, teacherId),
    eq(materials.unitId, unitId),
  ];
  if (options.includeDeleted !== true) {
    conditions.push(isNull(materials.deletedAt));
  }
  return db
    .select()
    .from(materials)
    .where(and(...conditions))
    .orderBy(asc(materials.order))
    .all();
}

/**
 * 软删材料（deletedAt 置值；幂等——重复软删保持原时间并返回当前行）。返回
 * 更新后的行；不存在返回 null。材料只软删不物理删除（db-change 红线同款）；
 * 软删行重导复活走 saveMaterial。
 */
export function softDeleteMaterial(
  db: Db,
  teacherId: string,
  id: string,
  now: string,
): MaterialRow | null {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(materials)
      .where(and(eq(materials.teacherId, teacherId), eq(materials.id, id)))
      .get();
    if (existing === undefined) return null;
    if (existing.deletedAt === null) {
      tx.update(materials)
        .set({ deletedAt: now })
        .where(and(eq(materials.teacherId, teacherId), eq(materials.id, id)))
        .run();
    }
    return tx
      .select()
      .from(materials)
      .where(and(eq(materials.teacherId, teacherId), eq(materials.id, id)))
      .get() ?? null;
  });
}

/** saveQuestionGroup 的输入（契约 QuestionGroup 形态直落） */
export interface SaveQuestionGroupInput {
  readonly teacherId: string;
  readonly unitId: string;
  /** 契约题组实体（::::group 的解析产物） */
  readonly group: QuestionGroup;
  /** 文档内出现顺序（0 起） */
  readonly order: number;
  /** 本次写入时间（UTC ISO） */
  readonly now: string;
}

/**
 * 保存题组（upsert by (teacherId, id)）：组行 + 成员索引（question_group_
 * members）+ 组材料引用索引（material_refs，ownerKind='group'）**同事务**替换
 * ——成员重复（同一子题被组内引用两次，lint 的 GROUP_MEMBER_DUPLICATED 在导入
 * 前拦截）触发索引主键冲突 → 整体抛错回滚，不留半份数据。版本策略同
 * saveMaterial（sourceMd 变更 +1）。返回保存后的组行。
 */
export function saveQuestionGroup(
  db: Db,
  input: SaveQuestionGroupInput,
): QuestionGroupRow {
  const { teacherId, group, now } = input;
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          eq(questionGroups.id, group.id),
        ),
      )
      .get();
    const fields = {
      unitId: input.unitId,
      title: group.title ?? null,
      label: group.label ?? null,
      sourceMd: group.sourceMd,
      introMd: group.introMd,
      materialRefsJson: JSON.stringify(group.materialRefs),
      questionIdsJson: JSON.stringify(group.questionIds),
      order: input.order,
      updatedAt: now,
    };
    if (existing === undefined) {
      tx.insert(questionGroups)
        .values({ id: group.id, teacherId, ...fields, deletedAt: null })
        .run();
    } else {
      tx.update(questionGroups)
        .set({
          ...fields,
          version:
            existing.sourceMd === group.sourceMd
              ? existing.version
              : existing.version + 1,
          deletedAt: null,
        })
        .where(
          and(
            eq(questionGroups.teacherId, teacherId),
            eq(questionGroups.id, group.id),
          ),
        )
        .run();
    }
    // 成员索引整体替换（::ref{question=} 书写顺序即组内序）
    tx.delete(questionGroupMembers)
      .where(
        and(
          eq(questionGroupMembers.teacherId, teacherId),
          eq(questionGroupMembers.groupId, group.id),
        ),
      )
      .run();
    for (const [index, questionId] of group.questionIds.entries()) {
      tx.insert(questionGroupMembers)
        .values({ teacherId, groupId: group.id, questionId, order: index })
        .run();
    }
    // 组材料引用索引整体替换（ownerKind='group'）
    replaceOwnerMaterialRefs(tx, teacherId, "group", group.id, group.materialRefs);
    return tx
      .select()
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          eq(questionGroups.id, group.id),
        ),
      )
      .get()!;
  });
}

/** 按 (teacherId, id) 读题组；默认排除软删行 */
export function getQuestionGroup(
  db: Db,
  teacherId: string,
  id: string,
  options: IncludeDeletedOptions = {},
): QuestionGroupRow | null {
  const conditions = [
    eq(questionGroups.teacherId, teacherId),
    eq(questionGroups.id, id),
  ];
  if (options.includeDeleted !== true) {
    conditions.push(isNull(questionGroups.deletedAt));
  }
  return (
    db.select().from(questionGroups).where(and(...conditions)).get() ?? null
  );
}

/** 单元内组列表（unit.groups 重建入口；按文档序 order 升序） */
export function listQuestionGroupsByUnit(
  db: Db,
  teacherId: string,
  unitId: string,
  options: IncludeDeletedOptions = {},
): QuestionGroupRow[] {
  const conditions = [
    eq(questionGroups.teacherId, teacherId),
    eq(questionGroups.unitId, unitId),
  ];
  if (options.includeDeleted !== true) {
    conditions.push(isNull(questionGroups.deletedAt));
  }
  return db
    .select()
    .from(questionGroups)
    .where(and(...conditions))
    .orderBy(asc(questionGroups.order))
    .all();
}

/** 软删题组（幂等；语义同 softDeleteMaterial——成员/引用索引行保留以查历史影响） */
export function softDeleteQuestionGroup(
  db: Db,
  teacherId: string,
  id: string,
  now: string,
): QuestionGroupRow | null {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          eq(questionGroups.id, id),
        ),
      )
      .get();
    if (existing === undefined) return null;
    if (existing.deletedAt === null) {
      tx.update(questionGroups)
        .set({ deletedAt: now })
        .where(
          and(
            eq(questionGroups.teacherId, teacherId),
            eq(questionGroups.id, id),
          ),
        )
        .run();
    }
    return tx
      .select()
      .from(questionGroups)
      .where(
        and(
          eq(questionGroups.teacherId, teacherId),
          eq(questionGroups.id, id),
        ),
      )
      .get() ?? null;
  });
}

/**
 * 替换某个 owner 的材料引用索引行（删除 + 按 materialRefs 数组下标重插）。
 * 题（ownerKind='question'）入口由 QM-05 导入/reparse 在保存题目行后调用；
 * 组入口内联在 saveQuestionGroup 事务内。同事务原子。
 */
export function replaceQuestionMaterialRefs(
  db: Db,
  teacherId: string,
  questionId: string,
  refs: readonly MaterialRef[],
): void {
  db.transaction((tx) => {
    replaceOwnerMaterialRefs(tx, teacherId, "question", questionId, refs);
  });
}

/** owner 维度引用索引替换的事务内实现（Db | Tx 双态，见上方两入口） */
function replaceOwnerMaterialRefs(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  teacherId: string,
  ownerKind: MaterialRefOwnerKind,
  ownerId: string,
  refs: readonly MaterialRef[],
): void {
  tx.delete(materialRefs)
    .where(
      and(
        eq(materialRefs.teacherId, teacherId),
        eq(materialRefs.ownerKind, ownerKind),
        eq(materialRefs.ownerId, ownerId),
      ),
    )
    .run();
  for (const [index, ref] of refs.entries()) {
    tx.insert(materialRefs)
      .values({
        teacherId,
        ownerKind,
        ownerId,
        materialId: ref.material,
        refOrder: index,
      })
      .run();
  }
}

/** 材料被谁引用（删除/移动影响反查）；按 (ownerKind, ownerId, refOrder) 排序 */
export interface MaterialRefOwnerSummary {
  readonly ownerKind: MaterialRefOwnerKind;
  readonly ownerId: string;
  readonly refOrder: number;
}

/** 反查引用某材料的全部 owner（组 + 题）；教师域强制过滤 */
export function findMaterialRefOwners(
  db: Db,
  teacherId: string,
  materialId: string,
): MaterialRefOwnerSummary[] {
  return db
    .select({
      ownerKind: materialRefs.ownerKind,
      ownerId: materialRefs.ownerId,
      refOrder: materialRefs.refOrder,
    })
    .from(materialRefs)
    .where(
      and(
        eq(materialRefs.teacherId, teacherId),
        eq(materialRefs.materialId, materialId),
      ),
    )
    .orderBy(asc(materialRefs.ownerKind), asc(materialRefs.ownerId), asc(materialRefs.refOrder))
    .all();
}

/** 反查引用某题的全部组 id（题移动/删除影响）；教师域强制过滤 */
export function findGroupsReferencingQuestion(
  db: Db,
  teacherId: string,
  questionId: string,
): string[] {
  return db
    .selectDistinct({ groupId: questionGroupMembers.groupId })
    .from(questionGroupMembers)
    .where(
      and(
        eq(questionGroupMembers.teacherId, teacherId),
        eq(questionGroupMembers.questionId, questionId),
      ),
    )
    .orderBy(asc(questionGroupMembers.groupId))
    .all()
    .map((row) => row.groupId);
}

/** 悬垂材料引用（目标材料缺失或已软删；引用方自身存续不在判定内——软删组的悬垂照报，供维护报告取舍） */
export interface DanglingMaterialRefSummary {
  readonly ownerKind: MaterialRefOwnerKind;
  readonly ownerId: string;
  readonly materialId: string;
  readonly refOrder: number;
}

/**
 * 检测悬垂材料引用：material_refs 行的目标材料不存在或已软删。教师域限定。
 * 用于删除影响报告与导入后完整性核对（QM-05/TT-06 消费）。
 */
export function findDanglingMaterialRefs(
  db: Db,
  teacherId: string,
): DanglingMaterialRefSummary[] {
  return db
    .select({
      ownerKind: materialRefs.ownerKind,
      ownerId: materialRefs.ownerId,
      materialId: materialRefs.materialId,
      refOrder: materialRefs.refOrder,
    })
    .from(materialRefs)
    .leftJoin(
      materials,
      and(
        eq(materials.teacherId, materialRefs.teacherId),
        eq(materials.id, materialRefs.materialId),
      ),
    )
    .where(
      and(
        eq(materialRefs.teacherId, teacherId),
        or(isNull(materials.id), isNotNull(materials.deletedAt)),
      ),
    )
    .orderBy(
      asc(materialRefs.ownerKind),
      asc(materialRefs.ownerId),
      asc(materialRefs.refOrder),
    )
    .all();
}

/** 悬垂组成员（目标题目缺失或已软删） */
export interface DanglingGroupMemberSummary {
  readonly groupId: string;
  readonly questionId: string;
  readonly order: number;
}

/**
 * 检测悬垂组成员：question_group_members 行的目标题目不存在或已软删。
 * 题目只软删（db-change 红线），故「软删」即悬垂主因。教师域限定。
 */
export function findDanglingGroupMembers(
  db: Db,
  teacherId: string,
): DanglingGroupMemberSummary[] {
  return db
    .select({
      groupId: questionGroupMembers.groupId,
      questionId: questionGroupMembers.questionId,
      order: questionGroupMembers.order,
    })
    .from(questionGroupMembers)
    .leftJoin(
      // questions 为 D10 复合主键表（teacherId DB 可空、代码恒写非空）——按
      // (teacherId, id) 联接与仓储读写口径一致
      questions,
      and(
        eq(questions.teacherId, questionGroupMembers.teacherId),
        eq(questions.id, questionGroupMembers.questionId),
      ),
    )
    .where(
      and(
        eq(questionGroupMembers.teacherId, teacherId),
        or(isNull(questions.id), isNotNull(questions.deletedAt)),
      ),
    )
    .orderBy(
      asc(questionGroupMembers.groupId),
      asc(questionGroupMembers.order),
    )
    .all();
}

/** 单条冻结内容（判别联合：kind 决定 snapshot 形态与来源版本语义） */
export type AttemptContextSnapshotEntry =
  | {
      readonly kind: "material";
      readonly sourceId: string;
      readonly sourceVersion: number;
      /** 学生作答所需的材料公开投影（materialPublicSchema 形态） */
      readonly snapshot: MaterialPublic;
    }
  | {
      readonly kind: "group";
      readonly sourceId: string;
      readonly sourceVersion: number;
      /** 学生作答所需的题组公开投影（questionGroupPublicSchema 形态） */
      readonly snapshot: QuestionGroupPublic;
    };

/**
 * 冻结 attempt 上下文快照（QM-06/TT-07 开卷闭包的存储入口）：同一
 * (attemptId, kind, sourceId, sourceVersion) 去重（同一材料同版本一次存储），
 * 同 ID 不同版本并存不覆盖（§5.3）。整批同事务：任一行写入失败（如 attempt
 * 不存在的 FK 冲突）→ 全批回滚（「材料快照与 responses 同时成功才算开卷
 * 成功」的原子性基础）。返回实际新插入行数（去重命中的不计）。
 */
export function freezeAttemptContextSnapshots(
  db: Db,
  attemptId: string,
  entries: readonly AttemptContextSnapshotEntry[],
  now: string,
): number {
  return db.transaction((tx) => {
    let inserted = 0;
    for (const entry of entries) {
      const result = tx
        .insert(attemptContextSnapshots)
        .values({
          id: crypto.randomUUID(),
          attemptId,
          kind: entry.kind,
          sourceId: entry.sourceId,
          sourceVersion: entry.sourceVersion,
          snapshotJson: JSON.stringify(entry.snapshot),
          frozenAt: now,
        })
        .onConflictDoNothing({
          target: [
            attemptContextSnapshots.attemptId,
            attemptContextSnapshots.kind,
            attemptContextSnapshots.sourceId,
            attemptContextSnapshots.sourceVersion,
          ],
        })
        .run();
      inserted += result.changes;
    }
    return inserted;
  });
}

/** 某卷全部冻结上下文（作答渲染/导出/错题重练只读快照的读取入口） */
export function listAttemptContextSnapshots(
  db: Db,
  attemptId: string,
): AttemptContextSnapshotRow[] {
  return db
    .select()
    .from(attemptContextSnapshots)
    .where(eq(attemptContextSnapshots.attemptId, attemptId))
    .orderBy(
      asc(attemptContextSnapshots.kind),
      asc(attemptContextSnapshots.sourceId),
      asc(attemptContextSnapshots.sourceVersion),
    )
    .all();
}

/** 精确取一条冻结快照（(attempt, kind, sourceId, sourceVersion) 定位） */
export function getAttemptContextSnapshot(
  db: Db,
  attemptId: string,
  kind: AttemptContextKind,
  sourceId: string,
  sourceVersion: number,
): AttemptContextSnapshotRow | null {
  return (
    db
      .select()
      .from(attemptContextSnapshots)
      .where(
        and(
          eq(attemptContextSnapshots.attemptId, attemptId),
          eq(attemptContextSnapshots.kind, kind),
          eq(attemptContextSnapshots.sourceId, sourceId),
          eq(attemptContextSnapshots.sourceVersion, sourceVersion),
        ),
      )
      .get() ?? null
  );
}
