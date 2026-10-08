/**
 * T6R.10 交卷证据声明组装（submit-evidence）测试：追平后的当下 record
 * 状态（deriveServerState 单点判定）+ 整卷服务端 head（T6R.14 起一次批量
 * POST），产出每题 none/frozen/missing 声明与未决问题清单。
 * 覆盖：正常固定（本地已同步/跨设备仅有服务端稿）、失败呈现（dirty 退避/
 * conflict/denied(content)→问题清单、声明为 null）、用户明确选择 missing
 * 后仅问题题标 missing、问题自愈不硬标、head 拉取失败抛错阻止交卷、
 * 本地有笔无服务端稿（防御）不静默 none、空稿 none。
 * fetchStudentNoteHeadsApi 以 vi.fn 替换；putNoteDocumentApi 同（flush 真实
 * 执行）；内存后端注入；复用 note-test-utils 夹具。
 */
import type { NoteHeadData } from "@tutor/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docOf } from "@/features/notes/note-fixtures";
import {
  applyUploadConflict,
  applyUploadDenied,
  installNoteBackend,
  memoryNoteBackend,
  type NoteStoreBackend,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  DOC_A,
  headOf,
  noteHeadsMockResponse,
  receiptOf,
  SCOPE,
  SESSION_A,
  waitForLocalSaved,
} from "@/features/notes/note-test-utils";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
    fetchStudentNoteHeadsApi: vi.fn(),
    // T6R.20：交卷链路扩展的标注封存（幂等 sealedCount=0——真实语义由
    // annotation-sync/服务端测试覆盖，此处只解除网络依赖）
    sealAttemptAnnotationsApi: vi.fn(async () => ({
      phase: "scratch" as const,
      sealedCount: 0,
    })),
    putAnnotationDocApi: vi.fn(),
  };
});

import {
  bindNoteSession,
  catchUpNotes,
  resetNoteSession,
} from "@/features/notes/note-sync";
import {
  prepareSubmitEvidence,
  snapshotNoteOverview,
} from "@/features/notes/submit-evidence";
import {
  ApiError,
  fetchStudentNoteHeadsApi,
  putNoteDocumentApi,
} from "@/lib/api";

const putMock = vi.mocked(putNoteDocumentApi);
const headsMock = vi.mocked(fetchStudentNoteHeadsApi);

const ATTEMPT = SCOPE.attemptId;
const Q1 = SCOPE.questionId;
const Q2 = "p1-q2";
const Q3 = "p1-q3";
const QUESTIONS = [Q1, Q2, Q3];

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  bindNoteSession(SESSION_A);
  putMock.mockReset();
  headsMock.mockReset();
});

afterEach(async () => {
  resetNoteSession();
});

/** 写入一稿并等本地落盘（上传由 flush 强制追平，不在此等待） */
async function writeLocal(questionId: string, doc = DOC_A): Promise<void> {
  writeNoteDoc(
    SESSION_A,
    { attemptId: ATTEMPT, questionId, phase: "scratch" },
    doc,
  );
  await waitForLocalSaved(SESSION_A, {
    attemptId: ATTEMPT,
    questionId,
    phase: "scratch",
  });
}

/** rev1 head 投影换题号（headOf 夹具恒带 note——不带即夹具坏了，前置失败；
 *  note 覆盖项按需传入，调用方不再二次判空） */
function headAt(
  questionId: string,
  noteOverride: Partial<NonNullable<NoteHeadData["note"]>> = {},
): NoteHeadData {
  const base = headOf();
  const note = base.note;
  if (note === null) throw new Error("headOf 夹具应带 note");
  return { ...base, note: { ...note, questionId, ...noteOverride } };
}

/** head mock：默认空态（显式 notCreated 投影），覆盖表定制——共享工厂
 * noteHeadsMockResponse（W5 收敛）逐条回显；此卷空态 = headOf({note:null})
 * 形状（note 行显式 null），与共享工厂缺省一致 */
function mockHeads(overrides: Record<string, NoteHeadData>): void {
  headsMock.mockImplementation(noteHeadsMockResponse(overrides));
}

