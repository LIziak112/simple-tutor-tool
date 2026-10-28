// 相对导入带 .ts 扩展名（仓库约定：可能被 reparse CLI / 路由层间接导入）
import type {
  AttemptContextData,
  AttemptContextGroup,
  AttemptContextMaterial,
  GradingPolicy,
  MaterialPublic,
  Question,
  QuestionGroupPublic,
} from "@tutor/contract";
import {
  gradingPolicyOf,
  materialPublicSchema,
  questionGroupPublicSchema,
} from "@tutor/contract";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type MaterialRow,
  materialRefs,
  materials,
  type QuestionGroupRow,
  questionGroupMembers,
  questionGroups,
  type ResponseRow,
} from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  type AttemptContextSnapshotEntry,
  getMaterial,
  getQuestionGroup,
  listAttemptContextSnapshots,
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

// ---------- wrong 组卷：来源卷快照优先（设计方案 §5.3「错题重练复制来源
// 作答的该子题及必要材料/说明」；「同 ID 不同版本并存不覆盖」） ----------

/** wrong 组卷的依赖冻结计划 */
export interface WrongAttemptContextPlan {
  /** 依赖可完整冻结的来源行（保持传入顺序） */
  readonly usable: readonly ResponseRow[];
  /** 冻结条目（来源卷快照优先 + live 回退；(kind, sourceId, version) 去重） */
  readonly entries: readonly AttemptContextSnapshotEntry[];
}

/**
 * wrong 组卷闭包计划（live 读路径，组卷事务外调用）：逐题求依赖边集——
 * **来源卷有冻结快照（tt-07a 后开的卷）时边集与快照内容同源构边**（组快照
 * questionIds 定组归属、组快照 materialRefs 与题目快照 materialRefs 定材料，
 * §16.8 P2-1 / tt-07b C6：教师事后增删 ::ref 或改组成员不再影响组卷边集，
 * 不冻入学生当时未见的依赖、不漏冻当时已见的）；来源卷零快照（升级前旧
 * 服务端开的卷）按 live 引用索引构边（显式 live 回退边界，见决策记录
 * TT-07b）。每个依赖**优先复制来源卷的冻结快照**（错题时学生所见的版本
 * ——同 ID 沿用来源版本），来源卷无该快照回退 live 冻结当前版本；两者皆
 * 不可得（live 已软删/缺失）→ **剔除该题**（与 pickOf「坏快照剔除」同款
 * 语义——学生自助重练不整卷失败，剔完由调用方按 WRONG_PRACTICE_EMPTY
 * 拒绝）。teacherId 为 null（学生无教师域的异常行）→ 依赖为空集，全部
 * 可用、零条目（不阻塞旧数据重练）。
 */
export function wrongAttemptContextPlan(
  db: Db,
  teacherId: string | null,
  sources: readonly ResponseRow[],
): WrongAttemptContextPlan {
  if (teacherId === null) return { usable: sources, entries: [] };
  // 各来源卷的快照索引：(kind|sourceId) → 条目（一次开卷一次冻结，同键至多
  // 一条；防御性取末条 = 最高版本）
  const sourceEntryByAttempt = new Map<
    string,
    Map<string, AttemptContextSnapshotEntry>
  >();
  const sourceEntriesOf = (attemptId: string) => {
    const cached = sourceEntryByAttempt.get(attemptId);
    if (cached !== undefined) return cached;
    const index = new Map<string, AttemptContextSnapshotEntry>();
    for (const row of listAttemptContextSnapshots(db, attemptId)) {
      // 分支构造让 kind 与 snapshot 投影形态在类型层成对（表由冻结入口独写，
      // snapshotJson 形态即对应 kind 的公开投影）
      if (row.kind === "material") {
        index.set(`material|${row.sourceId}`, {
          kind: row.kind,
          sourceId: row.sourceId,
          sourceVersion: row.sourceVersion,
          snapshot: JSON.parse(row.snapshotJson) as MaterialPublic,
        });
      } else {
        index.set(`group|${row.sourceId}`, {
          kind: row.kind,
          sourceId: row.sourceId,
          sourceVersion: row.sourceVersion,
          snapshot: JSON.parse(row.snapshotJson) as QuestionGroupPublic,
        });
      }
    }
    sourceEntryByAttempt.set(attemptId, index);
    return index;
  };

  const entryByDedupeKey = new Map<string, AttemptContextSnapshotEntry>();
  const usable: ResponseRow[] = [];

  for (const source of sources) {
    const sourceEntries = sourceEntriesOf(source.attemptId);
    // 依赖图口径（§16.8 P2-1 / tt-07b C6）：有快照同源构边，零快照 live 构边
    const refs =
      sourceEntries.size > 0
        ? frozenRefIdsOf(sourceEntries, source)
        : closureRefIds(db, teacherId, [source.questionId]);
    const resolved: AttemptContextSnapshotEntry[] = [];
    let ok = true;
    for (const kind of ["group", "material"] as const) {
      for (const id of kind === "group" ? refs.groupIds : refs.materialIds) {
        // 来源卷快照优先（错题时学生所见版本）→ live 回退（旧服务端开的卷）
        const entry =
          sourceEntries.get(`${kind}|${id}`) ??
          liveEntryOf(db, teacherId, kind, id);
        if (entry === null) {
          ok = false; // 两者皆不可得 → 剔除该题
          break;
        }
        resolved.push(entry);
      }
      if (!ok) break;
    }
    if (!ok) continue;
    usable.push(source);
    for (const entry of resolved) {
      const key = `${entry.kind}|${entry.sourceId}|${entry.sourceVersion}`;
      if (!entryByDedupeKey.has(key)) entryByDedupeKey.set(key, entry);
    }
  }

  return { usable, entries: [...entryByDedupeKey.values()] };
}

