import { describe, expect, it } from "vitest";
import { localPersistenceErrorMessage } from "./local-persistence-error";

describe("本机存储错误文案", () => {
  it.each([
    null,
    undefined,
    new Error(""),
    new Error("null"),
    new Error("undefined"),
  ])("空异常提供可重试文案：%s", (error) => {
    const message = localPersistenceErrorMessage(error);
    expect(message).toContain("本机存储");
    expect(message).toContain("重试");
    expect(message).not.toMatch(/null|undefined/);
  });
  it.each(["InvalidStateError", "AbortError", "UnknownError"])(
    "识别跨窗口异常名称：%s",
    (name) => {
      expect(
        localPersistenceErrorMessage({ name, message: "原始英文错误" }),
      ).toContain("连接异常或写入中断");
    },
  );
  it("空间和权限错误给出具体处理方式，不用连接异常掩盖", () => {
    expect(
      localPersistenceErrorMessage({ name: "QuotaExceededError" }),
    ).toContain("不要清除此网站的数据");
    expect(localPersistenceErrorMessage({ name: "SecurityError" })).toContain(
      "存储权限",
    );
    expect(
      localPersistenceErrorMessage(new Error("已有另一布局的本机稿")),
    ).toBe("已有另一布局的本机稿");
  });
  it("保留已有明确的文字原因，不把所有文字错误误判为连接异常", () => {
    expect(localPersistenceErrorMessage("本机底图尺寸不匹配")).toBe(
      "本机底图尺寸不匹配",
    );
  });
});
