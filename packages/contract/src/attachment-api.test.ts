import { describe, expect, it } from "vitest";
import {
  ANSWER_LIKE_FILE_NAME,
  ATTACHMENT_MAX_UPLOAD_BYTES,
  attachmentFileUrl,
  attachmentSchema,
  attachmentUpdateSchema,
  attachmentUploadFieldsSchema,
  formatAttachmentBytes,
  studentAttachmentSchema,
} from "./attachment-api.ts";

const SAMPLE = {
  id: "11111111-1111-4111-8111-111111111111",
  courseId: "22222222-2222-4222-8222-222222222222",
  courseTitle: "行测冲刺",
  fileName: "2024 国考行测真题.pdf",
  format: "pdf",
  bytes: 1_234_567,
  pageCount: 42,
  visibility: "students",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
} as const;

describe("资料附件契约（模块 6 第一步）", () => {
  it("教师侧一条资料：课程可为空、页数可为空", () => {
    expect(attachmentSchema.parse(SAMPLE)).toEqual(SAMPLE);
    expect(
      attachmentSchema.parse({
        ...SAMPLE,
        courseId: null,
        courseTitle: null,
        pageCount: null,
      }).courseId,
    ).toBeNull();
    expect(
      attachmentSchema.safeParse({ ...SAMPLE, format: "xlsx" }).success,
    ).toBe(false);
  });

  it("学生侧投影不接受教师侧字段（visibility / courseId 不下发）", () => {
    const parsed = studentAttachmentSchema.strict().safeParse({
      id: SAMPLE.id,
      fileName: SAMPLE.fileName,
      format: "docx",
      bytes: 10,
      pageCount: null,
      createdAt: SAMPLE.createdAt,
      visibility: "students",
    });
    expect(parsed.success).toBe(false);
  });

  it("更新体至少一项；上传文本字段都可省略", () => {
    expect(attachmentUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      attachmentUpdateSchema.parse({ visibility: "teacher_only" }).visibility,
    ).toBe("teacher_only");
    expect(attachmentUpdateSchema.parse({ fileName: "  新名字.pdf " })).toEqual(
      {
        fileName: "新名字.pdf",
      },
    );
    expect(attachmentUploadFieldsSchema.parse({})).toEqual({});
  });

  it("上限 20 MB；字节格式化；下载 URL；含答案文件名提示", () => {
    expect(ATTACHMENT_MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(formatAttachmentBytes(512)).toBe("512 B");
    expect(formatAttachmentBytes(2048)).toBe("2.0 KB");
    expect(formatAttachmentBytes(1_572_864)).toBe("1.5 MB");
    expect(attachmentFileUrl("student", "a b")).toBe(
      "/api/student/attachments/a%20b/file",
    );
    expect(ANSWER_LIKE_FILE_NAME.test("行测参考答案.pdf")).toBe(true);
    expect(ANSWER_LIKE_FILE_NAME.test("Answer Key.docx")).toBe(true);
    expect(ANSWER_LIKE_FILE_NAME.test("2024 国考真题.pdf")).toBe(false);
  });
});
