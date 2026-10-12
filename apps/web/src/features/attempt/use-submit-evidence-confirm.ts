import { useCallback, useRef, useState } from "react";
import type { SubmitEvidenceProblem } from "@/features/notes/submit-evidence";
import { snapshotNoteOverview } from "@/features/notes/submit-evidence";
import type {
  SubmitNoteProblemView,
  SubmitNoteSummary,
} from "./SubmitConfirmDialog";

/**
 * 交卷/完成练习的证据确认状态机（T6R.10 语义单源；2026-10 讲练一体起
 * 整卷 AnswerView 与讲练页 LessonAnswerView 共用）：
 * - phase 单一判别联合（idle/preparing/error/choice，一次 set 完成迁移，
 *   无中间组合态）；
 * - 打开弹层即重置缺稿确认集并取草稿本地快览（无网络纯内存态——确认时以
 *   prepareSubmitEvidence 的权威判定为准）；快览带代际守卫：仅最新一次
 *   open 的 then 可 set，旧 open 的迟到快照作废；
 * - 确认流程骨架：preparing → 注入的提交编排（各页面把自身链路收敛为
 *   EvidenceConfirmOutcome）→ submitted 关弹层 / problems 切明确选择 /
 *   error 保留最近一次 problems 快照（错误文案与清单都可见）；
 * - 缺稿确认**并集累积**：两批 problem 先后出现（A 持续未愈 + B 新增冲突）
 *   各自确认后都必须按用户明示的 missing 提交——覆盖式赋值会丢掉第一批
 *   确认（P0-1 历史修复语义，勿改）。
 */

export type EvidenceConfirmPhase =
  | { kind: "idle" }
  | { kind: "preparing" }
  /** 阻止性错误（head 拉取失败等）；problems=进入 error 前的最近一次清单
   *  （choice 快照，可 null）——错误文案与问题列表都可见 */
  | { kind: "error"; message: string; problems: SubmitEvidenceProblem[] | null }
  /** 明确选择分支（problems 必非空：由 declarations=null ⇔ problems.length>0 推导） */
  | { kind: "choice"; problems: SubmitEvidenceProblem[] };

/** 注入提交编排的运行上下文（页面据此读取/操作缺稿确认集与两段 busy） */
export interface EvidenceConfirmContext {
  /** 用户已明确确认缺稿的题集（null=本轮尚无确认——不传 allowMissing） */
  missingConfirmed: ReadonlySet<string> | null;
  /** 清空缺稿确认集（AnswerView：阻止性错误后下轮普通确认重新权威判定，
   *  缺稿题重新显式确认；讲练页收尾不调用——重试整条链沿用已确认集） */
  clearMissingConfirmed: () => void;
  /** 两段 busy 前沿：准备完毕、进入提交——不再显示「正在同步草稿」 */
  enterSubmitting: () => void;
}

/** 注入提交编排的结果口径（页面把自身链路翻译成该联合） */
export type EvidenceConfirmOutcome =
  /** 流程完成：关弹层、回 idle（含页面已自行收尾仅需收场的场景） */
  | { kind: "submitted" }
  /** 有未追平草稿：切「草稿未保存完整」明确选择分支（problems 必非空） */
  | { kind: "problems"; problems: SubmitEvidenceProblem[] }
  /** 阻止性错误：如实提示并保留最近一次 problems 快照 */
  | { kind: "error"; message: string }
  /** 页面已自行收场（如弹层关闭中止链路）：状态机不动 */
  | { kind: "aborted" };

export interface UseSubmitEvidenceConfirmOptions {
  attemptId: string;
  /** 全卷题号集合（快览范围；引用变化自动取最新） */
  questionIds: readonly string[];
  /** 确认后执行的提交编排（整卷六步链/讲练收尾由页面注入；经 ref 取最新） */
  run: (ctx: EvidenceConfirmContext) => Promise<EvidenceConfirmOutcome>;
}

/**
 * 证据确认弹层的共享状态机：open/cancel/confirm/confirmMissing + 快览。
 * 弹层渲染（SubmitConfirmDialog）与题号映射由页面接线。
 */
