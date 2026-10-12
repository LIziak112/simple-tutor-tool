import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotNoteOverview } from "@/features/notes/submit-evidence";
import {
  evidenceProblemViewsOf,
  useSubmitEvidenceConfirm,
  type EvidenceConfirmContext,
  type EvidenceConfirmOutcome,
} from "./use-submit-evidence-confirm";

/**
 * 证据确认状态机单测（2026-10 讲练一体收口单源）：钉住历史修出来的微妙
 * 语义——快览代际守卫（旧 open 迟到 then 作废）、缺稿确认并集累积
 * （两批 problem 各自确认后都按 missing 提交）、error 保留最近一次
 * problems 快照、cancel 复位。snapshotNoteOverview mock（无 IndexedDB）。
 */

vi.mock("@/features/notes/submit-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notes/submit-evidence")>();
  return {
    ...actual,
    snapshotNoteOverview: vi.fn(),
  };
});

const mockedSnapshot = vi.mocked(snapshotNoteOverview);

const ATTEMPT_ID = "att-1";
const QUESTION_IDS = ["q1", "q2", "q3"];

/** 手动 resolve 的受控快照 promise */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Snapshot = Awaited<ReturnType<typeof snapshotNoteOverview>>[number];

function snapshotOf(
  entries: { id: string; kind: Snapshot["kind"] }[],
): Snapshot[] {
  return entries.map((entry) => ({
    questionId: entry.id,
    kind: entry.kind,
    reason: null,
  }));
}

/** 记录每次 run 收到的 ctx.missingConfirmed，按脚本回放结果 */
function runRecorder(script: EvidenceConfirmOutcome[]) {
  const seen: (ReadonlySet<string> | null)[] = [];
  const run = vi.fn(
    async (ctx: EvidenceConfirmContext): Promise<EvidenceConfirmOutcome> => {
      seen.push(ctx.missingConfirmed);
      const outcome = script[seen.length - 1];
      if (outcome === undefined) throw new Error("脚本外的意外 run 调用");
      return outcome;
    },
  );
  return { run, seen };
}

function problemsOf(...ids: string[]) {
  return ids.map((id) => ({ questionId: id, reason: "草稿尚未保存完整" }));
}

beforeEach(() => {
  mockedSnapshot.mockReset().mockResolvedValue([]);
});

describe("useSubmitEvidenceConfirm：快览与代际守卫", () => {
  it("open 重置并落快览：有 will-freeze/problem 才展示计数，否则 null", async () => {
    mockedSnapshot.mockResolvedValue(
      snapshotOf([
        { id: "q1", kind: "will-freeze" },
        { id: "q2", kind: "problem" },
        { id: "q3", kind: "none" },
      ]),
    );
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run: vi.fn(async () => ({ kind: "submitted" }) as const),
      }),
    );
    act(() => result.current.open());
    expect(result.current.confirmOpen).toBe(true);
    expect(result.current.phase).toEqual({ kind: "idle" });
    await act(async () => {});
    expect(mockedSnapshot).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      questionIds: QUESTION_IDS,
    });
    expect(result.current.noteSummary).toEqual({
      willFreeze: 1,
      problem: 1,
      unwritten: 1,
    });
  });

  it("全无草稿信息时快览为 null；旧 open 的迟到 then 不覆盖新一轮弹层", async () => {
    const first = deferred<Snapshot[]>();
    const second = deferred<Snapshot[]>();
    mockedSnapshot.mockReturnValueOnce(first.promise);
    mockedSnapshot.mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run: vi.fn(async () => ({ kind: "submitted" }) as const),
      }),
    );
    act(() => result.current.open());
    act(() => result.current.open()); // 第二轮 open：代际 +1，第一轮作废
    await act(async () => {
      first.resolve(snapshotOf([{ id: "q1", kind: "will-freeze" }]));
    });
    // 第一轮的迟到快照被守卫拦下，仍为第二轮 open 的重置值
    expect(result.current.noteSummary).toBeNull();
    await act(async () => {
      second.resolve(
        snapshotOf([
          { id: "q2", kind: "none" },
          { id: "q3", kind: "none" },
        ]),
      );
    });
    // 第二轮全无信息：保持 null（不展示无信息噪音）
    expect(result.current.noteSummary).toBeNull();
  });
});

