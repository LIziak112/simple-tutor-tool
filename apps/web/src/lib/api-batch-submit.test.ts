import { ATTEMPT_SUBMIT_MAX_QUESTIONS } from "@tutor/contract";
import { afterEach, expect, it, vi } from "vitest";
import { submitAttemptApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("501 题按同一暂存会话逐批上传，网络失败时重放同一批", async () => {
  const root = "/api/student/attempts/attempt-legacy/submit-batches";
  const submissionId = "00000000-0000-4000-8000-000000000001";
  const sessionPath = `${root}/${submissionId}`;
  const result = {
    attempt: {
      id: submissionId,
      sourceType: "wrong",
      assignmentId: null,
      lectureId: null,
      courseId: null,
      unitId: null,
      attemptNo: 1,
      status: "graded",
      startedAt: "2026-10-01T00:00:00.000Z",
      submittedAt: "2026-10-01T00:01:00.000Z",
      scoreAuto: 100,
    },
    title: "历史练习",
    courseName: null,
    dueAt: null,
    answersReleased: true,
    summary: {
      total: ATTEMPT_SUBMIT_MAX_QUESTIONS + 1,
      answered: 1,
      correct: 1,
      wrong: ATTEMPT_SUBMIT_MAX_QUESTIONS,
      pending: 0,
      unanswered: ATTEMPT_SUBMIT_MAX_QUESTIONS,
      autoGradable: ATTEMPT_SUBMIT_MAX_QUESTIONS + 1,
      scoreFinal: 0,
      pendingCount: 0,
    },
    units: [],
    enabledCapabilities: [],
  };
  const calls: Array<{ path: string; body: unknown }> = [];
  let stageCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body: unknown =
        typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path: url, body });
      if (url === sessionPath && stageCalls++ === 0)
        throw new Error("网络中断");
      const data =
        url === root
          ? { submissionId, expiresAt: "2099-01-01T00:00:00.000Z" }
          : url === sessionPath
            ? { batchIndex: stageCalls - 2 }
            : result;
      return Response.json({ ok: true, data });
    }),
  );
  const revisions = Array.from(
    { length: ATTEMPT_SUBMIT_MAX_QUESTIONS + 1 },
    (_, index) => ({
      questionId: `q-${index}`,
      questionRevisionId: `r-${index}`,
      expectedAnswerRevision: index,
    }),
  );
  const evidence = revisions.map(({ questionId }) => ({
    questionId,
    state: "none" as const,
  }));
  await expect(
    submitAttemptApi("attempt-legacy", { revisions, evidence }),
  ).resolves.toEqual(result);
  expect(calls.map(({ path }) => path)).toEqual([
    root,
    sessionPath,
    sessionPath,
    sessionPath,
    `${sessionPath}/finish`,
  ]);
  expect(calls[0]?.body).toEqual({ batchCount: 2 });
  expect(calls[1]?.body).toEqual(calls[2]?.body);
  expect(calls[3]?.body).toEqual({
    batchIndex: 1,
    revisions: revisions.slice(-1),
    evidence: evidence.slice(-1),
  });
});
