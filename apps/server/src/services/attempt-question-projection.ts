import {
  type AttemptQuestionPublic,
  type AttemptResultQuestion,
  attemptQuestionPublicSchema,
  emptyPublicStructure,
  inspectShapeOfAnswer,
  type MatchingOptionsStudent,
  type MatchingSlot,
  matchingPublicStructureOf,
  materialPublicSchema,
  NEW_QUESTION_TYPES,
  type OrderingItemStudent,
  orderingPublicStructureOf,
  type PublicStructureByKind,
  type Question,
  questionEvidenceBindings,
  type StudentAnswer,
} from "@tutor/contract";
import {
  expandSelectionIds,
  parseDocument,
  studentStemMd,
  wrapSingleQuestionMd,
} from "@tutor/md-dsl";
import type { Db } from "../db/client";
import type { ResponseRow } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { responseTimeOf } from "./attempt-time-projection";
import { resultHintsOpenedOf } from "./hint-service";
import { listAttemptContextSnapshots } from "./material-repository.ts";
import { selfReviewRecordOf } from "./response-verdict.ts";
import { rubricReviewOf } from "./rubric-review-read";
import { answerOf, releaseOfSnapshot } from "./snapshot";

/**
 * 冻结快照（契约 Question）→ attempt 视图公开题目（T6R.3）：stemMd 经
 * studentStemMd 学生端唯一投影（options 另行下发时剥除题干内嵌选项任务列表 +
 * [[答案]] → [[]] 脱敏）、options 转纯文本、hints 只留数量，
 * answers/solutionMd/sourceMd 一律剥离——与 publicQuestionsOfRows 同一防泄露
 * 口径（fail closed，经 attemptQuestionPublicSchema.parse strip 未知键）。
 * questionRevisionId = 该题冻结 responses 行 id（不透明版本引用，交卷回传）。
 * 2026-10 讲练一体起导出：lesson-service 开卷投影的 questions 平铺复用
 * （同一 fail-closed 投影，防泄露口径单一出处）。
 */
export function publicOfSnapshot(
  question: Question,
  questionRevisionId: string,
  options: {
    readonly questionVersion?: number;
    /** 冻结材料槽位序（materialId → 有序 slotId）；matching 槽位集合展开用 */
    readonly materialSlots?: ReadonlyMap<string, readonly string[]>;
    /** 冻结行单元归属（responses.unitId；审查 P2-1 旧快照兜底重抽的语境） */
    readonly unitId?: string | null;
  } = {},
): AttemptQuestionPublic {
  // 审查 P2-1：旧格式冻结快照（三结构键全缺）从快照自身 sourceMd 兜底重抽
  const structure = effectiveStructureOfSnapshot(
    question,
    options.unitId ?? null,
  );
  return attemptQuestionPublicSchema.parse({
    id: question.id,
    type: question.type,
    difficulty: question.difficulty,
    knowledge: question.knowledge,
    stemMd: studentStemMd(question),
    ...(question.options !== undefined
      ? { options: question.options.map((option) => option.text) }
      : {}),
    // QM-09：response 字数建议（word-min/max）随公开投影下发——仅提示性
    // 数字，不含任何参考内容（§5.4.1 不硬校验不截断）
    ...(question.wordMin !== undefined ? { wordMin: question.wordMin } : {}),
    ...(question.wordMax !== undefined ? { wordMax: question.wordMax } : {}),
    // 模块 3：量表是公开评价项（无参考内容），作答时就让学习者看到
    ...(question.rubric !== undefined ? { rubric: question.rubric } : {}),
    // QM-13：matching 选项池 / ordering 项与展开槽位集合（slots= 区间按材料
    // 槽位序展开，材料快照缺失不携带键——学生端呈现防御形态）。2026-10-25
    // 审查 P1 收紧：两结构走学生面变体（剥离 distractor，ordering 附
    // sortableCount 计数），教师侧全量不经本投影
    ...(structure.matchingOptions !== undefined
      ? { matchingOptions: matchingOptionsStudentOf(structure.matchingOptions) }
      : {}),
    ...(structure.orderingItems !== undefined
      ? orderingStudentOf(structure.orderingItems)
      : {}),
    ...matchingSlotsProjection(structure, options.materialSlots),
    // 审查 P2-2：题级材料引用随公开投影下发（材料 id 与选择串属题面公开
    // 内容；web 单题导出闭包据此与服务端组∪题级同源）。旧快照经
    // effectiveStructureOfSnapshot 兜底重抽同样携带；无引用题不注入键
    ...(structure.materialRefs !== undefined
      ? { materialRefs: structure.materialRefs }
      : {}),
    hintCount: question.hints.length,
    questionRevisionId,
    ...(options.questionVersion === undefined
      ? {}
      : { questionVersion: options.questionVersion }),
  });
}

