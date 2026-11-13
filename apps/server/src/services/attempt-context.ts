// 相对导入带 .ts 扩展名（仓库约定：可能被 reparse CLI / 路由层间接导入）
import type {
  AttemptContextData,
  AttemptContextGroup,
  AttemptContextMaterial,
  GradingPolicy,
  Question,
} from "@tutor/contract";
import {
  attemptContextGroupSchema,
  attemptContextMaterialSchema,
  gradingPolicyOf,
} from "@tutor/contract";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type AttemptContextSnapshotRow,
  type MaterialRow,
  materialRefs,
  materials,
  type QuestionGroupRow,
  questionGroupMembers,
  questionGroups,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  type AttemptContextSnapshotEntry,
  hasAttemptContextFreeze,
  listAttemptContextSnapshots,
} from "./material-repository.ts";
import { jsonOf } from "./snapshot.ts";

/**
 * 开卷依赖冻结（QM-06 / tt-07a）：四来源建卷把「题目 → 题级材料引用 ∪ 所属
 * 组 → 组级材料引用」的依赖闭包按公开投影形态同事务冻结进
 * attempt_context_snapshots（设计方案 §5.3「冻结必须覆盖依赖闭包」——材料/
 * 组/引用/媒体全进快照，媒体引用经材料投影的 mediaPaths 携带；题目本体与
 * 答案解析由 responses.questionSnapshotJson 既有冻结承载，指向来源版本）。
 *
 * 冻结后旧卷渲染/判分/导出只读快照：教师改材料/组/软删只影响之后新建的卷。
 * 缺依赖（索引指向的材料/组不存在或已软删）→ 开卷 fail closed 显式报错
 * （ATTEMPT_CONTEXT_BROKEN），不静默跳过、不拿 live 资源替补旧卷内容。
 *
 * 开卷按题目快照和所属教师的自评设置冻结 gradingPolicy。历史卷读取原策略。
 */

/** 依赖闭包产物：材料与组行（教师域 live、未软删，按 id 稳定序） */
export interface AttemptContextClosure {
  readonly materials: readonly MaterialRow[];
  readonly groups: readonly QuestionGroupRow[];
}

/**
 * 开卷依赖闭包（live 读路径，建卷事务外调用——better-sqlite3 同步单进程，
 * 与 freezeInputsOfAttempt 同款口径）：题目集合 → 题级材料引用（material_
 * refs，ownerKind='question'）∪ 所属组（question_group_members）→ 组级材料
 * 引用 → 材料/组行。**闭包不依赖 live order**（快照排序按 kind/sourceId/
 * sourceVersion，TT-06b P2-3 记账落实：reparse 重排不影响冻结读取）。
 * 依赖缺失/软删 → 409 ATTEMPT_CONTEXT_BROKEN（fail closed，开卷整体失败）。
 */
export function liveAttemptContextClosure(
  db: Db,
  teacherId: string,
  questionIds: readonly string[],
): AttemptContextClosure {
  if (questionIds.length === 0) return { materials: [], groups: [] };
  const { groupIds, materialIds } = closureRefIds(db, teacherId, questionIds);

  return {
    groups: requireClosureRows(
      groupIds,
      "题组",
      (ids) =>
        db
          .select()
          .from(questionGroups)
          .where(
            and(
              eq(questionGroups.teacherId, teacherId),
              inArray(questionGroups.id, ids),
            ),
          )
          .all(),
      (row) => row.deletedAt === null,
    ).sort(compareById),
    materials: requireClosureRows(
      materialIds,
      "材料",
      (ids) =>
        db
          .select()
          .from(materials)
          .where(
            and(eq(materials.teacherId, teacherId), inArray(materials.id, ids)),
          )
          .all(),
      (row) => row.deletedAt === null,
    ).sort(compareById),
  };
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 闭包行读取 + 缺失/软删 fail closed（按 id 报首个缺失目标，供错误消息定位） */
function requireClosureRows<
  Row extends { id: string; deletedAt: string | null },
>(
  ids: ReadonlySet<string>,
  what: "材料" | "题组",
  select: (ids: string[]) => Row[],
  isAlive: (row: Row) => boolean,
): Row[] {
  if (ids.size === 0) return [];
  const rows = select([...ids]);
  const missing: string[] = [];
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row === undefined || !isAlive(row)) missing.push(id);
  }
  if (missing.length > 0) {
    throw new HttpError(
      409,
      "ATTEMPT_CONTEXT_BROKEN",
      `开卷依赖的${what}已变动（${missing
        .slice(0, 3)
        .join(
          "、",
        )}${missing.length > 3 ? " 等" : ""}），请联系老师重新检查后再开卷`,
    );
  }
  return rows;
}

