import type { NoteHeadData, StudentNotebookData } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createCorrectionApi,
  fetchStudentNotebookApi,
  sealCorrectionApi,
} from "@/lib/api";

/**
 * T6R.15 订正/笔记本 API 客户端测试（单3 A）：
 * - createCorrectionApi：POST JSON {copyFromOriginal} 到 corrections 端点
 *   （201 创建语义），成功解统一壳返回 noteHeadData；
 * - sealCorrectionApi：POST JSON {baseRevision, stuckAt?, errorCause?} 到
 *   corrections/seal 端点（200），409 冲突壳抛 ApiError（extra._current 供
 *   UI 提示重试）；
 * - fetchStudentNotebookApi：GET notebook 聚合端点，成功解壳返回轮次数据；
 *   错误壳抛 ApiError。
 * hc JSON 路由 stub 全局 fetch（hc 底层即 fetch(path, init)——URL/method/body
 * 逐项断言；口径同 api-teacher-backup.test 的捕获型 stub）。
 */

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "p1-q1";

/** 空头投影（成功响应 data；corrections/supplements 恒数组——契约口径） */
const HEAD: NoteHeadData = {
  note: null,
  images: [],
  evidence: null,
  corrections: [],
  supplements: [],
};

const NOTEBOOK: StudentNotebookData = {
  questionId: QUESTION_ID,
  rounds: [],
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** 捕获型 fetch stub：统一按回调出响应 */
function stubCapture(
  respond: (call: CapturedCall) => Response,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

function shellResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCorrectionApi（T6R.15 D3）", () => {
  it("POST JSON：copyFromOriginal 必填字段上送；201 成功壳解出 noteHeadData", async () => {
    const calls = stubCapture(() =>
      shellResponse({ ok: true, data: HEAD }, 201),
    );
    const head = await createCorrectionApi(ATTEMPT_ID, QUESTION_ID, {
      copyFromOriginal: true,
    });
    expect(head).toEqual(HEAD);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      `/api/student/attempts/${ATTEMPT_ID}/notes/${QUESTION_ID}/corrections`,
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      copyFromOriginal: true,
    });
  });

  it("409 NOTE_CORRECTION_OPEN_EXISTS：抛 ApiError（code/status/中文 message）", async () => {
    stubCapture(() =>
      shellResponse(
        {
          ok: false,
          error: "NOTE_CORRECTION_OPEN_EXISTS",
          message: "已有一份编辑中的订正，请继续编辑",
        },
        409,
      ),
    );
    const err = await createCorrectionApi(ATTEMPT_ID, QUESTION_ID, {
      copyFromOriginal: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("NOTE_CORRECTION_OPEN_EXISTS");
    expect(apiErr.message).toContain("订正");
  });
});

describe("sealCorrectionApi（T6R.15 D2）", () => {
  it("POST JSON：baseRevision 与可选反思字段上送；200 成功壳解出 noteHeadData", async () => {
    const calls = stubCapture(() => shellResponse({ ok: true, data: HEAD }));
    const head = await sealCorrectionApi(ATTEMPT_ID, QUESTION_ID, {
      baseRevision: 2,
      stuckAt: "化简符号",
      errorCause: "去括号忘了变号",
    });
    expect(head).toEqual(HEAD);
    expect(calls[0]?.url).toBe(
      `/api/student/attempts/${ATTEMPT_ID}/notes/${QUESTION_ID}/corrections/seal`,
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      baseRevision: 2,
      stuckAt: "化简符号",
      errorCause: "去括号忘了变号",
    });
  });

  it("409 NOTE_REVISION_CONFLICT：抛 ApiError 且 extra._current 携带服务端摘要", async () => {
    const current = {
      noteId: "22222222-2222-4222-8222-222222222222",
      revision: 3,
      versionId: "33333333-3333-4333-8333-333333333333",
      hash: "b".repeat(64),
      serverSavedAt: "2026-10-07T01:00:00.000Z",
    };
    stubCapture(() =>
      shellResponse(
        {
          ok: false,
          error: "NOTE_REVISION_CONFLICT",
          message: "订正已在别处保存了更新的版本",
          _current: current,
        },
        409,
      ),
    );
    const err = await sealCorrectionApi(ATTEMPT_ID, QUESTION_ID, {
      baseRevision: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe("NOTE_REVISION_CONFLICT");
    expect(apiErr.extra?._current).toEqual(current);
  });
});

describe("fetchStudentNotebookApi（T6R.15 D7）", () => {
  it("GET 聚合端点；成功壳解出轮次数据", async () => {
    const calls = stubCapture(() =>
      shellResponse({ ok: true, data: NOTEBOOK }),
    );
    const data = await fetchStudentNotebookApi(QUESTION_ID);
    expect(data).toEqual(NOTEBOOK);
    expect(calls[0]?.url).toBe(
      `/api/student/notebook/questions/${QUESTION_ID}`,
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("404 域外：抛 ApiError（code/message 透传）", async () => {
    stubCapture(() =>
      shellResponse(
        { ok: false, error: "UNAUTHORIZED", message: "请先登录" },
        401,
      ),
    );
    const err = await fetchStudentNotebookApi(QUESTION_ID).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe("UNAUTHORIZED");
  });
});
