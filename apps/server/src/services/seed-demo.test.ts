import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessions, students, teachers } from "../db/schema";
import { createTestDb, TEST_TEACHER_ID } from "../db/test-utils";
import {
  createDemoTeacherAndSeed,
  isSeedStudentRow,
  resolveSeedStudentLoginName,
  type SeedDemoResult,
} from "./seed-demo";
import { createStudent } from "./student-service";

/**
 * seed-demo 多教师与失败回滚测试（T4.1 修复，Opus 实测②）：
 * - 学生登录名全局唯一（students_login_name_unique，D14 不按教师分片），
 *   第二个教师域播种时固定登录名必撞 409 → 避让为「原名+数字后缀」，
 *   displayName 与密码不变；
 * - 种数据中途抛错 → 回滚本次新建的教师行（连同会话与已写入的部分种子
 *   数据），不留无法登录的孤儿教师；已存在的教师失败不回滚。
 */

/** 固定时间基准（与 analytics-service.test.ts 同款，避免周分布漂移） */
const SEED_NOW = "2026-10-01T04:00:00.000Z";

describe("seed-demo：多教师登录名避让与失败回滚（T4.1 修复）", () => {
  it("同库双教师播种成功：第二域学生登录名自动加后缀、displayName 不变、第一域不受影响", async () => {
    const db = createTestDb();
    try {
      // 第一域（demo）：三名种子学生登录名均为原名
      const first = await createDemoTeacherAndSeed(db, "demo", {
        now: SEED_NOW,
      });
      for (const ref of [
        first.seed.students.s1,
        first.seed.students.s2,
        first.seed.students.s3,
      ]) {
        expect(ref.loginName).toBe(ref.name);
      }

      // 第二域（demo2）：同名登录名已被第一域占用 → 全部避让为「原名2」
      const second = await createDemoTeacherAndSeed(db, "demo2", {
        now: SEED_NOW,
      });
      expect(second.seed.students.s1).toEqual({
        id: expect.any(String),
        name: "陈小明",
        loginName: "陈小明2",
      });
      expect(second.seed.students.s2.loginName).toBe("李小红2");
      expect(second.seed.students.s3.loginName).toBe("王小刚2");

      // displayName 不变（库中仍显示原名），且归属第二教师域
      const row = db
        .select()
        .from(students)
        .where(eq(students.loginName, "陈小明2"))
        .get();
      expect(row?.displayName).toBe("陈小明");
      expect(row?.teacherId).toBe(second.seed.teacherId);

      // 第一域学生不受影响（loginName 仍为原名，归属不变）
      const firstRow = db
        .select()
        .from(students)
        .where(eq(students.loginName, "陈小明"))
        .get();
      expect(firstRow?.teacherId).toBe(first.seed.teacherId);

      // 幂等识别：避让产物（displayName 原名 + 数字后缀登录名）仍是种子学生
      expect(
        isSeedStudentRow({ loginName: "陈小明", displayName: "陈小明" }),
      ).toBe(true);
      expect(
        isSeedStudentRow({ loginName: "陈小明2", displayName: "陈小明" }),
      ).toBe(true);
      // 同名真实学生（displayName 不同）与后缀非纯数字的不误判
      expect(
        isSeedStudentRow({ loginName: "陈小明2", displayName: "陈大明" }),
      ).toBe(false);
      expect(
        isSeedStudentRow({ loginName: "陈小明2024", displayName: "陈小明" }),
      ).toBe(false);

      // 避让解析：未占用名返回原名；连续占用取第一个可用后缀
      expect(resolveSeedStudentLoginName(db, "赵六")).toBe("赵六");
      expect(resolveSeedStudentLoginName(db, "陈小明")).toBe("陈小明3");
    } finally {
      db.$client.close();
    }
  });

  it("种数据中途抛错：回滚本次新建的教师行（连同会话与已写入的部分种子数据），cause 保留原始错误", async () => {
    const db = createTestDb();
    let seededTeacherId = "";
    try {
      const failing = createDemoTeacherAndSeed(db, "demo", {
        now: SEED_NOW,
        // 注入 fake 失败：模拟学生建到一半后种数据崩掉（学生建在最前，中途
        // 失败时可能已入库；同时插入一条教师会话验证「连同其会话」）
        seedFn: async (db2, teacherId) => {
          seededTeacherId = teacherId;
          db2
            .insert(sessions)
            .values({
              id: "sess-demo-orphan",
              subjectType: "teacher",
              subjectId: teacherId,
              expiresAt: "2026-12-01T00:00:00.000Z",
              createdAt: "2026-10-01T00:00:00.000Z",
            })
            .run();
          await createStudent(db2, teacherId, {
            displayName: "陈小明",
            loginName: "陈小明",
            password: "demo-pass-123",
          });
          throw new Error("模拟种数据中途失败");
        },
      });
      await expect(failing).rejects.toThrow(/已回滚.*「demo」/s);
      await expect(failing).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "模拟种数据中途失败" }),
      });

      // 教师行、教师会话、已写入的部分种子数据全部清除，库中无孤儿
      expect(
        db.select().from(teachers).where(eq(teachers.loginName, "demo")).get(),
      ).toBeUndefined();
      expect(
        db
          .select()
          .from(sessions)
          .where(eq(sessions.id, "sess-demo-orphan"))
          .get(),
      ).toBeUndefined();
      expect(
        db
          .select()
          .from(students)
          .where(eq(students.loginName, "陈小明"))
          .get(),
      ).toBeUndefined();

      // 回滚彻底：登录名重新可用，同库再次播种成功且登录名为原名
      const retry = await createDemoTeacherAndSeed(db, "demo", {
        now: SEED_NOW,
      });
      expect(retry.seed.students.s1.loginName).toBe("陈小明");
      expect(seededTeacherId).not.toBe(retry.seed.teacherId);
    } finally {
      db.$client.close();
    }
  });

  it("教师已存在时种数据失败：原样抛出且不回滚（教师行与其数据归原教师所有）", async () => {
    const db = createTestDb();
    try {
      // createTestDb 已种 loginName='teacher'（TEST_TEACHER_ID）的教师行
      await expect(
        createDemoTeacherAndSeed(db, "teacher", {
          seedFn: async (): Promise<SeedDemoResult> => {
            throw new Error("模拟失败");
          },
        }),
      ).rejects.toThrow("模拟失败");
      expect(
        db
          .select()
          .from(teachers)
          .where(eq(teachers.id, TEST_TEACHER_ID))
          .get(),
      ).toBeDefined();
    } finally {
      db.$client.close();
    }
  });
});