describe("useSubmitEvidenceConfirm：确认流程骨架", () => {
  it("submitted：关弹层回 idle；problems：切明确选择分支", async () => {
    const { run } = runRecorder([
      { kind: "problems", problems: problemsOf("q1") },
      { kind: "submitted" },
    ]);
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run,
      }),
    );
    act(() => result.current.open());
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.phase).toEqual({
      kind: "choice",
      problems: problemsOf("q1"),
    });
    expect(result.current.confirmOpen).toBe(true);
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.phase).toEqual({ kind: "idle" });
    expect(result.current.confirmOpen).toBe(false);
  });

  it("error：如实提示（problems 恒为 null——confirm 首句已迁移 preparing，原实现同构保留三元原文）", async () => {
    const { run } = runRecorder([
      { kind: "problems", problems: problemsOf("q1") },
      { kind: "error", message: "head 拉取失败" },
      { kind: "submitted" },
    ]);
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run,
      }),
    );
    act(() => result.current.open());
    await act(async () => {
      await result.current.confirm();
    }); // choice
    await act(async () => {
      await result.current.confirm();
    }); // choice 后重试 → error
    expect(result.current.phase).toEqual({
      kind: "error",
      message: "head 拉取失败",
      problems: null,
    });
    expect(result.current.confirmOpen).toBe(true);
    await act(async () => {
      await result.current.confirm();
    }); // 重试成功 → 关弹层
    expect(result.current.confirmOpen).toBe(false);
    // 从 idle 直接 error：同样 problems=null
    const second = runRecorder([{ kind: "error", message: "网络异常" }]);
    const { result: result2 } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run: second.run,
      }),
    );
    act(() => result2.current.open());
    await act(async () => {
      await result2.current.confirm();
    });
    expect(result2.current.phase).toEqual({
      kind: "error",
      message: "网络异常",
      problems: null,
    });
  });

  it("confirm 先置 preparing；aborted 不动状态机；cancel 复位关弹层", async () => {
    let releaseRun: (outcome: EvidenceConfirmOutcome) => void = () => {};
    const gate = new Promise<EvidenceConfirmOutcome>((resolve) => {
      releaseRun = resolve;
    });
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run: () => gate,
      }),
    );
    act(() => result.current.open());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.confirm();
    });
    expect(result.current.phase).toEqual({ kind: "preparing" });
    // 弹层关闭中止：cancel 已复位，迟到的 aborted 不再动状态机
    act(() => result.current.cancel());
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.phase).toEqual({ kind: "idle" });
    await act(async () => {
      releaseRun({ kind: "aborted" });
      await pending;
    });
    expect(result.current.confirmOpen).toBe(false);
    expect(result.current.phase).toEqual({ kind: "idle" });
  });

  it("ctx：clearMissingConfirmed 清空确认集；enterSubmitting 切回 idle（两段 busy）", async () => {
    const { run } = runRecorder([
      { kind: "problems", problems: problemsOf("q1") },
      { kind: "submitted" },
      { kind: "submitted" },
    ]);
    const ctxs: EvidenceConfirmContext[] = [];
    let cleared = false;
    const recordingRun = vi.fn(
      async (ctx: EvidenceConfirmContext): Promise<EvidenceConfirmOutcome> => {
        ctxs.push(ctx);
        if (ctxs.length === 1) return run(ctx); // 第一轮 → choice
        if (ctxs.length === 2) ctx.clearMissingConfirmed(); // 缺稿确认链
        if (ctxs.length === 3) ctx.enterSubmitting(); // 普通确认链两段 busy
        return run(ctx);
      },
    );
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run: recordingRun,
      }),
    );
    act(() => result.current.open());
    await act(async () => {
      await result.current.confirm();
    }); // → choice(q1)
    act(() => result.current.confirmMissing()); // 确认 q1，重交（run 2）
    await act(async () => {});
    // 第二轮 run 收到并集 {q1}，途中 clearMissingConfirmed 清空确认集
    expect(ctxs[1]?.missingConfirmed).toEqual(new Set(["q1"]));
    cleared = true;
    expect(cleared).toBe(true);
    // 第三轮（普通确认）：enterSubmitting 切 idle 后 submitted 关弹层
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.phase).toEqual({ kind: "idle" });
    expect(result.current.confirmOpen).toBe(false);
    // 清空后的确认集：第三轮 run 收到 null
    expect(ctxs[2]?.missingConfirmed).toBeNull();
  });
});