describe("prepareSubmitEvidence：正常固定", () => {
  it("本地已同步 + head 有版本 → frozen(head 权威 versionId/revision)；其余题 none", async () => {
    // 本地有笔；上传成功（回执 rev1）。head 显示他处已存到 rev2 → 按 head 声明
    await writeLocal(Q1, DOC_A);
    putMock.mockResolvedValue(receiptOf(1));
    mockHeads({
      [Q1]: headAt(Q1, {
        revision: 2,
        currentVersionId: receiptOf(2).versionId,
      }),
    });

    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });

    expect(prep.problems).toEqual([]);
    expect(prep.declarations).toEqual([
      {
        questionId: Q1,
        state: "frozen",
        versionId: receiptOf(2).versionId,
        revision: 2,
      },
      { questionId: Q2, state: "none" },
      { questionId: Q3, state: "none" },
    ]);
  });

  it("本地无记录但服务端有稿（跨设备/他标签页）→ frozen，不误报 none", async () => {
    mockHeads({ [Q2]: headAt(Q2) });
    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(prep.problems).toEqual([]);
    expect(prep.declarations?.find((d) => d.questionId === Q2)).toEqual({
      questionId: Q2,
      state: "frozen",
      versionId: receiptOf(1).versionId,
      revision: 1,
    });
  });

  it("清空后同步成功的空稿 → frozen 指向空版本（不误判 none/missing）；未建记录题 none", async () => {
    writeNoteDoc(
      SESSION_A,
      { attemptId: ATTEMPT, questionId: Q3, phase: "scratch" },
      docOf([]),
    );
    await waitForLocalSaved(SESSION_A, {
      attemptId: ATTEMPT,
      questionId: Q3,
      phase: "scratch",
    });
    putMock.mockResolvedValue(receiptOf(1));
    mockHeads({ [Q3]: headAt(Q3) });

    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(prep.problems).toEqual([]);
    expect(prep.declarations?.find((d) => d.questionId === Q3)).toEqual({
      questionId: Q3,
      state: "frozen",
      versionId: receiptOf(1).versionId,
      revision: 1,
    });
    expect(prep.declarations?.find((d) => d.questionId === Q2)).toEqual({
      questionId: Q2,
      state: "none",
    });
  });
});

describe("prepareSubmitEvidence：失败呈现与明确选择", () => {
  it("flush 后仍待传（网络失败退避）→ 问题清单 + declarations=null；用户确认后该题 missing、其余照常", async () => {
    await writeLocal(Q1, DOC_A);
    putMock.mockRejectedValue(new Error("网络不可用"));
    mockHeads({});

    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(prep.declarations).toBeNull();
    expect(prep.problems.map((p) => p.questionId)).toEqual([Q1]);
    expect(prep.problems[0]?.reason).toContain("尚未保存完整");

    // 用户明确选择「提交答案，草稿未保存完整」→ 重跑组装
    const confirmed = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
      allowMissing: new Set([Q1]),
    });
    expect(confirmed.problems).toEqual([]);
    expect(confirmed.declarations?.find((d) => d.questionId === Q1)).toEqual({
      questionId: Q1,
      state: "missing",
    });
    expect(confirmed.declarations?.find((d) => d.questionId === Q2)).toEqual({
      questionId: Q2,
      state: "none",
    });
  });

  it("问题自愈（退避重试成功）→ allowMissing 不硬标 missing，按事实 frozen", async () => {
    await writeLocal(Q1, DOC_A);
    // 第一次 flush 失败 → 问题；确认时网络恢复（回执可落地）→ 自愈
    let failOnce = true;
    putMock.mockImplementation(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("网络不可用");
      }
      return receiptOf(1);
    });
    mockHeads({ [Q1]: headAt(Q1) });
    const first = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(first.problems.map((p) => p.questionId)).toEqual([Q1]);

    const confirmed = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
      allowMissing: new Set([Q1]),
    });
    // 自愈后按服务端事实固定，不硬标 missing
    expect(confirmed.problems).toEqual([]);
    expect(
      confirmed.declarations?.find((d) => d.questionId === Q1)?.state,
    ).toBe("frozen");
  });

  it("冲突态（conflict）与内容被拒（denied.content）都列为问题", async () => {
    await writeLocal(Q1, DOC_A);
    await writeLocal(Q2, DOC_A);
    await applyUploadConflict(
      SESSION_A,
      { attemptId: ATTEMPT, questionId: Q1, phase: "scratch" },
      null,
      "同一上传标识已对应不同正文",
    );
    await applyUploadDenied(
      SESSION_A,
      { attemptId: ATTEMPT, questionId: Q2, phase: "scratch" },
      "content",
      "草稿超出保存上限",
    );
    mockHeads({});

    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(prep.declarations).toBeNull();
    expect(prep.problems.map((p) => p.questionId).sort()).toEqual([Q1, Q2]);
    const reason1 = prep.problems.find((p) => p.questionId === Q1)?.reason;
    const reason2 = prep.problems.find((p) => p.questionId === Q2)?.reason;
    expect(reason1).toContain("冲突");
    expect(reason2).toBeTruthy();
  });

  it("本地有笔、无待传、head 空态（防御：内容从未到达服务端）→ 问题，不静默 none", async () => {
    await writeLocal(Q1, DOC_A);
    // 上传「成功」但 head 查无笔记行（服务端数据不一致的防御路径）
    putMock.mockResolvedValue(receiptOf(1));
    mockHeads({});

    const prep = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(prep.declarations).toBeNull();
    expect(prep.problems.map((p) => p.questionId)).toEqual([Q1]);
  });
});

