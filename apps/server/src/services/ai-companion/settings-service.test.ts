import { expect, it, vi } from "vitest";
import { createTestDb } from "../../db/test-utils";
import {
  getTeacherAiSettings,
  updateTeacherAiSettings,
} from "./settings-service";

for (const clockOffset of [0, -1_000]) {
  it(`连续保存时版本递增，时钟偏移 ${clockOffset}ms 后仍识别旧编辑`, () => {
    const db = createTestDb();
    const now = new Date("2026-10-19T04:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      const first = updateTeacherAiSettings(db, "teacher", {
        defaultMode: "guided_only",
      });
      vi.setSystemTime(now.getTime() + clockOffset);
      const second = updateTeacherAiSettings(db, "teacher", {
        defaultMode: "post_submit_only",
        baseUpdatedAt: first.updatedAt,
      });
      expect(Date.parse(second.updatedAt)).toBeGreaterThan(
        Date.parse(first.updatedAt),
      );
      expect(() =>
        updateTeacherAiSettings(db, "teacher", {
          defaultMode: "open_study",
          baseUpdatedAt: first.updatedAt,
        }),
      ).toThrowError(expect.objectContaining({ code: "AI_SETTINGS_STALE" }));
      expect(getTeacherAiSettings(db, "teacher").defaultMode).toBe(
        "post_submit_only",
      );
    } finally {
      vi.useRealTimers();
    }
  });
}
