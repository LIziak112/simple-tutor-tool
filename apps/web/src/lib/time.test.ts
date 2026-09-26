import { describe, expect, it } from "vitest";
import { formatDueTime, localInputToUtcIso, utcIsoToLocalInput } from "./time";

/**
 * T2.2 新增时间工具单测：
 * - datetime-local ↔ UTC ISO 往返（任何运行时区下都应还原为原输入）；
 * - 截止时间展示固定 Asia/Shanghai（与运行时区无关）。
 */

describe("localInputToUtcIso / utcIsoToLocalInput", () => {
  it("本地输入 → UTC ISO（带 Z）→ 本地输入：往返还原", () => {
    const local = "2026-10-01T20:00";
    const utc = localInputToUtcIso(local);
    expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(utcIsoToLocalInput(utc)).toBe(local);
  });
});

describe("formatDueTime", () => {
  it("固定按 Asia/Shanghai 展示（不含年份与秒）", () => {
    // 2026-10-01T12:00:00Z = 北京时间 20:00；2026-01-01T16:30:00Z = 次日 00:30
    expect(formatDueTime("2026-10-01T12:00:00.000Z")).toBe("10月1日 20:00");
    expect(formatDueTime("2026-01-01T16:30:00.000Z")).toBe("1月2日 00:30");
  });
});
