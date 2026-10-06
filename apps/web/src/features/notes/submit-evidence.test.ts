/**
 * T6R.10 交卷证据声明组装（submit-evidence）测试：消费 flushNoteSync 摘要
 * + 逐题服务端 head，产出每题 none/frozen/missing 声明与未决问题清单。
 * 覆盖：正常固定（本地已同步/跨设备仅有服务端稿）、失败呈现（backoff/
 * conflict/denied(content)→问题清单、声明为 null）、用户明确选择 missing
 * 后仅问题题标 missing、问题自愈不硬标、head 拉取失败抛错阻止交卷、
 * 本地有笔无服务端稿（防御）不静默 none、空稿 none。
 * fetchStudentNoteHeadApi 以 vi.fn 替换；putNoteDocumentApi 同（flush 真实
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
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  DOC_A,
  SESSION_A,
  headOf,
  receiptOf,
  SCOPE,
  waitForLocalSaved,
} from "@/features/notes/note-test-utils";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    putNoteDocumentApi: vi.fn(),
    fetchStudentNoteHeadApi: vi.fn(),
  };
});

import { bindNoteSession, resetNoteSession } from "@/features/notes/note-sync";
import { prepareSubmitEvidence } from "@/features/notes/submit-evidence";
import {
  ApiError,
  fetchStudentNoteHeadApi,
  putNoteDocumentApi,
} from "@/lib/api";

const putMock = vi.mocked(putNoteDocumentApi);
const headMock = vi.mocked(fetchStudentNoteHeadApi);

const ATTEMPT = SCOPE.attemptId;
const Q1 = SCOPE.questionId;
const Q2 = "p1-q2";
const Q3 = "p1-q3";
const QUESTIONS = [Q1, Q2, Q3];

beforeEach(() => {
  installNoteBackend(memoryNoteBackend());
  bindNoteSession(SESSION_A);
  putMock.mockReset();
  headMock.mockReset();
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

/** head mock：默认全空态，覆盖表定制 */
function headAt(questionId: string): NoteHeadData {
  const base = headOf();
  return {
    ...base,
    note: base.note === null ? null : { ...base.note, questionId },
  };
}

/** head mock：默认全空态，覆盖表定制 */
function mockHeads(overrides: Record<string, NoteHeadData>): void {
  headMock.mockImplementation(async (_attemptId: string, questionId: string) => {
    return overrides[questionId] ?? { note: null, images: [], evidence: null };
  });
}

describe("prepareSubmitEvidence：正常固定", () => {
  it("本地已同步 + head 有版本 → frozen(head 权威 versionId/revision)；其余题 none", async () => {
    // 本地有笔；上传成功（回执 rev1）。head 显示他处已存到 rev2 → 按 head 声明
    await writeLocal(Q1, DOC_A);
    putMock.mockResolvedValue(receiptOf(1));
    mockHeads({
      [Q1]: {
        ...headAt(Q1),
        note: {
          ...headAt(Q1).note!,
          revision: 2,
          currentVersionId: receiptOf(2).versionId,
        },
      },
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
    expect(prep.statuses.map((s) => [s.questionId, s.kind])).toEqual([
      [Q1, "will-freeze"],
      [Q2, "none"],
      [Q3, "none"],
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
    expect(prep.statuses.find((s) => s.questionId === Q1)?.kind).toBe("problem");

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
    expect(confirmed.declarations?.find((d) => d.questionId === Q1)?.state).toBe(
      "frozen",
    );
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
    headMock.mockRejectedValue(new ApiError("INTERNAL", "服务异常", 500, {}));
    await expect(
      prepareSubmitEvidence({ attemptId: ATTEMPT, questionIds: QUESTIONS }),
    ).rejects.toBeInstanceOf(Error);
  });
});