export function useSubmitEvidenceConfirm(
  options: UseSubmitEvidenceConfirmOptions,
): {
  confirmOpen: boolean;
  phase: EvidenceConfirmPhase;
  /** 弹层打开时的草稿计数快览（本地态；详见 snapshotNoteOverview） */
  noteSummary: SubmitNoteSummary | null;
  /** 打开弹层：重置缺稿确认集与快览（带代际守卫） */
  open: () => void;
  /** 关闭弹层 = 取消：回 idle（页面可在包装里追加自身中止逻辑） */
  cancel: () => void;
  /** 普通确认（缺稿确认集经 ctx 注入提交编排） */
  confirm: () => Promise<void>;
  /** 缺稿明确确认：并集累积后重跑提交编排 */
  confirmMissing: () => void;
} {
  const { attemptId } = options;
  // run/questionIds 经 ref 取最新：页面编排随依赖重建时无需重挂本状态机
  const runRef = useRef(options.run);
  runRef.current = options.run;
  const questionIdsRef = useRef(options.questionIds);
  questionIdsRef.current = options.questionIds;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState<EvidenceConfirmPhase>({ kind: "idle" });
  const [noteSummary, setNoteSummary] = useState<SubmitNoteSummary | null>(
    null,
  );
  /** 快览代际（防旧 open 的迟到 then 覆盖新一轮弹层数据） */
  const summarySeqRef = useRef(0);
  /** 用户已确认缺稿交卷的题（「草稿未保存完整」明确选择后重跑组装传入） */
  const missingConfirmedRef = useRef<Set<string> | null>(null);
  /** phase 经 ref 取最新：confirmMissing 守卫读点击时刻的阶段，不闭包旧值 */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const open = useCallback(() => {
    setPhase({ kind: "idle" });
    missingConfirmedRef.current = null;
    setNoteSummary(null); // 上一轮的快览不带入新弹层
    setConfirmOpen(true);
    // 快照代际守卫：仅最新一次 open 的 then 可 set（旧 open 的迟到快照作废）
    const seq = ++summarySeqRef.current;
    void snapshotNoteOverview({
      attemptId,
      questionIds: questionIdsRef.current,
    }).then((statuses) => {
      if (seq !== summarySeqRef.current) return;
      const willFreeze = statuses.filter(
        (s) => s.kind === "will-freeze",
      ).length;
      const problem = statuses.filter((s) => s.kind === "problem").length;
      // 完全没动过草稿时不展示该区（避免无信息噪音）
      setNoteSummary(
        willFreeze + problem > 0
          ? {
              willFreeze,
              problem,
              unwritten: statuses.length - willFreeze - problem,
            }
          : null,
      );
    });
  }, [attemptId]);

  const cancel = useCallback(() => {
    setPhase({ kind: "idle" });
    setConfirmOpen(false);
  }, []);

  const confirm = useCallback(async () => {
    setPhase({ kind: "preparing" });
    const outcome = await runRef.current({
      missingConfirmed: missingConfirmedRef.current,
      clearMissingConfirmed: () => {
        missingConfirmedRef.current = null;
      },
      enterSubmitting: () => {
        setPhase({ kind: "idle" });
      },
    });
    if (outcome.kind === "submitted") {
      setConfirmOpen(false);
      setPhase({ kind: "idle" });
      return;
    }
    if (outcome.kind === "problems") {
      setPhase({ kind: "choice", problems: outcome.problems });
      return;
    }
    if (outcome.kind === "error") {
      // 阻止性失败：如实提示 + 保留最近一次 problems 清单（进入 error 前的
      // choice 快照）——错误文案与问题列表都可见
      setPhase((prev) => ({
        kind: "error",
        message: outcome.message,
        problems: prev.kind === "choice" ? prev.problems : null,
      }));
    }
    // aborted：页面已自行收场（如关闭中止），状态机不动
  }, []);

  const confirmMissing = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "choice") return;
    // 并集累积（P0-1）：两批 problem 先后出现各自确认后都按 missing 提交——
    // 覆盖式赋值会丢掉第一批确认
    const confirmed = new Set(missingConfirmedRef.current ?? []);
    for (const problem of current.problems)
      confirmed.add(problem.questionId);
    missingConfirmedRef.current = confirmed;
    void confirm();
  }, [confirm]);

  return {
    confirmOpen,
    phase,
    noteSummary,
    open,
    cancel,
    confirm,
    confirmMissing,
  };
}

/**
 * phase 携带的 problems → 弹层视图行（题号查表；不在卷内的防御条目过滤，
 * 不渲染「第 0 题」）。choice 相与 error 相（携带最近一次清单）共用。
 */
export function evidenceProblemViewsOf(
  phase: EvidenceConfirmPhase,
  indexById: ReadonlyMap<string, number>,
): SubmitNoteProblemView[] | null {
  if (phase.kind !== "choice" && phase.kind !== "error") return null;
  return (
    phase.problems
      ?.map((problem) => {
        const index = indexById.get(problem.questionId);
        return index === undefined
          ? null
          : {
              index,
              reason: problem.reason,
              ...(problem.domain ? { domain: problem.domain } : {}),
            };
      })
      .filter(
        (view): view is { index: number; reason: string } => view !== null,
      ) ?? null
  );
}
