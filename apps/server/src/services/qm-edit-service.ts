import type {
  MaterialDeleteData,
  MaterialDetail,
  MaterialUpdateData,
  MaterialUpdateRequest,
  ParsedDocument,
  QuestionGroupDeleteData,
  QuestionGroupDetail,
  QuestionGroupUpdateData,
  QuestionGroupUpdateRequest,
} from "@tutor/contract";
import { lintDocument } from "@tutor/md-dsl";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type MaterialRow,
  type QuestionGroupRow,
  questions,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertNewContentAllowed,
  liveMaterialIdsOf,
  normalizeForImport,
  resolveNewContentEnabled,
  resolveQmImportIssues,
} from "./import-qm.ts";
import {
  findMaterialRefOwners,
  getMaterial,
  getQuestionGroup,
  listMaterialsByUnit,
  listQuestionGroupsByUnit,
  saveMaterialWithin,
  saveQuestionGroupWithin,
  softDeleteMaterial,
  softDeleteQuestionGroup,
} from "./material-repository.ts";

/**
 * tt-06b / QM-05 材料/题组编辑与删除（教师端，片段原文提交）。
 *
 * 「同一源文解析」（§5.2.1 / 设计方案 §4）：材料/组不是孤立片段——组引用
 * 子题与材料、材料的槽位必须被子题绑定，这些校验依赖单元上下文
 * （GROUP_MEMBER_NOT_FOUND / SLOT_UNBOUND / UNKNOWN_SLOT_REF 都在两遍解析
 * 第二遍裁决）。因此编辑不走「单片段包装」（单题编辑的 wrapSingleQuestionMd
 * 模式），而是**单元文档重建**：库内实体的 sourceMd（被编辑者替换为提交
 * 片段）按导入规范序（材料 → 组 → 题目，各自 order）拼回整篇 practice 文档，
 * 经同一 lint + 教师域引用解析后落库。与导出重导（exportUnitMd）同一拼装口径，
 * 不产生第二事实来源。
 *
 * 其他语义：
 * - id 不可变（ID_IMMUTABLE），且解析出的材料/组 id 集合必须与库内一致
 *   （一次编辑一个实体；新增/删除实体走导入/删除接口）；
 * - NEW_CONTENT_ENABLED 闸门只判**提交片段**（编辑动作自身是否引入新内容
 *   语法；存量实体是此前合法导入的结果，重建文档不重复触发闸门）；
 * - error 级 lint → 422 LINT_ERROR（_issues 为重建文档行号，附
 *   _fragmentStartLine 供前端把片段内问题平移回编辑器坐标；片段外的问题
 *   指向同单元其他实体——如删槽位导致组的 slot= 引用悬垂）；
 * - 版本策略随仓储（sourceMd 变更 +1，未变保持）；删除软删并返回删除前
 *   仍存活的引用清单（受影响引用报告）。
 */

/** 单元文档重建的输入（被编辑实体以 submittedSourceMd 替换） */
interface UnitDocSource {
  readonly unitId: string;
  readonly materials: readonly { id: string; sourceMd: string }[];
  readonly groups: readonly { id: string; sourceMd: string }[];
  readonly questions: readonly { id: string; sourceMd: string }[];
  /** 被编辑实体（材料或组）的 id */
  readonly targetId: string;
  /** 提交片段（未规范化） */
  readonly submittedSourceMd: string;
}

/** 重建产物：文档 + 片段起始行（1 起；LINT_ERROR 响应平移基准） */
interface RebuiltUnitDoc {
  readonly markdown: string;
  readonly fragmentStartLine: number;
}

/**
 * 单元文档重建（导入规范序：材料 → 组 → 题目；与 exportUnitMd / 重导同一
 * 拼装口径）。片段起始行 = 前缀行数 + 前序块的行数累计（块间一空行分隔）。
 */
