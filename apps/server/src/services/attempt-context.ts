// 相对导入带 .ts 扩展名（仓库约定：可能被 reparse CLI / 路由层间接导入）
import type { GradingPolicy, Question } from "@tutor/contract";
import { gradingPolicyOf } from "@tutor/contract";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  materialRefs,
  materials,
  questionGroupMembers,
  questionGroups,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import type {
  AttemptContextSnapshotEntry,
  MaterialRow,
  QuestionGroupRow,
} from "./material-repository.ts";

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
 * gradingPolicy 行级冻结（决策记录 §5.6）：开卷每行按题目快照内容写入策略
 * （gradingPolicyOf 单一出处），写入受 §5.8.4 发布开关注入参数控制——开关
 * 关闭的部署写 NULL（旧行旧语义，判分行为零变化）。
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
  const uniqueQuestionIds = [...new Set(questionIds)];

  // 题 → 组（组成员反查，教师域）
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

  // 题/组 owner 的全部材料引用（ownerKind 区分；题级 OR 组级并集，一次批量）
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
        anchors: parseColumn(row.anchorsJson, []),
        slots: parseColumn(row.slotsJson, []),
        mediaPaths: parseColumn(row.mediaPathsJson, []),
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
        materialRefs: parseColumn(row.materialRefsJson, []),
        questionIds: parseColumn(row.questionIdsJson, []),
      },
    });
  }
  return entries;
}

/** JSON 列安全解析（NULL/坏 JSON → 缺省值；冻结输入行由导入层保证形态） */
function parseColumn<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * 行级判分策略冻结值（§5.6 D11）：开关开启的开卷按题目快照内容写入
 * gradingPolicyOf（契约单一出处）；开关关闭的部署 → null（旧行旧语义，
 * 判分行为与迁移前完全一致——§5.8.4「新策略写入只发生在开关开启后的题目
 * 开卷时」，题行无导入时点标记，按部署当前开关裁决，见决策记录 tt-07a）。
 */
export function frozenGradingPolicyOf(
  question: Question,
  newContentEnabled: boolean,
): GradingPolicy | null {
  return newContentEnabled ? gradingPolicyOf(question) : null;
}