/**
 * 从来源卷冻结快照同源构边（§16.8 P2-1 / tt-07b C6）：组归属 = 组快照
 * questionIds 含该题（开卷时学生所见的成员关系），组级材料 = 组快照
 * materialRefs，题级材料 = 题目快照 materialRefs（开卷时无题级引用则无键
 * = 无边）。完全不读 live 引用索引——教师事后增删 ::ref / 改组成员只影响
 * 之后的新卷。题目快照由 wrong-practice pickOf 保证可用（坏快照行已被
 * 剔除），此处解析防御性失败按无题级引用处理（组归属不依赖题目快照）；
 * 组快照的 questionIds/materialRefs 防御性空数组回退（条目经 JSON.parse
 * 直转，未经 safeParse）。
 */
function frozenRefIdsOf(
  sourceEntries: ReadonlyMap<string, AttemptContextSnapshotEntry>,
  source: ResponseRow,
): { groupIds: Set<string>; materialIds: Set<string> } {
  const groupIds = new Set<string>();
  const materialIds = new Set<string>();
  for (const entry of sourceEntries.values()) {
    if (entry.kind !== "group") continue;
    if (!(entry.snapshot.questionIds ?? []).includes(source.questionId))
      continue;
    groupIds.add(entry.sourceId);
    for (const ref of entry.snapshot.materialRefs ?? []) {
      materialIds.add(ref.material);
    }
  }
  if (source.questionSnapshotJson !== null) {
    try {
      const parsed = JSON.parse(source.questionSnapshotJson) as {
        materialRefs?: ReadonlyArray<{ material: string }>;
      };
      for (const ref of parsed.materialRefs ?? []) {
        materialIds.add(ref.material);
      }
    } catch {
      // 题目快照损坏按无题级引用处理（组归属仍来自组快照）
    }
  }
  return { groupIds, materialIds };
}

/** live 行 → 冻结条目（软删/缺失返回 null；复用 contextEntriesOf 的白名单挑键） */
function liveEntryOf(
  db: Db,
  teacherId: string,
  kind: "material" | "group",
  id: string,
): AttemptContextSnapshotEntry | null {
  if (kind === "material") {
    const row = getMaterial(db, teacherId, id);
    return row === null
      ? null
      : (contextEntriesOf({ materials: [row], groups: [] })[0] ?? null);
  }
  const row = getQuestionGroup(db, teacherId, id);
  return row === null
    ? null
    : (contextEntriesOf({ materials: [], groups: [row] })[0] ?? null);
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
  const materialsList: AttemptContextMaterial[] = [];
  const groupsList: AttemptContextGroup[] = [];
  for (const row of listAttemptContextSnapshots(db, attemptId)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshotJson) as unknown;
    } catch {
      parsed = undefined;
    }
    if (row.kind === "material") {
      const material = materialPublicSchema.safeParse(parsed);
      if (!material.success) throw brokenSnapshotError(row);
      materialsList.push({
        ...material.data,
        sourceVersion: row.sourceVersion,
      });
    } else {
      const group = questionGroupPublicSchema.safeParse(parsed);
      if (!group.success) throw brokenSnapshotError(row);
      groupsList.push({ ...group.data, sourceVersion: row.sourceVersion });
    }
  }
  const byIdThenVersion = (
    a: { id: string; sourceVersion: number },
    b: { id: string; sourceVersion: number },
  ): number => a.id.localeCompare(b.id) || a.sourceVersion - b.sourceVersion;
  return {
    attemptId,
    materials: materialsList.sort(byIdThenVersion),
    groups: groupsList.sort(byIdThenVersion),
  };
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
function closureRefIds(
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