/**
 * 快照的作答面结构（含旧快照兜底，2026-10-25 审查 P2-1）：
 * snapshot.matchingOptions / orderingItems / materialRefs **三键全缺**（QM-13
 * 之前冻结的旧快照）且题型属新题型时，从快照自身的 sourceMd 重抽
 * （qmStructureOfSourceMd 同款管线：wrapSingleQuestionMd + parseDocument +
 * 按 id 命中后只取结构字段）。**不引活库**——教师改题库不影响已开卷的卷，
 * 冻结语义不变；重抽只在本次投影内使用，不回写库。导入规范化后新题型 id
 * 恒显式（缺省 id 推导不参与命中）；未命中/解析失败保持缺省（学生端呈现
 * 防御形态）。部分缺键（非全缺）= 真脏数据，同样保持缺省不兜底。
 */
function effectiveStructureOfSnapshot(
  snapshot: Question,
  unitId: string | null,
): Pick<Question, "matchingOptions" | "orderingItems" | "materialRefs"> {
  if (
    !NEW_QUESTION_TYPES.includes(snapshot.type) ||
    snapshot.matchingOptions !== undefined ||
    snapshot.orderingItems !== undefined ||
    snapshot.materialRefs !== undefined
  ) {
    return snapshot;
  }
  try {
    const parsed = parseDocument(
      wrapSingleQuestionMd(unitId ?? "", snapshot.sourceMd),
      { unitId: unitId ?? "", questionStartNumber: 1 },
    );
    const hit = parsed.units
      .flatMap((unit) => unit.questions)
      .find((item) => item.id === snapshot.id);
    if (hit === undefined) return snapshot;
    return {
      ...(hit.matchingOptions !== undefined
        ? { matchingOptions: hit.matchingOptions }
        : {}),
      ...(hit.orderingItems !== undefined
        ? { orderingItems: hit.orderingItems }
        : {}),
      ...(hit.materialRefs !== undefined
        ? { materialRefs: hit.materialRefs }
        : {}),
    };
  } catch {
    // sourceMd 损坏（历史脏行）不阻断投影：结构缺失走防御形态
    return snapshot;
  }
}

/**
 * 学生面 matching 选项池（2026-10-25 审查 P1 收紧）：剥离逐项 distractor 键
 * ——干扰项身份属答案侧信息，不随学生载荷下发（教师侧全量结构由
 * matchingOptionsSchema 承载，保存校验继续用快照全量）。匹配呈现零消费标记。
 */
function matchingOptionsStudentOf(
  pool: NonNullable<Question["matchingOptions"]>,
): MatchingOptionsStudent {
  return {
    allowRepeat: pool.allowRepeat,
    options: pool.options.map((option) => ({
      id: option.id,
      text: option.text,
    })),
  };
}

/**
 * 学生面 ordering 项 + sortableCount（2026-10-25 审查 P1 收紧）：逐项剥离
 * distractor 键（ordering 干扰项由参考序列推导，逐项下发=公布前枚举答案成员）；
 * 学生要自行放置的项数（非干扰且非固定）改以计数下发，板行数与完成度由它
 * 派生（固定项恒非干扰——fixedPosition 声明自参考序列）。
 */