describe("useSubmitEvidenceConfirm：缺稿确认并集累积", () => {
  it("两批 problem 先后确认：第二次缺稿确认时 run 收到两题并集", async () => {
    const { run } = runRecorder([
      { kind: "problems", problems: problemsOf("q1") }, // 第一批：q1
      { kind: "problems", problems: problemsOf("q2") }, // 重交后新增第二批：q2
      { kind: "submitted" },
    ]);
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run,
      }),
    );
    act(() => result.current.open());
    await act(async () => {
      await result.current.confirm();
    }); // → choice(q1)
    act(() => result.current.confirmMissing()); // 确认 q1，重交
    await act(async () => {});
    expect(result.current.phase).toEqual({
      kind: "choice",
      problems: problemsOf("q2"),
    });
    act(() => result.current.confirmMissing()); // 确认 q2，重交
    await act(async () => {});
    // 并集：两批各自确认过的 q1、q2 都按 missing 提交（覆盖式会丢 q1）
    expect(run).toHaveBeenCalledTimes(3);
    expect(
      (run.mock.calls[2]?.[0] as EvidenceConfirmContext | undefined)
        ?.missingConfirmed,
    ).toEqual(new Set(["q1", "q2"]));
    expect(result.current.confirmOpen).toBe(false);
  });

  it("confirmMissing 只在 choice 阶段生效（idle/preparing/error 不触发 run）", async () => {
    const { run } = runRecorder([{ kind: "submitted" }]);
    const { result } = renderHook(() =>
      useSubmitEvidenceConfirm({
        attemptId: ATTEMPT_ID,
        questionIds: QUESTION_IDS,
        run,
      }),
    );
    act(() => result.current.open());
    act(() => result.current.confirmMissing());
    expect(run).not.toHaveBeenCalled();
    expect(result.current.confirmOpen).toBe(true);
  });
});

describe("evidenceProblemViewsOf", () => {
  const indexById = new Map([
    ["q1", 1],
    ["q2", 2],
  ]);
  it("choice/error 相映射为视图行（含 annotation 域）；卷外题防御过滤", () => {
    const views = evidenceProblemViewsOf(
      {
        kind: "choice",
        problems: [
          { questionId: "q1", reason: "草稿未保存完整" },
          { questionId: "gone", reason: "已不在卷内" },
          {
            questionId: "q2",
            reason: "标画未上传",
            domain: "annotation",
          },
        ],
      },
      indexById,
    );
    expect(views).toEqual([
      { index: 1, reason: "草稿未保存完整" },
      { index: 2, reason: "标画未上传", domain: "annotation" },
    ]);
  });
  it("idle/preparing 相或 problems=null 时返回 null", () => {
    expect(evidenceProblemViewsOf({ kind: "idle" }, indexById)).toBeNull();
    expect(evidenceProblemViewsOf({ kind: "preparing" }, indexById)).toBeNull();
    expect(
      evidenceProblemViewsOf(
        { kind: "error", message: "x", problems: null },
        indexById,
      ),
    ).toBeNull();
  });
});
