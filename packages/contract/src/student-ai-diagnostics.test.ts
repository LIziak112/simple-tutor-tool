import { describe, expect, it } from "vitest";
import {
  aiConnectionModelsDataSchema,
  aiConnectionModelsRequestSchema,
  aiConnectionProbeRequestSchema,
} from "./student-ai-api.ts";

describe("连接草稿诊断契约", () => {
  const credentials = {
    baseUrl: "https://ai.example.com/v1",
    apiKey: "sk-test",
  };
  it("获取模型不要求预先知道模型名；测试模型必须填写", () => {
    expect(aiConnectionModelsRequestSchema.safeParse(credentials).success).toBe(
      true,
    );
    expect(aiConnectionProbeRequestSchema.safeParse(credentials).success).toBe(
      false,
    );
    expect(
      aiConnectionProbeRequestSchema.parse({
        ...credentials,
        model: " chat-model ",
      }).model,
    ).toBe("chat-model");
  });
  it("复用已保存密钥必须提供连接 ID；拒绝空密钥、额外字段和非法地址", () => {
    expect(
      aiConnectionModelsRequestSchema.safeParse({
        baseUrl: credentials.baseUrl,
      }).success,
    ).toBe(false);
    expect(
      aiConnectionModelsRequestSchema.safeParse({
        baseUrl: credentials.baseUrl,
        connectionId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    for (const patch of [
      { apiKey: "" },
      { baseUrl: "bad-url" },
      { teacherComment: "不允许" },
    ]) {
      expect(
        aiConnectionModelsRequestSchema.safeParse({ ...credentials, ...patch })
          .success,
      ).toBe(false);
    }
  });
  it("模型列表只包含有界模型 ID 和获取时间，不携带凭据", () => {
    expect(
      aiConnectionModelsDataSchema.safeParse({
        models: ["chat-model"],
        fetchedAt: "2026-10-17T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      aiConnectionModelsDataSchema.safeParse({
        models: ["x".repeat(1000)],
        fetchedAt: "2026-10-17T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      aiConnectionModelsDataSchema.safeParse({
        models: [],
        fetchedAt: "2026-10-17T00:00:00.000Z",
        apiKey: "sk-test",
      }).success,
    ).toBe(false);
  });
});