function orderingStudentOf(items: NonNullable<Question["orderingItems"]>): {
  orderingItems: OrderingItemStudent[];
  sortableCount: number;
} {
  return {
    orderingItems: items.map(({ id, text, fixedPosition }) => ({
      id,
      text,
      fixedPosition,
    })),
    sortableCount: items.filter(
      (item) => !item.distractor && item.fixedPosition === null,
    ).length,
  };
}

/**
 * matching 槽位集合投影：题级 ::ref{slots=} 按材料槽位序展开（QM-13 细项 2），
 * 2026-10-25 审查 P2-2 起行附材料槽位序 ordinal（材料文档位置 1 起）——子集
 * 选择（slots=slot-3..slot-5）沿用材料编号 3/4/5，题内「第 N 空」标签与材料
 * 面板编号空位（N）对齐，不用题内重排的 1/2/3。
 * 门控走数据驱动（materialRefs[].slots 存在性）而非题型字面量分支（I16）：
 * lint 第二遍已保证 slots= 只出现在 matching 题（references.ts 收口），其他
 * 题型的 materialRefs 无 slots 键、展开恒为空。
 */
function matchingSlotsProjection(
  question: Pick<Question, "materialRefs">,
  materialSlots: ReadonlyMap<string, readonly string[]> | undefined,
): { matchingSlots?: MatchingSlot[] } {
  if (question.materialRefs === undefined || materialSlots === undefined) {
    return {};
  }
  const rows: MatchingSlot[] = [];
  for (const ref of question.materialRefs) {
    if (ref.slots === undefined) continue;
    const order = materialSlots.get(ref.material);
    if (order === undefined) continue;
    for (const id of expandSelectionIds(ref.slots, order)) {
      if (rows.some((row) => row.id === id)) continue;
      // 展开产物必属材料槽位序（lint SLOT_UNBOUND 收口）；显式单点的未知 id
      // 属防御形态，无材料位置可言，回落题内行序保证 ordinal 恒正
      const at = order.indexOf(id);
      rows.push({ id, ordinal: at >= 0 ? at + 1 : rows.length + 1 });
    }
  }
  return rows.length > 0 ? { matchingSlots: rows } : {};
}

/**
 * 冻结材料槽位序（QM-13）：attemptId → materialId → 有序 slotId 列表。
 * 读 attempt_context_snapshots 冻结快照，同 id 多版本取最高 sourceVersion
 * （行序已按 sourceVersion 升序，后写覆盖即最新；与 attempt-context-view
 * latestById 同口径）；坏快照/坏 JSON 跳过该条不抛错（投影侧防御口径：
 * matchingSlots 缺失只是少作答面，不让单条脏快照打挂整卷取卷——与
 * /context 端点的显式 409 口径不同，后者是学生显式读上下文的独立防线）。
 */
export function materialSlotOrderOf(
  db: Db,
  attemptId: string,
): Map<string, readonly string[]> {
  const order = new Map<string, readonly string[]>();
  for (const row of listAttemptContextSnapshots(db, attemptId)) {
    if (row.kind !== "material") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshotJson) as unknown;
    } catch {
      continue;
    }
    const material = materialPublicSchema.safeParse(parsed);
    if (!material.success || material.data.slots.length === 0) continue;
    order.set(
      material.data.id,
      material.data.slots.map((slot) => slot.id),
    );
  }
  return order;
}

/**
 * 快照 → 完整公开结构集（QM-13 保存校验用；QM-16 起导出/序列化共用出口）：
 * matching 选项池 + 展开槽位集合、ordering 项；旧快照（三键全缺）先经
 * effectiveStructureOfSnapshot 兜底重抽（审查 P2-1）。结构仍缺失（选项池/
 * 排序项/材料槽位快照不可用或重抽未命中）按 emptyPublicStructure 防御形态
 * （inspectShape 对空结构无从校验即放行，只影响该维度校验，不影响其余防线）。
 * QM-16：matchingSlots 行附材料槽位序 ordinal 映射进结构（slotOrdinals），
 * 文本化「第 N 空」与材料面板（N）编号同口径——待批队列/CSV/单题包/AI
 * 受控出口的配对答案序列化共用本函数，不另写结构装配。
 */
