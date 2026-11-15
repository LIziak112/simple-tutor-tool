import {
  ATTEMPT_SNAPSHOT_PROOF_HEADER,
  type AttemptDraftData,
  type AttemptSummary,
  type InkDoc,
} from "@tutor/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-response";
import { createHttpRuntime } from "@/portals/clients/http-runtime";
import { createClientServices } from "@/portals/clients/services";
import { createSubjectScope } from "@/portals/subject-scope";
import { prepareLocalAttempt, reopenMissingAttempt } from "./attempt-reopen";
import {
  installAttemptSessionBackend,
  readLocalAttemptSessions,
  recordLocalAttemptMaterials,
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
const ink = {
  engine: "atrament",
  version: 1,
  updatedAt: 1,
  data: {
    width: 1000,
    strokes: [
      {
        id: "s",
        color: "#000000",
        tool: "pen",
        weight: 2,
        points: [{ x: 1, y: 1, p: 0.5, t: 1 }],
      },
    ],
  },
} satisfies InkDoc;
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
  it("另一标签页已按新题面更新目录，这个标签页在旧题面上答的题：激活之前就拦下", async () => {
    const refreshed = { ...old, frozenAt: "2026-11-14T00:00:00.001Z" };
    await saveLocalAttemptSession({
      attempt: refreshed,
      questions: { q: 2 },
      questionRevisions: { q: "row-new" },
      materials: [],
    });
    // 新版前端写答案都带作答时的题行；这一条是在旧题面上写的
    draftStore.saveAnswer(
      old.id,
      "q",
      { kind: "judge", value: true },
      "row-old",
    );
    const send = vi.fn<typeof fetch>();
    await expect(
      prepareLocalAttempt(services(send), detail(refreshed)),
    ).rejects.toThrow("旧本机原稿仍保留");
    // 没有发出激活：新题面的空卷不能凭旧题面上的动作入账
    expect(send).not.toHaveBeenCalled();
    expect((await draftStore.loadDraft(old.id))?.answers.q).toEqual({
      kind: "judge",
      value: true,
    });
  });
  it("开卷前的预检同样先比题行：对不上就不激活、不建卷", async () => {
    const refreshed = { ...old, frozenAt: "2026-11-14T00:00:00.001Z" };
    await saveLocalAttemptSession({
      attempt: refreshed,
      questions: { q: 2 },
      questionRevisions: { q: "row-new" },
      materials: [],
    });
    draftStore.saveAnswer(
      old.id,
      "q",
      { kind: "judge", value: true },
      "row-old",
    );
    const urls: string[] = [];
    const send = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return ok({ attempt: refreshed });
    });
    await expect(
      services(send).startCourseAttemptApi(
        "22222222-2222-4222-8222-222222222222",
        "u",
      ),
    ).rejects.toThrow("旧本机原稿仍保留");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/opened?");
  });
  it("本机答案的题行和目录一致：未激活的卷照常先激活再放行", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      questionRevisions: { q: "row-new" },
      materials: [],
    });
    draftStore.saveAnswer(
      old.id,
      "q",
      { kind: "judge", value: true },
      "row-new",
    );
    const urls: string[] = [];
    const send = vi.fn<typeof fetch>(async (input) => {
      urls.push(String(input));
      return ok({
        attemptId: old.id,
        activatedAt: old.frozenAt,
        phase: "active",
        frozenAt: old.frozenAt,
      });
    });
    const data = detail(old);
    await expect(prepareLocalAttempt(services(send), data)).resolves.toBe(data);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`/${old.id}/activate`);
  });
  it("打开卷不为材料版本另等一次上下文请求；没有本机稿的卷重冻后，上一版的材料版本作废", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      materials: ["m|1"],
    });
    const send = vi.fn<typeof fetch>();
    // 同一冻结版本：目录里记的材料版本原样留着
    await prepareLocalAttempt(services(send), detail(old));
    expect((await readLocalAttemptSessions())[old.id]?.materials).toEqual([
      "m|1",
    ]);
    // 重冻：目录跟到新版本，旧版的材料号不带过去（等页面的上下文查询补记）
    const refrozen = { ...old, frozenAt: "2026-11-14T00:00:00.001Z" };
    await prepareLocalAttempt(services(send), detail(refrozen));
    const entry = (await readLocalAttemptSessions())[old.id];
    expect(entry?.attempt.frozenAt).toBe(refrozen.frozenAt);
    expect(entry?.questionRevisions).toEqual({ q: "row-new" });
    expect(entry?.materials).toBeUndefined();
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
  it("清除后自动重开课程练习：建卷带入口页同一口径的选项和凭据头", async () => {
    await saveLocalAttemptSession({
      attempt: old,
      questions: { q: 1 },
      materials: [],
    });
    const starts: RequestInit[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/opened?")) return ok({ attempt: null });
      if (url.includes("/units/u/attempts")) {
        starts.push(init ?? {});
        return ok(next);
      }
      if (url.endsWith("/context"))
        return ok({ attemptId: next.id, materials: [], groups: [] });
      return ok(detail(next));
    });
    await reopenMissingAttempt(
      services(send),
      old.id,
      new ApiError("ATTEMPT_NOT_FOUND", "已清除", 404),
      { workflowVersion: 1, feedbackMode: "per_question" },
    );
    expect(starts).toHaveLength(1);
    expect(JSON.parse(String(starts[0]?.body))).toEqual({
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(
      new Headers(starts[0]?.headers).get(ATTEMPT_SNAPSHOT_PROOF_HEADER),
    ).toBe("1");
  });
  describe("升级前建、升级后第一次打开才补冻结的卷（legacyUnverified）", () => {
    // 冻结时刻晚于开卷时刻，但从没被重冻过；服务端也不向它要版本凭据
    const legacy: AttemptSummary = {
      ...old,
      phase: "active",
      activatedAt: "2026-10-02T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:00.000Z",
      frozenAt: "2026-10-07T00:00:00.000Z",
    };
    const legacyDetail = (attempt: AttemptSummary): AttemptDraftData => ({
      ...detail(attempt),
      legacyUnverified: true,
    });
    /** 这台设备在本机目录出现之前留下的稿：答案没记题行，笔迹没绑冻结版本 */
    const leaveOldDraft = async () => {
      draftStore.saveAnswer(legacy.id, "q", { kind: "judge", value: true });
      draftStore.saveInk(legacy.id, "q", ink);
      draftStore.saveMaterialInk(legacy.id, "m|1", ink);
      await draftStore.flush(legacy.id);
    };

    it("已激活、这台设备做过它、目录里没有：照常打开，不隔离、不发请求，之后每次也一样", async () => {
      await leaveOldDraft();
      const send = vi.fn<typeof fetch>();
      const data = legacyDetail(legacy);
      await expect(prepareLocalAttempt(services(send), data)).resolves.toBe(
        data,
      );
      const entry = (await readLocalAttemptSessions())[legacy.id];
      expect(entry?.quarantined).toBeFalsy();
      expect(entry?.attempt.frozenAt).toBe(legacy.frozenAt);
      expect(entry?.questionRevisions).toEqual({ q: "row-new" });
      // 目录里已经有它了：轮询再进来还是放行
      await expect(prepareLocalAttempt(services(send), data)).resolves.toBe(
        data,
      );
      expect(send).not.toHaveBeenCalled();
      const record = await draftStore.loadDraft(legacy.id);
      expect(record?.answers.q).toEqual({ kind: "judge", value: true });
      expect(record?.inks.q).toEqual(ink);
    });
    it("同样的稿，卷不是遗留卷（先被重冻、后在别的设备激活）：继续隔离", async () => {
      await leaveOldDraft();
      const send = vi.fn<typeof fetch>();
      await expect(
        prepareLocalAttempt(services(send), detail(legacy)),
      ).rejects.toThrow("旧本机原稿仍保留");
      expect((await readLocalAttemptSessions())[legacy.id]?.quarantined).toBe(
        true,
      );
      expect(send).not.toHaveBeenCalled();
    });
    it("遗留卷还没激活：维持原做法，隔离，不凭这份本机稿去激活它", async () => {
      await leaveOldDraft();
      const send = vi.fn<typeof fetch>();
      await expect(
        prepareLocalAttempt(
          services(send),
          legacyDetail({ ...legacy, phase: "opened", activatedAt: null }),
        ),
      ).rejects.toThrow("旧本机原稿仍保留");
      expect((await readLocalAttemptSessions())[legacy.id]?.quarantined).toBe(
        true,
      );
      expect(send).not.toHaveBeenCalled();
    });
    it("已激活的遗留卷：按现在的题行写的新答案照常通过，题行对不上的仍然拦下", async () => {
      const data = legacyDetail(legacy);
      const send = vi.fn<typeof fetch>();
      await prepareLocalAttempt(services(send), data);
      draftStore.saveAnswer(
        legacy.id,
        "q",
        { kind: "judge", value: false },
        "row-new",
      );
      await expect(prepareLocalAttempt(services(send), data)).resolves.toBe(
        data,
      );
      draftStore.saveAnswer(
        legacy.id,
        "q",
        { kind: "judge", value: true },
        "row-other",
      );
      await expect(prepareLocalAttempt(services(send), data)).rejects.toThrow(
        "旧本机原稿仍保留",
      );
      expect(send).not.toHaveBeenCalled();
    });
  });
  it("材料版本只补记到同一冻结版本的目录项上", async () => {
    await recordLocalAttemptMaterials(old.id, old.frozenAt, ["m|1"]);
    expect(await readLocalAttemptSessions()).toEqual({});
    await saveLocalAttemptSession({ attempt: old, questions: { q: 1 } });
    await recordLocalAttemptMaterials(old.id, "2026-11-13T00:00:00.000Z", [
      "m|0",
    ]);
    expect(
      (await readLocalAttemptSessions())[old.id]?.materials,
    ).toBeUndefined();
    await recordLocalAttemptMaterials(old.id, old.frozenAt, ["m|1"]);
    expect((await readLocalAttemptSessions())[old.id]).toEqual({
      attempt: old,
      questions: { q: 1 },
      materials: ["m|1"],
    });
  });
});
