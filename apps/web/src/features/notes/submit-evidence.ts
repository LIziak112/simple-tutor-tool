/**
 * 交卷证据声明组装（T6R.10，方案 §6.4「首版交卷：固定矢量，图片不阻塞」）：
 * 确认交卷时——等待本地落盘事务 → flushNoteSync 追平最终矢量 → 逐题拉取
 * 服务端 head（versionId/revision 的权威口径——跨设备/他标签页/丢回执都
 * 收敛到服务端事实）→ 产出每题声明：
 * - frozen：服务端 head 存在且本地无未追平改动 → 固定 head 版本
 *   （versionId+revision 原样回传，服务端 CAS 精确比对——head 又前进则
 *   409 NOTE_EVIDENCE_MISMATCH，前端提示重试交卷，不静默固定旧版）；
 * - none：确无草稿（本地无记录或空稿，且服务端无笔记行）；
 * - missing：**仅**用户明确选择「提交答案，草稿未保存完整」后
 *   （allowMissing 传入该题）——服务端记录 missing，本地稿保留，
 *   之后找回只能作为 supplement（T6R.15），不冒称原稿。
 *
 * 未决问题（不在 allowMissing 内的 conflict/denied/dirty/防御态）→
 * declarations=null 阻止交卷，由 SubmitConfirmDialog 呈现并给出明确选择。
 *
 * 判定唯一权威 = **追平后的当下 record 状态**（deriveServerState）：
 * flushNoteSync 的返回摘要不再消费——其各失败形态（conflict/denied/
 * backoff/dirty）在同时刻 record 上必有对应非空字段（摘要 denied/conflict/
 * synced 三值逐字段镜像 record；backoff/dirty 之分只来自调度器计时器，对
 * 「未保存完整」文案无语义差异），而摘要是哨兵时点的采样、早于本模块的
 * record 重读——采样后重试恰好成功（稿已落服务器）仍会被摘要误报为
 * 「未保存完整」，强迫用户走缺稿明确选择（验收修复 A-1）。
 * PNG 不阻塞：本模块不触碰图片派生队列（后台补图，补图只能挂既定版本）。
 */
import type {
  NoteHeadData,
  NoteServerBodyState,
  SubmitEvidenceDeclaration,
} from "@tutor/contract";
import { catchUpAnnotations } from "@/features/annotation/annotation-sync";
import { fetchStudentNoteHeadsApi, sealAttemptAnnotationsApi } from "@/lib/api";
import {
  deriveServerState,
  loadScratchRecords,
  type NoteLocalRecord,
} from "./note-store.ts";
import { catchUpNotes, currentNoteSession } from "./note-sync.ts";

/** 逐题展示分类（弹层快览/草稿状态区） */
export type SubmitNoteStatusKind =
  /** 已同步、交卷时固定为原稿 */
  | "will-freeze"
  /** 未追平/被拒/冲突——需处理或明确选择缺稿交卷 */
  | "problem"
  /** 未写草稿 */
  | "none";

export interface SubmitNoteStatus {
  questionId: string;
  kind: SubmitNoteStatusKind;
  /** kind=problem 时的中文原因（用户可读） */
  reason: string | null;
}

export interface SubmitEvidenceProblem {
  questionId: string;
  reason: string;
}

export interface SubmitEvidencePrep {
  /**
   * 全部题目可声明时为完整声明数组（与冻结题目集合一一对应）；
   * 存在未决问题（不在 allowMissing 内）时为 null——交卷被阻止。
   * blocked 与否由 problems.length 推导，无独立标志。
   */
  declarations: SubmitEvidenceDeclaration[] | null;
  /** 未决问题清单（declarations=null 时非空） */
  problems: SubmitEvidenceProblem[];
}

/** 单次批量头拉取超时（对齐 note-sync PUT 的 30s 桥接口径；T6R.14 起一次
 * POST 拉全卷头，超时作用于整批而非逐题） */
const NOTE_HEAD_TIMEOUT_MS = 30_000;

/** 待传未追平的通用文案（dirty/uploading 共用；原文两处字面量收敛） */
const UNTRACKED_NOTE_REASON = "草稿尚未保存完整（网络不稳定，正在重试）";
/** revision≥1 ⇒ currentVersionId 非空是契约不变量，违反时的防御文案 */
const HEAD_POINTER_BROKEN_REASON =
  "草稿服务端状态异常（头指针为空），请刷新后重试";
/** 本地有笔、无待传、head 已知却查无笔记行（内容从未到达服务端）的防御文案 */
const CONTENT_NEVER_LANDED_REASON =
  "草稿内容尚未保存到服务器（数据不一致，请重试同步）";