/**
 * 闭包行 → 冻结条目（公开投影形态 + 来源版本）：材料条目键集 =
 * materialPublicSchema 白名单（contentMd/anchors/slots/mediaPaths，教师侧
 * sourceMd 不进快照）；组条目 = questionGroupPublicSchema 白名单。投影从
 * 行数据显式挑键构造（三投影纪律：不从完整对象删键）。
 */
export function contextEntriesOf(
  closure: AttemptContextClosure,
): AttemptContextSnapshotEntry[] {
  const entries: AttemptContextSnapshotEntry[] = [];
  for (const row of closure.materials) {
    entries.push({
      kind: "material",
      sourceId: row.id,
      sourceVersion: row.version,
      snapshot: {
        id: row.id,
        ...(row.title !== null ? { title: row.title } : {}),
        contentMd: row.contentMd,
        anchors: parseColumn(row, "material", "anchors", row.anchorsJson),
        slots: parseColumn(row, "material", "slots", row.slotsJson),
        mediaPaths: parseColumn(
          row,
          "material",
          "mediaPaths",
          row.mediaPathsJson,
        ),
      },
    });
  }
  for (const row of closure.groups) {
    entries.push({
      kind: "group",
      sourceId: row.id,
      sourceVersion: row.version,
      snapshot: {
        id: row.id,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.label !== null ? { label: row.label } : {}),
        introMd: row.introMd,
        materialRefs: parseColumn(
          row,
          "group",
          "materialRefs",
          row.materialRefsJson,
        ),
        questionIds: parseColumn(
          row,
          "group",
          "questionIds",
          row.questionIdsJson,
        ),
      },
    });
  }
  return entries;
}

/**
 * 冻结输入 JSON 列解析（§16.8 P2-2 / tt-07b C7：fail closed）：五列均
 * NOT NULL 且导入层是唯一写入方（JSON.stringify，正常产不出坏 JSON），
 * **坏 JSON → 409 ATTEMPT_CONTEXT_BROKEN 显式报错**——与同模块缺依赖 409
 * 同款纪律（此前静默按 [] 降级，坏数据会被当「无槽位/无引用」冻进卷里，
 * 错误发生在写入侧且被吞）。NULL 分支保留纯防御（列 NOT NULL 不可达）。
 * 读取侧 safeParse 坏快照 409 的事后兜底继续成立。
 */
function parseColumn<T>(
  row: { id: string },
  kind: "material" | "group",
  column: string,
  json: string | null,
): T {
  if (json === null) return [] as T;
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new HttpError(
      409,
      "ATTEMPT_CONTEXT_BROKEN",
      `开卷依赖的${kind === "material" ? "材料" : "题组"}（${row.id}）的${column} 数据损坏，请联系老师重新检查后再开卷`,
    );
  }
}

/** 新卷按教师设置冻结自评资格，教师关闭时由教师批改适用题。 */
export function frozenGradingPolicyOf(
  question: Question,
  studentSelfReviewEnabled: boolean,
): GradingPolicy {
  const policy = gradingPolicyOf(question);
  return !studentSelfReviewEnabled && policy === "reference_self"
    ? "manual_only"
    : policy;
}

// ---------- 读路径：冻结快照的学生公开投影（tt-07a / QM-06） ----------

/**
 * 学生可读的冻结上下文（GET /attempts/:id/context 的数据源）：某卷全部
 * 快照条目按公开投影 schema 逐条 safeParse（materialPublicSchema /
 * questionGroupPublicSchema 白名单——三投影纪律的结构防线，未知键 strip、
 * 教师侧键 fail closed）。**坏快照（JSON 损坏/形态不符）→ 409
 * ATTEMPT_CONTEXT_BROKEN 显式报错**，不静默跳过、不改用 live 资源替代
 * （旧卷一致性不可侵犯）。条目按 (sourceId, sourceVersion) 稳定排序，不依赖
 * live order（TT-06b P2-3 记账）。归属校验由路由层完成
 * （requireUsableAttempt——TT-05b P2-2 记账：快照读取按 attemptId 直查，
 * 防线在路由）。
 */