export function structuresOfSnapshot(
  snapshot: Question,
  materialSlots: ReadonlyMap<string, readonly string[]>,
  unitId: string | null,
): PublicStructureByKind {
  const structure = effectiveStructureOfSnapshot(snapshot, unitId);
  const matchingSlots =
    structure.matchingOptions !== undefined
      ? (matchingSlotsProjection(structure, materialSlots).matchingSlots ?? [])
      : [];
  const matching =
    structure.matchingOptions !== undefined
      ? matchingPublicStructureOf(
          structure.matchingOptions,
          // 结构校验只认槽位 id 集合（P2-2 的 ordinal 是呈现用材料序，校验零消费）
          matchingSlots.map((row) => row.id),
          // QM-16：ordinal 映射（slotOrdinals）——结构校验零消费，序列化消费
          Object.fromEntries(matchingSlots.map((row) => [row.id, row.ordinal])),
        )
      : emptyPublicStructure.matching;
  const ordering =
    structure.orderingItems !== undefined
      ? orderingPublicStructureOf(structure.orderingItems)
      : emptyPublicStructure.ordering;
  return { ...emptyPublicStructure, matching, ordering };
}

/** 保存或直接提交前核对冻结题型和答案结构。 */
export function assertFrozenAnswerShape(
  db: Db,
  row: Pick<ResponseRow, "attemptId" | "unitId">,
  snapshot: Question,
  answer: StudentAnswer,
): void {
  if (questionEvidenceBindings[snapshot.type].answerKind !== answer.kind) {
    throw new HttpError(400, "VALIDATION_ERROR", "答案类型与题型不一致");
  }
  const options = (snapshot.options ?? []).map(({ text }, index) => ({
    key: String(index),
    index,
    text,
  }));
  const issues = inspectShapeOfAnswer(answer, {
    ...structuresOfSnapshot(
      snapshot,
      NEW_QUESTION_TYPES.includes(snapshot.type)
        ? materialSlotOrderOf(db, row.attemptId)
        : new Map(),
      row.unitId,
    ),
    choice: { options },
    multi: { options },
  });
  if (issues.length > 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "答案结构不合法");
  }
}

/**
 * 结果视图的单题行（快照投影：除已解锁条目外无 hints 内容，options 转纯文本；
 * D9〔T3.5〕新增 teacherMark / teacherComment / finalCorrect 透传 responses 行）。
 * 快照由调用方传入（buildResultData 预加载或现场 parse，单一解析出口 snapshotOfRow）。
 * **stemMd 是作答时原文（含 [[答案]] 标记）**——学生端消费方一律先经
 * studentFacingResultOf 整题投影（唯一包装处，不得再各自手写）。2026-10
 * 讲练一体起导出供 lesson-service 复用。
 */