export function rebuildUnitDoc(source: UnitDocSource): RebuiltUnitDoc {
  const prefixLines = [
    "---",
    "kind: practice",
    `unit: ${JSON.stringify(source.unitId)}`,
    "---",
    "",
    `# ${source.unitId}`,
    "",
  ];
  const targetInMaterials = source.materials.some(
    (m) => m.id === source.targetId,
  );
  const targetSequence = targetInMaterials ? source.materials : source.groups;
  const replace = (id: string, sourceMd: string): string =>
    id === source.targetId ? source.submittedSourceMd : sourceMd;
  const materialBlocks = source.materials.map((m) =>
    replace(m.id, m.sourceMd),
  );
  const groupBlocks = source.groups.map((g) => replace(g.id, g.sourceMd));
  const blocks = [
    ...materialBlocks,
    ...groupBlocks,
    ...source.questions.map((q) => q.sourceMd),
  ];
  let fragmentStartLine = prefixLines.length + 1;
  for (const entity of targetSequence) {
    const block = replace(entity.id, entity.sourceMd);
    if (entity.id === source.targetId) break;
    fragmentStartLine += block.split("\n").length + 1;
  }
  return {
    markdown: [...prefixLines, ...blocks, ""].join("\n"),
    fragmentStartLine,
  };
}

/** lint 重建文档并做教师域引用降级；error → 422 LINT_ERROR（附片段起始行） */
function lintUnitDoc(
  db: Db,
  teacherId: string,
  rebuilt: RebuiltUnitDoc,
): ParsedDocument {
  // 导入规范化回写（§5.2.3）：片段新增的缺省 id（seg/slot）按文档序固化；
  // 存量实体已显式、幂等
  const normalized = normalizeForImport(rebuilt.markdown, undefined);
  const { issues, parsed } = lintDocument(normalized);
  // 教师域引用降级（与 preview/commit 同口径）：重建文档未包含的跨单元
  // 既有材料引用不报错
  const resolved = resolveQmImportIssues(
    issues,
    parsed,
    liveMaterialIdsOf(db, teacherId),
  );
  const errors = resolved.filter((issue) => issue.level === "error");
  const firstError = errors[0];
  if (firstError !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `保存前校验未通过（${errors.length} 个 error 级问题；行号为单元重建文档坐标，第 ${rebuilt.fragmentStartLine} 行起是本次编辑的片段）：第 ${firstError.line} 行：${firstError.message}`,
      {
        _issues: errors,
        _fragmentStartLine: rebuilt.fragmentStartLine,
      },
    );
  }
  return parsed;
}

/** 未软删题目行（单元内，order 升序）——重建文档的题块来源 */
function liveQuestionsOfUnit(
  db: Db,
  teacherId: string,
  unitId: string,
): { id: string; sourceMd: string }[] {
  return db
    .select({ id: questions.id, sourceMd: questions.sourceMd })
    .from(questions)
    .where(
      and(
        eq(questions.teacherId, teacherId),
        eq(questions.unitId, unitId),
        isNull(questions.deletedAt),
      ),
    )
    .orderBy(asc(questions.order), asc(questions.id))
    .all();
}

/**
 * 校验编辑后实体 id 集合与库内一致：目标实体 id 消失 → ID_IMMUTABLE；
 * 集合出现增/删（片段含多个实体或删掉了他者）→ VALIDATION_ERROR。
 * 一次编辑一个实体；新增/删除实体走导入/删除接口。
 */
