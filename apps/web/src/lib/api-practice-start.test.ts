import { ATTEMPT_SNAPSHOT_PROOF_HEADER } from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startAttemptApi,
  startCourseAttemptApi,
  startWrongPracticeApi,
} from "@/lib/api";

/**
 * 建卷请求携带工作流选项（M3-D1.5）：三个 start 封装把可选工作流选项随
 * 请求体下发（契约 attemptStartOptionsRequestSchema / wrongPracticeRequest
 * Schema，服务端显式 workflowVersion=1 才写新协议列）。mock fetch 捕获
 * 请求体断言形状；省略选项时不发 body（旧协议空请求维持不变）。
 *
 * 作业与课程建卷之前先发一次只读预检（GET /attempts/opened：有未激活的卷且
 * 本机有稿时先保护原稿），建卷请求带凭据头（服务端据此才会重冻未激活的卷）。
 * 错题重练每次新建，没有预检。
 */

/** 每次调用给一个新的 Response（body 只能读一次）；预检返回「没有未激活的卷」 */
function stubFetch() {
  const fetchSpy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          data: String(input).startsWith("/api/student/attempts/opened?")
            ? { attempt: null }
            : {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** 请求顺序：[方法, 地址]（预检在前，建卷在后） */
function requestsOf(fetchSpy: ReturnType<typeof stubFetch>): string[][] {
  return fetchSpy.mock.calls.map(([input, init]) => [
    init?.method ?? "GET",
    String(input),
  ]);
}

/** 建卷那次 POST 的请求参数（预检 GET 不算） */
function startInitOf(fetchSpy: ReturnType<typeof stubFetch>): RequestInit {
  const call = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST");
  if (!call?.[1]) throw new Error("没有发出建卷请求");
  return call[1];
}

/** 建卷请求的 JSON 请求体（hono client 以 JSON 字符串下发） */
function requestBodyOf(
  fetchSpy: ReturnType<typeof stubFetch>,
): Record<string, unknown> {
  return JSON.parse(String(startInitOf(fetchSpy).body)) as Record<
    string,
    unknown
  >;
}

const proofHeaderOf = (fetchSpy: ReturnType<typeof stubFetch>) =>
  new Headers(startInitOf(fetchSpy).headers).get(ATTEMPT_SNAPSHOT_PROOF_HEADER);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("建卷请求携带工作流选项（M3-D1.5）", () => {
  it("作业建卷：偏好选项随 body 下发（per_question）", async () => {
    const fetchSpy = stubFetch();
    await startAttemptApi("a1", {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(requestsOf(fetchSpy)).toEqual([
      [
        "GET",
        "/api/student/attempts/opened?sourceType=assignment&assignmentId=a1",
      ],
      ["POST", "/api/student/assignments/a1/attempt"],
    ]);
    expect(requestBodyOf(fetchSpy)).toEqual({
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(proofHeaderOf(fetchSpy)).toBe("1");
  });

  it("作业建卷：after_attempt 偏好同样随 body 下发", async () => {
    const fetchSpy = stubFetch();
    await startAttemptApi("a1", {
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
    expect(requestBodyOf(fetchSpy)).toEqual({
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
  });

  it("作业建卷：省略选项时不发 body（旧协议空请求不变）", async () => {
    const fetchSpy = stubFetch();
    await startAttemptApi("a1");
    expect(startInitOf(fetchSpy).body ?? null).toBeNull();
    expect(proofHeaderOf(fetchSpy)).toBe("1");
  });

  it("课程建卷：偏好选项随 body 下发", async () => {
    const fetchSpy = stubFetch();
    await startCourseAttemptApi("c1", "u1", {
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
    expect(requestsOf(fetchSpy)).toEqual([
      [
        "GET",
        "/api/student/attempts/opened?sourceType=course&courseId=c1&unitId=u1",
      ],
      ["POST", "/api/student/courses/c1/units/u1/attempts"],
    ]);
    expect(requestBodyOf(fetchSpy)).toEqual({
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
    expect(proofHeaderOf(fetchSpy)).toBe("1");
  });

  it("课程清空重做：原卷由服务端作废，不发预检", async () => {
    const fetchSpy = stubFetch();
    await startCourseAttemptApi("c1", "u1", {
      workflowVersion: 1,
      restartAttemptId: "11111111-1111-4111-8111-111111111111",
    });
    expect(requestsOf(fetchSpy)).toEqual([
      ["POST", "/api/student/courses/c1/units/u1/attempts"],
    ]);
  });

  it("错题重练：questionIds 与偏好选项同体下发", async () => {
    const fetchSpy = stubFetch();
    await startWrongPracticeApi(["q1", "q2"], {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(requestsOf(fetchSpy)).toEqual([
      ["POST", "/api/student/wrong-practice"],
    ]);
    expect(requestBodyOf(fetchSpy)).toEqual({
      questionIds: ["q1", "q2"],
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
  });
});
