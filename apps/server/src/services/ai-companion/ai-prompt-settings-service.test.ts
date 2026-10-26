import { expect, it, vi } from "vitest";
import { createTestDb } from "../../db/test-utils";
import {
  getAiPromptSettings,
  promptOverrideBodyOf,
  updateAiPromptSettings,
} from "./ai-prompt-settings-service";

/**
 * AI 提示词设置服务测试（hall-9533）：默认投影 / 覆盖与恢复 / 版本锚点
 * 冲突 / 受众越权 404 / 同 id 跨命名空间隔离 / 同毫秒连续保存单调。
 */

const UNSET = "1970-01-01T00:00:00.000Z";

it("GET 无覆盖行 = 全默认正文 + 未设置锚点，且只投影本受众槽位", () => {
  const db = createTestDb();
  const teacher = getAiPromptSettings(db, "teacher", "t1");
  expect(teacher.updatedAt).toBe(UNSET);
  expect(
    teacher.slots.every(
      (slot) =>
        !slot.isCustom &&
        slot.body === slot.defaultBody &&
        slot.body.length > 0,
    ),
  ).toBe(true);
  const keys = teacher.slots.map((slot) => slot.key);
  expect(keys).toContain("content-ai-instruction");
  expect(keys).toContain("learning-pack.diagnose-weakness");
  expect(keys).not.toContain("review-pack-student");

  const student = getAiPromptSettings(db, "student", "s1");
  expect(student.slots.map((slot) => slot.key)).toEqual([
    "review-pack-student",
  ]);
});

it("PUT 覆盖即时生效；body=null 恢复默认删行；promptOverrideBodyOf 单行读取", () => {
  const db = createTestDb();
  expect(
    promptOverrideBodyOf(db, "teacher", "t1", "content-ai-instruction"),
  ).toBeNull();
  const first = updateAiPromptSettings(db, "teacher", "t1", {
    // trim 由契约 schema 在路由层完成；本测试直调服务层，传已规整正文
    updates: [{ key: "content-ai-instruction", body: "自定义开场 {kind}" }],
  });
  const slot = first.slots.find(
    (entry) => entry.key === "content-ai-instruction",
  );
  expect(slot?.isCustom).toBe(true);
  expect(slot?.body).toBe("自定义开场 {kind}");
  expect(first.updatedAt).not.toBe(UNSET);
  expect(
    promptOverrideBodyOf(db, "teacher", "t1", "content-ai-instruction"),
  ).toBe("自定义开场 {kind}");

  const second = updateAiPromptSettings(db, "teacher", "t1", {
    updates: [{ key: "content-ai-instruction", body: null }],
  });
  expect(
    second.slots.find((entry) => entry.key === "content-ai-instruction")
      ?.isCustom,
  ).toBe(false);
  expect(
    promptOverrideBodyOf(db, "teacher", "t1", "content-ai-instruction"),
  ).toBeNull();
});

it("baseUpdatedAt：未设置锚点回传可通过；旧锚点 → 409 AI_SETTINGS_STALE", () => {
  const db = createTestDb();
  const first = updateAiPromptSettings(db, "teacher", "t1", {
    baseUpdatedAt: UNSET,
    updates: [{ key: "content-ai-instruction", body: "第一版" }],
  });
  expect(() =>
    updateAiPromptSettings(db, "teacher", "t1", {
      baseUpdatedAt: UNSET,
      updates: [{ key: "content-ai-instruction", body: "过期写" }],
    }),
  ).toThrowError(expect.objectContaining({ code: "AI_SETTINGS_STALE" }));
  const second = updateAiPromptSettings(db, "teacher", "t1", {
    baseUpdatedAt: first.updatedAt,
    updates: [{ key: "content-ai-instruction", body: "第二版" }],
  });
  expect(
    promptOverrideBodyOf(db, "teacher", "t1", "content-ai-instruction"),
  ).toBe("第二版");
  expect(Date.parse(second.updatedAt)).toBeGreaterThan(
    Date.parse(first.updatedAt),
  );
});

it("受众越权 404：教师写学生槽位、学生写教师槽位均拒绝", () => {
  const db = createTestDb();
  expect(() =>
    updateAiPromptSettings(db, "teacher", "t1", {
      updates: [{ key: "review-pack-student", body: "越权" }],
    }),
  ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() =>
    updateAiPromptSettings(db, "student", "s1", {
      updates: [{ key: "content-ai-instruction", body: "越权" }],
    }),
  ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  // 拒绝后不落行
  expect(getAiPromptSettings(db, "teacher", "t1").updatedAt).toBe(UNSET);
});

it("ownerType 命名空间隔离：同名 id 的教师覆盖不影响学生投影", () => {
  const db = createTestDb();
  updateAiPromptSettings(db, "teacher", "same-id", {
    updates: [{ key: "content-ai-instruction", body: "教师定制" }],
  });
  const student = getAiPromptSettings(db, "student", "same-id");
  expect(student.slots.every((slot) => !slot.isCustom)).toBe(true);
  expect(student.updatedAt).toBe(UNSET);
});

it("同毫秒连续保存锚点单调前进（时钟偏移后仍可识别旧编辑）", () => {
  const db = createTestDb();
  const now = new Date("2026-10-25T04:00:00.000Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    const first = updateAiPromptSettings(db, "student", "s1", {
      updates: [{ key: "review-pack-student", body: "第一版" }],
    });
    vi.setSystemTime(now.getTime() - 1_000);
    const second = updateAiPromptSettings(db, "student", "s1", {
      baseUpdatedAt: first.updatedAt,
      updates: [{ key: "review-pack-student", body: "第二版" }],
    });
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(
      Date.parse(first.updatedAt),
    );
    expect(() =>
      updateAiPromptSettings(db, "student", "s1", {
        baseUpdatedAt: first.updatedAt,
        updates: [{ key: "review-pack-student", body: "过期写" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "AI_SETTINGS_STALE" }));
  } finally {
    vi.useRealTimers();
  }
});
