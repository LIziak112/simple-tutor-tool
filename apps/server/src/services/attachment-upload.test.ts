import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachments } from "../db/schema.ts";
import { createTestDb, createTestDir } from "../db/test-utils";
import { MINI_PDF } from "./attachment-format.test.ts";
import { ATTACHMENT_BLOB_DIR, deleteAttachment } from "./attachment-service.ts";
import { createAttachment } from "./attachment-upload.ts";

/**
 * 资料附件上传写路径：uploadId 幂等键（#103-04）。
 * - 同教师同 uploadId 重放 → 同一行（created=false），表里只有一行，blob 只写一次；
 * - 不同教师同 uploadId → 各自一行；
 * - 不带 uploadId → 每次都是新的一行（历史行为不变；NULL 不参与唯一约束）。
 * teacher_id 无外键，服务层不校验教师存在，这里直接用字面 id。
 */

const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";

function env() {
  return { db: createTestDb(), dataDir: createTestDir() };
}

describe("createAttachment：uploadId 幂等", () => {
  it("同教师同 uploadId 重放返回既有行；不重复落库落盘", () => {
    const { db, dataDir } = env();
    const first = createAttachment(db, dataDir, {
      teacherId: "t1",
      uploadId: UPLOAD_ID,
      fileName: "真题.pdf",
      bytes: new Uint8Array(MINI_PDF),
    });
    expect(first.created).toBe(true);
    const replay = createAttachment(db, dataDir, {
      teacherId: "t1",
      uploadId: UPLOAD_ID,
      fileName: "真题（重试）.pdf",
      visibility: "teacher_only",
      bytes: new Uint8Array(MINI_PDF),
    });
    expect(replay.created).toBe(false);
    expect(replay.attachment).toEqual(first.attachment);
    expect(db.select().from(attachments).all()).toHaveLength(1);
    expect(
      readdirSync(join(dataDir, "blobs", ATTACHMENT_BLOB_DIR)),
    ).toHaveLength(1);
  });

  it("重放命中的是首次那行，即使其后已软删（同一次上传不复活、不重建）", () => {
    const { db, dataDir } = env();
    const first = createAttachment(db, dataDir, {
      teacherId: "t1",
      uploadId: UPLOAD_ID,
      bytes: new Uint8Array(MINI_PDF),
    });
    deleteAttachment(db, "t1", first.attachment.id);
    const replay = createAttachment(db, dataDir, {
      teacherId: "t1",
      uploadId: UPLOAD_ID,
      bytes: new Uint8Array(MINI_PDF),
    });
    expect(replay.created).toBe(false);
    expect(replay.attachment.id).toBe(first.attachment.id);
    expect(db.select().from(attachments).all()).toHaveLength(1);
  });

  it("不同教师同 uploadId 各自一行；不带 uploadId 的每次都是新行", () => {
    const { db, dataDir } = env();
    const a = createAttachment(db, dataDir, {
      teacherId: "t1",
      uploadId: UPLOAD_ID,
      bytes: new Uint8Array(MINI_PDF),
    });
    const b = createAttachment(db, dataDir, {
      teacherId: "t2",
      uploadId: UPLOAD_ID,
      bytes: new Uint8Array(MINI_PDF),
    });
    expect(b.created).toBe(true);
    expect(b.attachment.id).not.toBe(a.attachment.id);
    const c = createAttachment(db, dataDir, {
      teacherId: "t1",
      bytes: new Uint8Array(MINI_PDF),
    });
    const d = createAttachment(db, dataDir, {
      teacherId: "t1",
      bytes: new Uint8Array(MINI_PDF),
    });
    expect(c.created && d.created).toBe(true);
    expect(c.attachment.id).not.toBe(d.attachment.id);
    expect(db.select().from(attachments).all()).toHaveLength(4);
  });
});
