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
 */

/** 统一成功壳（callApi 只校验壳形状，data 按调用方类型收窄） */
const okShell = () =>
  new Response(JSON.stringify({ ok: true, data: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function stubFetch() {
  const fetchSpy = vi.fn().mockResolvedValue(okShell());
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** 取第一次 fetch 调用的 JSON 请求体（hono client 以 JSON 字符串下发） */
function requestBodyOf(
  fetchSpy: ReturnType<typeof stubFetch>,
): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/student/assignments/a1/attempt",
    );
    expect(requestBodyOf(fetchSpy)).toEqual({
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
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
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body ?? null).toBeNull();
  });

  it("课程建卷：偏好选项随 body 下发", async () => {
    const fetchSpy = stubFetch();
    await startCourseAttemptApi("c1", "u1", {
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/student/courses/c1/units/u1/attempts",
    );
    expect(requestBodyOf(fetchSpy)).toEqual({
      workflowVersion: 1,
      feedbackMode: "after_attempt",
    });
  });

  it("错题重练：questionIds 与偏好选项同体下发", async () => {
    const fetchSpy = stubFetch();
    await startWrongPracticeApi(["q1", "q2"], {
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/student/wrong-practice");
    expect(requestBodyOf(fetchSpy)).toEqual({
      questionIds: ["q1", "q2"],
      workflowVersion: 1,
      feedbackMode: "per_question",
    });
  });
});
