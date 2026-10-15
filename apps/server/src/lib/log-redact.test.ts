import { describe, expect, it } from "vitest";
import { redactHeaders, redactHeaderValue, redactPath } from "./log-redact.ts";

/**
 * SAI-16 日志脱敏（B00 §7；攻击用例表 secret 行的 log 维度）：
 * - Authorization/Key 类头值只留 scheme，凭证明文不进日志；
 * - 含 share secret 的路径（票据读端点）按段脱敏；
 * - 敏感查询参数（token/key/secret/…）值一律 ***，普通参数保留。
 */

describe("redactHeaderValue", () => {
  it("Bearer/Basic/Token 保留 scheme、隐去凭证", () => {
    expect(redactHeaderValue("Bearer sk-live-abcdef123456")).toBe("Bearer ***");
    expect(redactHeaderValue("basic dXNlcjpwYXNz")).toBe("basic ***");
    expect(redactHeaderValue("Bearer  ocsm-token-value")).toBe("Bearer ***");
  });

  it("无 scheme 的长凭证整体 ***，普通短值原样", () => {
    expect(redactHeaderValue("sk-live-abcdef1234567890")).toBe("***");
    expect(redactHeaderValue("application/json")).toBe("application/json");
    expect(redactHeaderValue("keep-alive")).toBe("keep-alive");
  });
});

describe("redactHeaders", () => {
  it("脱敏授权/凭证类头，保留普通头", () => {
    expect(
      redactHeaders({
        authorization: "Bearer sk-live-secret",
        "x-api-key": "sk-another-secret",
        cookie: "tutor_student_session=abc",
        "content-type": "application/json",
      }),
    ).toEqual({
      authorization: "Bearer ***",
      "x-api-key": "***",
      cookie: "***",
      "content-type": "application/json",
    });
  });
});

describe("redactPath", () => {
  it("票据路径段脱敏（/api/public/ai/share/<ticket> 及其材料子路径）", () => {
    const ticket = "ocstkt_0123456789abcdefghijklmnopqrstuv";
    expect(redactPath(`/api/public/ai/share/${ticket}`)).toBe(
      "/api/public/ai/share/<ticket>",
    );
    expect(redactPath(`/api/public/ai/share/${ticket}/materials/3.png`)).toBe(
      "/api/public/ai/share/<ticket>/materials/3.png",
    );
  });

  it("敏感查询参数值脱敏，普通参数保留", () => {
    expect(redactPath("/api/x?page=2&token=abc123&apiKey=sk-1&name=ok")).toBe(
      "/api/x?page=2&token=***&apiKey=***&name=ok",
    );
  });

  it("普通路径与查询原样保留", () => {
    expect(redactPath("/api/student/ai/tasks?limit=20&status=created")).toBe(
      "/api/student/ai/tasks?limit=20&status=created",
    );
  });

  it("URL 编码形态的查询值同样脱敏", () => {
    expect(redactPath("/api/x?share%5Fsecret=abc%2B123%3D%3D&n=1")).toBe(
      "/api/x?share%5Fsecret=***&n=1",
    );
  });
});