export function studentAttemptContext(
  db: Db,
  attemptId: string,
): AttemptContextData {
  const { data, damaged } = readFrozenAttemptContext(db, attemptId);
  const first = damaged[0];
  if (first !== undefined) throw brokenSnapshotError(first);
  return data;
}

/** 重练按依赖判断损坏条目，公开回看仍由上面的入口统一返回 409。 */
export function readFrozenAttemptContext(db: Db, attemptId: string) {
  const materialsList: AttemptContextMaterial[] = [];
  const groupsList: AttemptContextGroup[] = [];
  const damaged: Pick<AttemptContextSnapshotRow, "kind" | "sourceId">[] = [];
  const rows = listAttemptContextSnapshots(db, attemptId);
  for (const row of rows) {
    const parsed = jsonOf(row.snapshotJson);
    const input =
      typeof parsed === "object" && parsed !== null
        ? { ...parsed, sourceVersion: row.sourceVersion }
        : parsed;
    if (row.kind === "material") {
      const material = attemptContextMaterialSchema.safeParse(input);
      if (material.success && material.data.id === row.sourceId)
        materialsList.push(material.data);
      else damaged.push({ kind: row.kind, sourceId: row.sourceId });
    } else {
      const group = attemptContextGroupSchema.safeParse(input);
      if (group.success && group.data.id === row.sourceId)
        groupsList.push(group.data);
      else damaged.push({ kind: row.kind, sourceId: row.sourceId });
    }
  }
  const byIdThenVersion = (
    a: { id: string; sourceVersion: number },
    b: { id: string; sourceVersion: number },
  ): number => a.id.localeCompare(b.id) || a.sourceVersion - b.sourceVersion;
  const data: AttemptContextData = {
    attemptId,
    freezeState:
      rows.length > 0 || hasAttemptContextFreeze(db, attemptId)
        ? "frozen"
        : "legacy_unknown",
    materials: materialsList.sort(byIdThenVersion),
    groups: groupsList.sort(byIdThenVersion),
  };
  return { data, damaged };
}

/** 坏快照显式报错（按条目定位，供错误消息检索；与缺依赖 409 同码） */
function brokenSnapshotError(row: {
  kind: string;
  sourceId: string;
}): HttpError {
  return new HttpError(
    409,
    "ATTEMPT_CONTEXT_BROKEN",
    `这份作答的${row.kind === "material" ? "材料" : "题组"}快照损坏（${row.sourceId}），请联系老师重新检查`,
  );
}

/** 依赖引用集合（题 → 组 ids + 材料 ids；live 索引，不读实体行） */
export function closureRefIds(
  db: Db,
  teacherId: string,
  questionIds: readonly string[],
): { groupIds: Set<string>; materialIds: Set<string> } {
  if (questionIds.length === 0) {
    return { groupIds: new Set(), materialIds: new Set() };
  }
  const uniqueQuestionIds = [...new Set(questionIds)];
  const groupIds = new Set(
    db
      .selectDistinct({ groupId: questionGroupMembers.groupId })
      .from(questionGroupMembers)
      .where(
        and(
          eq(questionGroupMembers.teacherId, teacherId),
          inArray(questionGroupMembers.questionId, uniqueQuestionIds),
        ),
      )
      .all()
      .map((row) => row.groupId),
  );
  const ownerConditions = [
    and(
      eq(materialRefs.teacherId, teacherId),
      eq(materialRefs.ownerKind, "question"),
      inArray(materialRefs.ownerId, uniqueQuestionIds),
    ),
  ];
  if (groupIds.size > 0) {
    ownerConditions.push(
      and(
        eq(materialRefs.teacherId, teacherId),
        eq(materialRefs.ownerKind, "group"),
        inArray(materialRefs.ownerId, [...groupIds]),
      ),
    );
  }
  const materialIds = new Set(
    db
      .selectDistinct({ materialId: materialRefs.materialId })
      .from(materialRefs)
      .where(or(...ownerConditions))
      .all()
      .map((row) => row.materialId),
  );
  return { groupIds, materialIds };
}