export function resultQuestionOf(
  row: ResponseRow,
  snapshot: Question,
  options: {
    /** 冻结材料槽位序（QM-13：matching 槽位集合展开用；缺省不携带键） */
    readonly materialSlots?: ReadonlyMap<string, readonly string[]>;
    /** 模块 3：给了 db 才投影量表三份记录与在途判卷任务（题无量表不注入键） */
    readonly db?: Db;
    readonly time?: import("@tutor/contract").ResponseTime | undefined;
  } = {},
): AttemptResultQuestion {
  // 审查 P2-1：旧格式冻结快照（三结构键全缺）从快照自身 sourceMd 兜底重抽
  // （行内冻结单元归属作解析语境；不引活库）
  const structure = effectiveStructureOfSnapshot(snapshot, row.unitId);
  return {
    questionId: row.questionId,
    settlementSeq: row.settlementSeq,
    activeSec: row.activeSec,
    changeCount: row.changeCount,
    hintsUsed: row.hintsUsed,
    // 题目版本引用（responses 行 id）：订正工作台原位圈画建底图布局的身份
    // 三要素之一（与作答视图同源；对学生不透明，旧客户端忽略）
    ...(options.time
      ? { time: options.time }
      : options.db
        ? { time: responseTimeOf(options.db, row.attemptId, row.id) }
        : {}),
    questionRevisionId: row.id,
    publicQuestion: publicOfSnapshot(snapshot, row.id, {
      questionVersion: row.questionVersion,
      ...(options.materialSlots
        ? { materialSlots: options.materialSlots }
        : {}),
      unitId: row.unitId,
    }),
    snapshot: {
      id: snapshot.id,
      type: snapshot.type,
      difficulty: snapshot.difficulty,
      knowledge: snapshot.knowledge,
      stemMd: snapshot.stemMd,
      ...(snapshot.options !== undefined
        ? { options: snapshot.options.map((option) => option.text) }
        : {}),
      // QM-13：matching/ordering 作答面结构随结果快照下发（对照呈现需要）；
      // 2026-10-25 审查 P1 收紧：学生面变体（剥离 distractor，ordering 附
      // sortableCount 计数）——对照呈现不需要逐项干扰标记
      ...(structure.matchingOptions !== undefined
        ? {
            matchingOptions: matchingOptionsStudentOf(
              structure.matchingOptions,
            ),
          }
        : {}),
      ...matchingSlotsProjection(structure, options.materialSlots),
      ...(structure.orderingItems !== undefined
        ? orderingStudentOf(structure.orderingItems)
        : {}),
      // P1-2：题级材料引用随结果快照下发（材料 id/选择串属题面公开内容；
      // 回看题级材料锚解析用，正文仍走 /context 冻结白名单投影）
      ...(snapshot.materialRefs !== undefined &&
      snapshot.materialRefs.length > 0
        ? { materialRefs: snapshot.materialRefs }
        : {}),
      hintCount: snapshot.hints.length,
    },
    ...releaseOfSnapshot(snapshot),
    answer: answerOf(row.answerJson),
    autoCorrect: row.autoCorrect,
    // D9：教师批注与最终判定（D3 持久化口径；公布 gate 在 releaseAwareQuestion 投影）
    teacherMark:
      row.teacherMark === "correct" || row.teacherMark === "wrong"
        ? row.teacherMark
        : null,
    teacherComment: row.teacherComment,
    finalCorrect: row.finalCorrect,
    // #6980-3：是否有实际作答（判分写点落库；finalCorrect=false 且 answered=false
    // 时端上灰显「未做」，练习本卷错题默认不含）
    answered: row.answered,
    // #6980-4：做题时自标「不会」（交卷后只读事实，不受公布 gate 影响）
    studentFlag: row.studentFlag === "unsure" ? "unsure" : null,
    // QM-11（TT-09b）：行级自评状态与判分策略（公布 gate 在
    // releaseAwareQuestion 投影为 null——未公布形态无自评入口；record=null
    // 表示未评或已撤回，revision 是 CAS 基线、undecided 清除亦递增）
    selfReview: {
      record: selfReviewRecordOf(row),
      revision: row.selfReviewRevision,
    },
    gradingPolicy: row.gradingPolicy,
    ...(options.db !== undefined && snapshot.rubric !== undefined
      ? { rubricReview: rubricReviewOf(options.db, row, snapshot) }
      : {}),
    // T2.11：只回显做题时已解锁的提示（文本取自快照；未解锁条目绝不在此）
    hintsOpened: resultHintsOpenedOf(row, snapshot.hints),
  };
}

/**
 * 结果条目的学生端整题投影（防泄露不变式的唯一包装处，2026-10 讲练一体收敛
 * 三份手写副本）：在 resultQuestionOf 条目之上把 snapshot.stemMd 经
 * studentStemMd 投影（[[答案]] → 空框、剥题干内嵌选项列表——AGENTS 第 3 条，
 * 学生端题干唯一入口）。三个消费方：buildResultData 的 releaseAwareQuestion
 * （已公布也投影）、submitLessonQuestion 响应（提交即释放）、lesson-service
 * 的 released 条目（当题释放）。
 */
export function studentFacingResultOf(
  item: AttemptResultQuestion,
): AttemptResultQuestion {
  return {
    ...item,
    snapshot: { ...item.snapshot, stemMd: studentStemMd(item.snapshot) },
  };
}
