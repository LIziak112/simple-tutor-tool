import {
  ALL_ENABLED_CAPABILITIES,
  type CapabilityProfile,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import { teachers } from "../db/schema";
import {
  getCapabilityProfile,
  updateCapabilityProfile,
} from "./capability-profile-service";

/**
 * T7.7 能力启用集服务测试（方案 §4.5）：
 * - 未配置（列 NULL）与坏 JSON 都按全启用兜底（缺省语义，存量行无需回填）；
 * - 空数组是显式全关（合法落库合法读回）；
 * - 更新只写本教师行（域隔离的基础：列按 teacherId 定位）。
 */

const OTHER_TEACHER_ID = "teacher-b-t77-profile";

function withOtherTeacher(db: Db): void {
  db.insert(teachers)
    .values({
      id: OTHER_TEACHER_ID,
      loginName: "teacher-b",
      isAdmin: false,
      disabledAt: null,
      passwordHash: null,
      apiToken: null,
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
}

/** 直接把列写成给定 JSON 串（模拟历史写入/手工数据） */
function setColumn(db: Db, teacherId: string, json: string | null): void {
  db.update(teachers)
    .set({ capabilityProfileJson: json })
    .where(eq(teachers.id, teacherId))
    .run();
}

describe("getCapabilityProfile（读取与兜底）", () => {
  it("未配置（NULL）→ 全启用", () => {
    const db = createTestDb();
    expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual({
      enabledCapabilities: ["steps", "ink"],
    });
  });

  it("空数组 → 显式全关（读回不变）", () => {
    const db = createTestDb();
    setColumn(db, TEST_TEACHER_ID, '{"enabledCapabilities":[]}');
    expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual({
      enabledCapabilities: [],
    });
  });

  it("单项配置读回原样（顺序保持写入形态）", () => {
    const db = createTestDb();
    setColumn(db, TEST_TEACHER_ID, '{"enabledCapabilities":["ink"]}');
    expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual({
      enabledCapabilities: ["ink"],
    });
  });

  it("坏 JSON / 不合 profile schema 的存量值 → 全启用兜底（不抛错）", () => {
    const db = createTestDb();
    for (const bad of [
      "not-json{",
      '{"enabledCapabilities":["choice"]}',
      '{"enabledCapabilities":["steps","steps"]}',
      '{"other":1}',
    ]) {
      setColumn(db, TEST_TEACHER_ID, bad);
      expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual({
        enabledCapabilities: [...ALL_ENABLED_CAPABILITIES],
      });
    }
  });
});

describe("updateCapabilityProfile（写入）", () => {
  it("写入后读回一致；列内容是 profile 的 JSON 串", () => {
    const db = createTestDb();
    const profile: CapabilityProfile = { enabledCapabilities: ["steps"] };
    expect(updateCapabilityProfile(db, TEST_TEACHER_ID, profile)).toEqual(
      profile,
    );
    expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual(profile);
    expect(
      db
        .select({ json: teachers.capabilityProfileJson })
        .from(teachers)
        .where(eq(teachers.id, TEST_TEACHER_ID))
        .get()?.json,
    ).toBe('{"enabledCapabilities":["steps"]}');
  });

  it("两教师互不影响：A 全关不影响 B 的未配置全启用", () => {
    const db = createTestDb();
    withOtherTeacher(db);
    updateCapabilityProfile(db, TEST_TEACHER_ID, {
      enabledCapabilities: [],
    });
    expect(getCapabilityProfile(db, TEST_TEACHER_ID)).toEqual({
      enabledCapabilities: [],
    });
    expect(getCapabilityProfile(db, OTHER_TEACHER_ID)).toEqual({
      enabledCapabilities: ["steps", "ink"],
    });
  });
});
