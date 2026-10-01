import { describe, expect, it } from "vitest";
import {
  BACKUP_KEEP_COUNT,
  BACKUP_MAX_UPLOAD_BYTES,
  BACKUP_SNAPSHOT_NAME_PATTERN,
  BACKUP_UPLOAD_BODY_LIMIT,
  backupErrorCodeSchema,
  backupRestoreResultSchema,
  backupSnapshotListDataSchema,
  backupSnapshotSchema,
} from "./backup-api.ts";

/**
 * 备份与恢复契约测试（T4.5）：快照列表 / 恢复摘要字段与拒绝口径、
 * 常量合理性（上限、保留份数、命名模式）、错误码枚举。
 */

const SNAPSHOT = {
  filename: "tutor-20261001-120000.db",
  createdAt: "2026-10-01T04:00:00.000Z",
  sizeBytes: 4096,
};

const RESTORE_RESULT = {
  dbFilename: "tutor-20261001-120000.db",
  snapshotTime: "2026-10-01T04:00:00.000Z",
  restoredFiles: 3,
  sessionWarning: true,
};

describe("backupSnapshotSchema / backupSnapshotListDataSchema", () => {
  it("接受完整快照项与列表（倒序由服务端保证）", () => {
    expect(backupSnapshotSchema.safeParse(SNAPSHOT).success).toBe(true);
    expect(
      backupSnapshotListDataSchema.safeParse({ snapshots: [SNAPSHOT] })
        .success,
    ).toBe(true);
  });

  it("缺少字段 / 类型不符时拒绝（不静默降级）", () => {
    expect(backupSnapshotSchema.safeParse({ filename: "a.db" }).success).toBe(
      false,
    );
    expect(
      backupSnapshotSchema.safeParse({ ...SNAPSHOT, sizeBytes: -1 }).success,
    ).toBe(false);
    expect(
      backupSnapshotSchema.safeParse({ ...SNAPSHOT, createdAt: "" }).success,
    ).toBe(false);
  });
});

describe("backupRestoreResultSchema", () => {
  it("接受完整恢复摘要（snapshotTime 可为 null）", () => {
    expect(backupRestoreResultSchema.safeParse(RESTORE_RESULT).success).toBe(
      true,
    );
    expect(
      backupRestoreResultSchema.safeParse({
        ...RESTORE_RESULT,
        dbFilename: "tutor.db",
        snapshotTime: null,
      }).success,
    ).toBe(true);
  });

  it("sessionWarning 只允许 true（提示字段恒在）；restoredFiles 至少 1", () => {
    expect(
      backupRestoreResultSchema.safeParse({
        ...RESTORE_RESULT,
        sessionWarning: false,
      }).success,
    ).toBe(false);
    expect(
      backupRestoreResultSchema.safeParse({ ...RESTORE_RESULT, restoredFiles: 0 })
        .success,
    ).toBe(false);
  });
});

describe("常量与枚举", () => {
  it("上传上限 256MB，body 预检上限多 1MB 余量", () => {
    expect(BACKUP_MAX_UPLOAD_BYTES).toBe(256 * 1024 * 1024);
    expect(BACKUP_UPLOAD_BODY_LIMIT).toBe(BACKUP_MAX_UPLOAD_BYTES + 1024 * 1024);
  });

  it("保留份数为 14（架构 §5.10）", () => {
    expect(BACKUP_KEEP_COUNT).toBe(14);
  });

  it("快照命名模式：接受标准名与同秒序号，拒绝其他", () => {
    expect(BACKUP_SNAPSHOT_NAME_PATTERN.test("tutor-20261001-120000.db")).toBe(
      true,
    );
    expect(
      BACKUP_SNAPSHOT_NAME_PATTERN.test("tutor-20261001-120000-2.db"),
    ).toBe(true);
    expect(BACKUP_SNAPSHOT_NAME_PATTERN.test("tutor.db")).toBe(false);
    expect(BACKUP_SNAPSHOT_NAME_PATTERN.test("../tutor-20260101-000000.db")).toBe(
      false,
    );
  });

  it("错误码枚举覆盖密码 / zip 结构 / 超限 / 回滚四类", () => {
    expect(backupErrorCodeSchema.parse("BACKUP_INVALID_PASSWORD")).toBe(
      "BACKUP_INVALID_PASSWORD",
    );
    expect(backupErrorCodeSchema.safeParse("BACKUP_NOPE").success).toBe(false);
  });
});