/**
 * 服务端维度派生态 → 用户可读原因（synced → null）。文案单点映射
 * （denied 保留 content/access 细分）；传 uploading=false 时不会得到
 * "uploading"，case 与 dirty 同文案只为穷尽性。
 */
function noteProblemReason(
  record: NoteLocalRecord,
  state: NoteServerBodyState,
): string | null {
  switch (state) {
    case "conflict":
      // 服务端权威中文为主体（NoteLayer 同源），前缀给交卷语境
      return `草稿同步冲突：${record.conflict?.reason ?? "需要先选择保留哪一份"}`;
    case "denied":
      return `草稿同步被拒：${record.denied?.reason ?? "请稍后重试"}`;
    case "uploading":
    case "dirty":
      // 无服务端文案（本地调度态）——自造交卷语境文案
      return UNTRACKED_NOTE_REASON;
    case "synced":
      return null;
  }
}

/** head 已知时可固定的服务端版本引用（freeze 载荷由分类单点产出） */
interface FreezableRef {
  versionId: string;
  revision: number;
}

/** 单题分类结果（两消费方共享：交卷组装传真实 head，弹层快览传 "unknown"） */
type NoteVerdict =
  | { kind: "problem"; reason: string }
  /** head 已知且服务端可固定——freeze 载荷随 verdict 单点产出（不变量：非空） */
  | { kind: "will-freeze"; freeze: FreezableRef }
  /** head 未知（快览）且本地有记录：乐观「待固定」——真实 freeze 待权威判定 */
  | { kind: "will-freeze-local" }
  | { kind: "none" };

/**
 * 单题分类（单一判定树，文案与防御口径单点共享）：
 * - record 派生态非 synced（conflict/denied/dirty）→ problem；
 * - head 已知且服务端有笔记行 → will-freeze + freeze 载荷（头指针空违反
 *   契约不变量按防御 problem）；head 已知却查无笔记行而本地有笔 → 防御
 *   problem（不能静默 none）；
 * - head 未知（"unknown"，弹层快览）不做服务端事实比对：有本地记录即按
 *   乐观「待固定」呈现（已同步空稿交卷也会 frozen——与权威方向一致）；
 *   无记录 → none。残余差异：跨设备他端有稿而本机无记录 → 快览 none、
 *   权威 frozen——快览是引导提示，确认时以真实 head 重跑。
 */
function classifyNote(
  record: NoteLocalRecord | null,
  head: NoteHeadData | "unknown",
): NoteVerdict {
  if (record !== null) {
    const reason = noteProblemReason(record, deriveServerState(record, false));
    if (reason !== null) return { kind: "problem", reason };
  }
  if (head === "unknown") {
    return record !== null ? { kind: "will-freeze-local" } : { kind: "none" };
  }
  const note = head.note;
  if (note !== null && note.revision > 0) {
    return note.currentVersionId !== null
      ? {
          kind: "will-freeze",
          freeze: {
            versionId: note.currentVersionId,
            revision: note.revision,
          },
        }
      : { kind: "problem", reason: HEAD_POINTER_BROKEN_REASON };
  }
  // head 已知且服务端无笔记行：本地有笔 = 内容从未到达服务端（防御）；
  // 空记录无内容可丢 → none
  return record !== null && record.doc.ink.strokes.length > 0
    ? { kind: "problem", reason: CONTENT_NEVER_LANDED_REASON }
    : { kind: "none" };
}

/**
 * 组装交卷证据声明（交卷确认流程的核心步骤；详见模块头）。
 * head 拉取失败（网络/权限）时抛错——状态未知不能声明，交卷流程据此
 * 提示重试并保持答题状态。
 */
