import type { AttemptDraftData, AttemptSummary } from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import { createHttpRuntime } from "@/portals/clients/http-runtime";
import { createClientServices } from "@/portals/clients/services";
import { createSubjectScope } from "@/portals/subject-scope";
import { prepareLocalAttempt, reopenMissingAttempt } from "./attempt-reopen";
import {
  installAttemptSessionBackend,
  readLocalAttemptSessions,
  saveLocalAttemptSession,
} from "./attempt-session-catalog";
import {
  bindDraftSession,
  draftStore,
  installDraftBackend,
  memoryBackend,
} from "./draft-store";

const old: AttemptSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  sourceType: "course",
  courseId: "22222222-2222-4222-8222-222222222222",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 1,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const next = { ...old, id: "33333333-3333-4333-8333-333333333333" };
function detail(attempt: AttemptSummary): AttemptDraftData {
  return {
    attempt,
    title: "练习",
    courseName: "课程",
    dueAt: null,
    answerRelease: "on_submit",
    units: [
      {
        id: "u",
        title: "单元",
        questions: [
          {
            id: "q",
            type: "judge",
            difficulty: 1,
            knowledge: [],
            stemMd: "题",
            hintCount: 0,
            questionRevisionId: "row-new",
            questionVersion: 1,
          },
        ],
      },
    ],
    drafts: {},
    hintsOpened: {},
    legacyUnverified: false,
    enabledCapabilities: ["ink", "steps"],
  };
}
function services(send: typeof fetch) {
  return createClientServices(
    createHttpRuntime(createSubjectScope({ type: "student", id: "A" }, send)),
  );
}
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
beforeEach(() => {
  installDraftBackend(memoryBackend());
  installAttemptSessionBackend(memoryBackend());
  bindDraftSession({ origin: "test", studentId: "A" });
});
describe("真实前端客户端的预检与重开", () => {
  it("另一标签页只更新了目录，不能把缺少自身版本的旧正文认作新稿", async () => {
    const refreshed = { ...old, frozenAt: "2026-11-14T00:00:00.001Z" };
    await saveLocalAttemptSession({
      attempt: refreshed,
      questions: { q: 2 },
      questionRevisions: { q: "row-new" },
      materials: [],
    });
    draftStore.saveAnswer(old.id, "q", { kind: "judge", value: true });
    const send = vi.fn<typeof fetch>();
    await expect(
      prepareLocalAttempt(services(send), detail(refreshed)),
    ).rejects.toThrow("旧本机原稿仍保留");
    expect((await draftStore.loadDraft(old.id))?.answers.q).toEqual({
      kind: "judge",
      value: true,
    });
    expect(
      (await draftStore.loadDraft(old.id))?.answerQuestionRevisions,
    ).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  it("同id重冻时有稿阻断普通加载，旧冻结目录与正文均不覆盖", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      materials: [],
    });
    draftStore.saveAnswer(old.id, "q", { kind: "judge", value: true });
    const send = vi.fn<typeof fetch>();
    await expect(
      prepareLocalAttempt(
        services(send),
        detail({ ...old, frozenAt: "2026-11-14T00:00:00.001Z" }),
      ),
    ).rejects.toThrow("旧本机原稿仍保留");
    expect((await readLocalAttemptSessions())[old.id]?.attempt.frozenAt).toBe(
      old.frozenAt,
    );
    expect((await draftStore.loadDraft(old.id))?.answers.q).toEqual({
      kind: "judge",
      value: true,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("真实答案PUT自行返回版本冲突，不单独预激活卷", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      materials: [],
    });
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "ATTEMPT_SNAPSHOT_CHANGED",
            message: "页面版本已变化",
          }),
          { status: 409 },
        ),
    );
    await expect(
      services(send).saveAttemptAnswerApi(old.id, "q", {
        kind: "judge",
        value: true,
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SNAPSHOT_CHANGED" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain("/answers/q");
    expect(send.mock.calls[0]?.[1]?.method).toBe("PUT");
  });
  it("课程start真实请求按预检→激活旧稿→start顺序，保留服务器冻结CAS凭据", async () => {
    draftStore.saveAnswer(old.id, "q", { kind: "judge", value: true });
    const urls: string[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/opened?")) return ok({ attempt: old });
      if (url.endsWith("/activate")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedFrozenAt: old.frozenAt,
        });
        return ok({
          attemptId: old.id,
          activatedAt: old.frozenAt,
          phase: "active",
          frozenAt: old.frozenAt,
        });
      }
      if (url.endsWith(old.id)) return ok(detail(old));
      return ok(old);
    });
    await services(send).startCourseAttemptApi(
      "22222222-2222-4222-8222-222222222222",
      "u",
    );
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("/opened?");
    expect(urls[1]).toContain(`/${old.id}`);
    expect(urls[2]).toContain(`/${old.id}/activate`);
    expect(urls[3]).toContain("/units/u/attempts");
  });
  it.each([
    new ApiError("ATTEMPT_ACCESS_DENIED", "无权限", 403),
    new ApiError("ATTEMPT_ABANDONED", "作废", 409),
    new ApiError("NOT_FOUND", "来源已移除", 404),
  ])("拒绝或失效不能当清除重建：%s", async (error) => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      materials: [],
    });
    const send = vi.fn<typeof fetch>();
    await expect(
      reopenMissingAttempt(services(send), old.id, error),
    ).rejects.toBe(error);
    expect(send).not.toHaveBeenCalled();
  });
  it("仅已知本机来源的清除404自动重开，未知题版本保留旧稿并显示提示", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: null },
      materials: [],
    });
    draftStore.saveAnswer(old.id, "q", { kind: "judge", value: true });
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/opened?")) return ok({ attempt: null });
      if (url.includes("/units/u/attempts")) return ok(next);
      if (url.endsWith("/context"))
        return ok({ attemptId: next.id, materials: [], groups: [] });
      return ok(detail(next));
    });
    const result = await reopenMissingAttempt(
      services(send),
      old.id,
      new ApiError("ATTEMPT_NOT_FOUND", "已清除", 404),
    );
    expect(result.attempt.id).toBe(next.id);
    expect((await draftStore.loadDraft(old.id))?.answers.q).toEqual({
      kind: "judge",
      value: true,
    });
    expect(await draftStore.loadDraft(next.id)).toBeNull();
  });
});