describe("prepareSubmitEvidence：阻止性失败", () => {
  it("head 拉取失败（网络/权限）→ 抛错阻止交卷（不能在状态未知下声明）", async () => {
    headsMock.mockRejectedValue(new ApiError("INTERNAL", "服务异常", 500, {}));
    await expect(
      prepareSubmitEvidence({ attemptId: ATTEMPT, questionIds: QUESTIONS }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("本地仓读失败（strictRead）→ 抛错阻止交卷；快览宽松归并无记录", async () => {
    // attempt 装载走 getAll（loadScratchRecords 前缀扫描）——对 getAll 注入故障；
    // get/set 保持正常（catchUpNotes 的落盘队列不被波及）
    const mem = memoryNoteBackend();
    const failingScan: NoteStoreBackend = {
      get: mem.get,
      set: mem.set,
      getAll: async () => {
        throw new Error("IDB 读取失败");
      },
    };
    installNoteBackend(failingScan);
    mockHeads({});
    await expect(
      prepareSubmitEvidence({ attemptId: ATTEMPT, questionIds: QUESTIONS }),
    ).rejects.toThrow("IDB 读取失败");
    // 展示性快览保持宽松：读失败≈无记录（全 none，不抛）
    const statuses = await snapshotNoteOverview({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(statuses.map((st) => st.kind)).toEqual(["none", "none", "none"]);
  });
});

describe("prepareSubmitEvidence：两批 problem 先后确认（并集语义，P0-1）", () => {
  it("A 持续失败 + 期间 B 新增冲突 → 两次确认并集 allowMissing 后仍能交卷", async () => {
    // 第一轮：A 题网络失败（唯一问题）
    await writeLocal(Q1, DOC_A);
    putMock.mockRejectedValue(new Error("网络不可用"));
    mockHeads({});
    const first = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
    });
    expect(first.problems.map((p) => p.questionId)).toEqual([Q1]);

    // 用户确认第一批（AttemptSession 并集累积的 allowMissing）；
    // 期间 B 题新写并落入冲突态（第二批 problem）
    const confirmed = new Set([Q1]);
    await writeLocal(Q2, DOC_A);
    await applyUploadConflict(
      SESSION_A,
      { attemptId: ATTEMPT, questionId: Q2, phase: "scratch" },
      null,
      "同一上传标识已对应不同正文",
    );
    const second = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
      allowMissing: confirmed,
    });
    // A 已按确认消费为 missing；B 是新的未决问题（不因覆盖式确认丢失 A，
    // 也不静默吸收 B）
    expect(second.declarations).toBeNull();
    expect(second.problems.map((p) => p.questionId)).toEqual([Q2]);

    // 用户确认第二批（并集 {A,B}）→ 第三轮完整交卷
    for (const problem of second.problems) confirmed.add(problem.questionId);
    const third = await prepareSubmitEvidence({
      attemptId: ATTEMPT,
      questionIds: QUESTIONS,
      allowMissing: confirmed,
    });
    expect(third.problems).toEqual([]);
    expect(third.declarations).toEqual([
      { questionId: Q1, state: "missing" },
      { questionId: Q2, state: "missing" },
      { questionId: Q3, state: "none" },
    ]);
  });
});

describe("snapshotNoteOverview：快览分类与权威方向一致（#13）", () => {
  it("清空草稿同步成功后快览=will-freeze（权威会 frozen）；无记录题 none", async () => {
    // 空稿写入并真实追平（上传回执落地 → pending 清空）
    writeNoteDoc(
      SESSION_A,
      { attemptId: ATTEMPT, questionId: Q3, phase: "scratch" },
      docOf([]),
    );
    await waitForLocalSaved(SESSION_A, {
      attemptId: ATTEMPT,
      questionId: Q3,
      phase: "scratch",
    });
    putMock.mockResolvedValue(receiptOf(1));
    await catchUpNotes(ATTEMPT);

    const statuses = await snapshotNoteOverview({
      attemptId: ATTEMPT,
      questionIds: [Q2, Q3],
    });
    // Q2 无本地记录 → none（跨设备他端有稿时权威会 frozen——快览残余差异，
    // 注释见 classifyNote）；Q3 已同步空稿 → will-freeze（交卷会 frozen 空版本）
    expect(statuses.map((st) => [st.questionId, st.kind])).toEqual([
      [Q2, "none"],
      [Q3, "will-freeze"],
    ]);
  });
});

describe("prepareSubmitEvidence：T6R.20 标注封存集成（flush→seal→声明）", () => {
  it("交卷前先追平标注上传再 seal（顺序锁定）；seal 失败抛错阻止交卷", async () => {
    const sealMock = vi.mocked(
      (await import("@/lib/api")).sealAttemptAnnotationsApi,
    );
    const annotationPutMock = vi.mocked(
      (await import("@/lib/api")).putAnnotationDocApi,
    );
    // 绑定标注会话 + 写一份待传标注（flush 目标）
    const { bindAnnotationSession, resetAnnotationSession } = await import(
      "@/features/annotation/annotation-sync"
    );
    const {
      installAnnotationBackend,
      memoryAnnotationBackend,
      writeAnnotationDoc,
      settleAnnotationPersistence,
    } = await import("@/features/annotation/annotation-store");
    installAnnotationBackend(memoryAnnotationBackend());
    bindAnnotationSession(SESSION_A);
    try {
      writeAnnotationDoc(
        SESSION_A,
        { attemptId: ATTEMPT, questionId: Q1, phase: "scratch" },
        {
          version: 1,
          baseWidth: 1440,
          baseHeight: 900,
          strokes: [
            {
              tool: "pen",
              color: "#dc2626",
              weight: 5.76,
              points: [{ x: 100, y: 100, p: 0.5, t: 0 }],
            },
          ],
        },
      );
      await settleAnnotationPersistence();
      const order: string[] = [];
      annotationPutMock.mockImplementation(async () => {
        order.push("annotation-put");
        return {
          annotationId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
          hash: "a".repeat(64),
          savedAt: "2026-10-08T00:00:00Z",
        };
      });
      sealMock.mockImplementation(async () => {
        order.push("seal");
        return { phase: "scratch", sealedCount: 1 };
      });
      mockHeads({});
      const prep = await prepareSubmitEvidence({
        attemptId: ATTEMPT,
        questionIds: [Q1],
      });
      expect(prep.declarations).toEqual([{ questionId: Q1, state: "none" }]);
      // 顺序：标注上传先于 seal（flush → seal → 交卷）
      expect(order.indexOf("annotation-put")).toBeLessThan(
        order.indexOf("seal"),
      );

      // seal 失败（网络）→ 抛错阻止交卷（调用方提示重试）
      sealMock.mockRejectedValueOnce(new Error("连不上服务器"));
      await expect(
        prepareSubmitEvidence({ attemptId: ATTEMPT, questionIds: [Q1] }),
      ).rejects.toThrow("连不上服务器");
    } finally {
      resetAnnotationSession();
    }
  });
});