export async function prepareSubmitEvidence(input: {
  attemptId: string;
  questionIds: readonly string[];
  /** 用户已明确选择缺稿交卷的题目（「草稿未保存完整」确认后重跑传入） */
  allowMissing?: ReadonlySet<string>;
}): Promise<SubmitEvidencePrep> {
  // ① 冻结编辑（模态弹层覆盖）后追平本卷草稿（先排干本地落盘再上传再
  //    排干——语义见 note-sync.catchUpNotes）
  await catchUpNotes(input.attemptId);

  // ①' T6R.20 标注固定（方案 §10「按次固定」＋计划决策 8）：flush 标注同步
  //    → POST seal（phase=scratch 全部 sealedAt，之后 PUT 409）——与
  //    flushNoteSync 同序（先追平后封存）。seal 幂等（重跑/重交安全）；
  //    网络失败抛错阻止交卷（可重试）。标注未追平（dirty/conflict）不阻止
  //    交卷——标注是独立附件（submission_evidence 表不动），本地稿保留。
  await catchUpAnnotations(input.attemptId);
  await sealAttemptAnnotationsApi(input.attemptId);

  // ② 本卷记录（attempt 前缀单事务装载，strictRead 读失败抛错≠无记录）
  //    与整卷服务端 head 同窗并发读取（T6R.14：一次批量 POST，N 逐题 GET
  //    收敛；head 全部成功才可声明——任一失败整组 reject 抛给调用方）
  const session = currentNoteSession();
  const [records, heads] = await Promise.all([
    session === null
      ? Promise.resolve(new Map<string, NoteLocalRecord>())
      : loadScratchRecords(session, input.attemptId, { strictRead: true }),
    // 整批超时（对齐 note-sync PUT 30s 桥接口径）；signal 经 hc
    // ClientRequestOptions.init 透传（C6 单分支）。
    // 返回值已由 api 收口为按请求序对齐的 head 数组（缺条在 api 层统一抛
    // 契约违错误——整组 reject 阻止交卷，不产出缺题声明）
    fetchStudentNoteHeadsApi(
      input.attemptId,
      input.questionIds,
      AbortSignal.timeout(NOTE_HEAD_TIMEOUT_MS),
    ),
  ]);

  // ③ 分类与声明
  const declarations: SubmitEvidenceDeclaration[] = [];
  const problems: SubmitEvidenceProblem[] = [];
  for (let i = 0; i < input.questionIds.length; i += 1) {
    const questionId = input.questionIds[i];
    const record = records.get(questionId ?? "") ?? null;
    const head = heads[i];
    if (questionId === undefined || head === undefined) {
      // 等长 map 一一对应产出，此分支理论不可达；若真发生绝不能静默跳过
      // （会返回缺题的 declarations、伪装成可刷新解决的 409）——按问题
      // 呈现阻止交卷
      problems.push({
        questionId: questionId ?? "",
        reason: "内部数据异常，请重试",
      });
      continue;
    }
    const verdict = classifyNote(record, head);

    if (verdict.kind === "problem") {
      if (input.allowMissing?.has(questionId) === true) {
        // 用户已明确选择缺稿交卷：如实声明 missing（本地稿保留）
        declarations.push({ questionId, state: "missing" });
        continue;
      }
      problems.push({ questionId, reason: verdict.reason });
      continue;
    }

    if (verdict.kind === "will-freeze") {
      // freeze 载荷由 classifyNote 单点产出（不变量非空）——消费方不再重复
      // 收窄 head.note（复审 #12：不变量单点化）
      declarations.push({
        questionId,
        state: "frozen",
        versionId: verdict.freeze.versionId,
        revision: verdict.freeze.revision,
      });
      continue;
    }
    if (verdict.kind === "will-freeze-local") {
      // prep 恒传真实 head（"unknown" 仅快览路径），运行时不可达；若发生
      // 按内部异常呈现（绝不静默归入 none——同防御分支口径）
      problems.push({ questionId, reason: "内部数据异常，请重试" });
      continue;
    }

    declarations.push({ questionId, state: "none" });
  }

  return {
    declarations: problems.length > 0 ? null : declarations,
    problems,
  };
}

/**
 * 弹层打开时的本地快览（无网络、纯内存态）：统计各题草稿展示分类，
 * 供 SubmitConfirmDialog 在用户点确认前展示「已同步待固定/未保存/未写」。
 * 与 prepareSubmitEvidence 的权威判定不同步到毫秒——确认时会以真实 head
 * 重跑组装，弹层文案只作引导提示（head 未知时本地有笔按乐观待固定呈现）。
 */
export async function snapshotNoteOverview(input: {
  attemptId: string;
  questionIds: readonly string[];
}): Promise<SubmitNoteStatus[]> {
  const session = currentNoteSession();
  // attempt 前缀单事务装载（#9）：无草稿的卷只有一次空 getAll，不再逐题
  // 空转 get；宽松口径（读失败≈无记录——展示性消费）
  const records =
    session === null
      ? new Map<string, NoteLocalRecord>()
      : await loadScratchRecords(session, input.attemptId);
  return input.questionIds.map((questionId) => {
    const verdict = classifyNote(records.get(questionId) ?? null, "unknown");
    // will-freeze-local 在展示口径折叠为 will-freeze（快览只有三态）
    return {
      questionId,
      kind: verdict.kind === "will-freeze-local" ? "will-freeze" : verdict.kind,
      reason: verdict.kind === "problem" ? verdict.reason : null,
    };
  });
}