function assertEntityIdsUnchanged(
  parsedIds: readonly string[],
  existingIds: readonly string[],
  targetId: string,
  entityName: string,
): void {
  const parsedSet = new Set(parsedIds);
  if (parsedSet.has(targetId) && parsedSet.size === existingIds.length) {
    let same = true;
    for (const id of existingIds) {
      if (!parsedSet.has(id)) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  if (!parsedSet.has(targetId)) {
    throw new HttpError(
      422,
      "ID_IMMUTABLE",
      `${entityName} id 不可变（原 id「${targetId}」在解析结果中不存在）；如需新增实体请走导入`,
    );
  }
  const added = [...parsedSet].filter((id) => !existingIds.includes(id));
  const removed = existingIds.filter((id) => !parsedSet.has(id));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`解析出新增实体（${added.join("、")}）`);
  if (removed.length > 0) parts.push(`原实体在解析结果中缺失（${removed.join("、")}）`);
  throw new HttpError(
    422,
    "VALIDATION_ERROR",
    `一次只能编辑一个${entityName}实体（${parts.join("；")}）：新增实体请走导入，删除请走删除接口`,
  );
}

// ---------- 材料 ----------

/** 取材料行（教师域、未软删）；缺失/软删 → 404 MATERIAL_NOT_FOUND */
function requireMaterial(db: Db, teacherId: string, id: string): MaterialRow {
  const row = getMaterial(db, teacherId, id);
  if (row === null) {
    throw new HttpError(404, "MATERIAL_NOT_FOUND", "材料不存在（可能已被删除）");
  }
  return row;
}

/** GET /api/teacher/materials/:id（编辑抽屉用；教师侧完整形态含 sourceMd） */
export function getMaterialDetail(
  db: Db,
  teacherId: string,
  id: string,
): MaterialDetail {
  const row = requireMaterial(db, teacherId, id);
  return {
    id: row.id,
    unitId: row.unitId,
    ...(row.title !== null ? { title: row.title } : {}),
    sourceMd: row.sourceMd,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** PUT /api/teacher/materials/:id：片段原文经单元重建解析后落库 */
export function updateMaterial(
  db: Db,
  teacherId: string,
  id: string,
  input: MaterialUpdateRequest,
  newContentEnabled?: boolean,
): MaterialUpdateData {
  const row = requireMaterial(db, teacherId, id);
  // 闸门只判提交片段：编辑动作自身是否引入新内容语法
  assertNewContentAllowed(
    input.sourceMd,
    resolveNewContentEnabled(newContentEnabled),
  );

  const unitMaterials = listMaterialsByUnit(db, teacherId, row.unitId);
  const unitGroups = listQuestionGroupsByUnit(db, teacherId, row.unitId);
  const rebuilt = rebuildUnitDoc({
    unitId: row.unitId,
    materials: unitMaterials.map((m) => ({ id: m.id, sourceMd: m.sourceMd })),
    groups: unitGroups.map((g) => ({ id: g.id, sourceMd: g.sourceMd })),
    questions: liveQuestionsOfUnit(db, teacherId, row.unitId),
    targetId: id,
    submittedSourceMd: input.sourceMd,
  });
  const parsed = lintUnitDoc(db, teacherId, rebuilt);
  assertEntityIdsUnchanged(
    (parsed.materials ?? []).map((m) => m.id),
    unitMaterials.map((m) => m.id),
    id,
    "材料",
  );
  const next = (parsed.materials ?? []).find((m) => m.id === id);
  if (next === undefined) {
    throw new HttpError(422, "ID_IMMUTABLE", "材料 id 不可变；如需新增请走导入");
  }

  const saved = db.transaction((tx) =>
    saveMaterialWithin(tx, {
      teacherId,
      unitId: row.unitId,
      material: next,
      order: row.order,
      now: new Date().toISOString(),
    }),
  );
  return {
    id,
    version: saved.version,
    updatedAt: saved.updatedAt,
    affectedRefs: findMaterialRefOwners(db, teacherId, id).map((owner) => ({
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      refOrder: owner.refOrder,
    })),
  };
}

/** DELETE /api/teacher/materials/:id：软删 + 删除前仍存活的引用清单 */
export function deleteMaterial(
  db: Db,
  teacherId: string,
  id: string,
): MaterialDeleteData {
  requireMaterial(db, teacherId, id);
  const affectedRefs = findMaterialRefOwners(db, teacherId, id).map((owner) => ({
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    refOrder: owner.refOrder,
  }));
  const deleted = softDeleteMaterial(
    db,
    teacherId,
    id,
    new Date().toISOString(),
  );
  if (deleted === null) {
    throw new HttpError(404, "MATERIAL_NOT_FOUND", "材料不存在（可能已被删除）");
  }
  return { id, deletedAt: deleted.deletedAt ?? "", affectedRefs };
}

// ---------- 题组 ----------

/** 取题组行（教师域、未软删）；缺失/软删 → 404 GROUP_NOT_FOUND */
function requireGroup(db: Db, teacherId: string, id: string): QuestionGroupRow {
  const row = getQuestionGroup(db, teacherId, id);
  if (row === null) {
    throw new HttpError(404, "GROUP_NOT_FOUND", "题组不存在（可能已被删除）");
  }
  return row;
}

/** GET /api/teacher/groups/:id */
export function getQuestionGroupDetail(
  db: Db,
  teacherId: string,
  id: string,
): QuestionGroupDetail {
  const row = requireGroup(db, teacherId, id);
  return {
    id: row.id,
    unitId: row.unitId,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.label !== null ? { label: row.label } : {}),
    sourceMd: row.sourceMd,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** PUT /api/teacher/groups/:id：片段经单元重建解析后落库（成员/引用索引同事务替换） */
export function updateQuestionGroup(
  db: Db,
  teacherId: string,
  id: string,
  input: QuestionGroupUpdateRequest,
  newContentEnabled?: boolean,
): QuestionGroupUpdateData {
  const row = requireGroup(db, teacherId, id);
  assertNewContentAllowed(
    input.sourceMd,
    resolveNewContentEnabled(newContentEnabled),
  );

  const unitMaterials = listMaterialsByUnit(db, teacherId, row.unitId);
  const unitGroups = listQuestionGroupsByUnit(db, teacherId, row.unitId);
  const rebuilt = rebuildUnitDoc({
    unitId: row.unitId,
    materials: unitMaterials.map((m) => ({ id: m.id, sourceMd: m.sourceMd })),
    groups: unitGroups.map((g) => ({ id: g.id, sourceMd: g.sourceMd })),
    questions: liveQuestionsOfUnit(db, teacherId, row.unitId),
    targetId: id,
    submittedSourceMd: input.sourceMd,
  });
  const parsed = lintUnitDoc(db, teacherId, rebuilt);
  assertEntityIdsUnchanged(
    (parsed.groups ?? []).map((g) => g.id),
    unitGroups.map((g) => g.id),
    id,
    "题组",
  );
  const next = (parsed.groups ?? []).find((g) => g.id === id);
  if (next === undefined) {
    throw new HttpError(422, "ID_IMMUTABLE", "题组 id 不可变；如需新增请走导入");
  }

  const saved = db.transaction((tx) =>
    saveQuestionGroupWithin(tx, {
      teacherId,
      unitId: row.unitId,
      group: next,
      order: row.order,
      now: new Date().toISOString(),
    }),
  );
  return {
    id,
    version: saved.version,
    updatedAt: saved.updatedAt,
    affectedQuestionIds: [...next.questionIds],
  };
}

/** DELETE /api/teacher/groups/:id：软删 + 软删前收录的子题清单 */
export function deleteQuestionGroup(
  db: Db,
  teacherId: string,
  id: string,
): QuestionGroupDeleteData {
  const row = requireGroup(db, teacherId, id);
  const affectedQuestionIds = JSON.parse(
    row.questionIdsJson ?? "[]",
  ) as string[];
  const deleted = softDeleteQuestionGroup(
    db,
    teacherId,
    id,
    new Date().toISOString(),
  );
  if (deleted === null) {
    throw new HttpError(404, "GROUP_NOT_FOUND", "题组不存在（可能已被删除）");
  }
  return { id, deletedAt: deleted.deletedAt ?? "", affectedQuestionIds };
}
