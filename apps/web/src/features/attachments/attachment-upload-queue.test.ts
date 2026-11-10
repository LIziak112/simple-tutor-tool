import { describe, expect, it } from "vitest";
import {
  localPrecheck,
  makeUploadItem,
  patchItem,
  uploadStatusText,
} from "./attachment-upload-queue";

function file(name: string, size: number): File {
  const f = new File([new Uint8Array(1)], name, { type: "application/pdf" });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("上传队列模型（模块 6 第一步）", () => {
  it("本地预检：扩展名、20 MB、空文件", () => {
    expect(localPrecheck(file("a.pdf", 10))).toBeNull();
    expect(localPrecheck(file("b.DOCX", 10))).toBeNull();
    expect(localPrecheck(file("c.xlsx", 10))).toBe(
      "只接受 PDF 与 Word（.docx）文件",
    );
    expect(localPrecheck(file("d.pdf", 20 * 1024 * 1024 + 1))).toContain(
      "20 MB",
    );
    expect(localPrecheck(file("e.pdf", 0))).toBe("文件是空的");
  });

  it("含答案文件名在默认学生可见时改为仅教师可见并标记；默认仅教师可见时不标记", () => {
    const answer = makeUploadItem(
      file("行测参考答案.pdf", 10),
      "students",
      "k1",
    );
    expect(answer).toMatchObject({
      visibility: "teacher_only",
      answerLike: true,
      status: "queued",
    });
    const plain = makeUploadItem(file("2024 真题.pdf", 10), "students", "k2");
    expect(plain).toMatchObject({ visibility: "students", answerLike: false });
    const teacherOnly = makeUploadItem(
      file("Answer Key.docx", 10),
      "teacher_only",
      "k3",
    );
    expect(teacherOnly).toMatchObject({
      visibility: "teacher_only",
      answerLike: false,
    });
    const bad = makeUploadItem(file("图.png", 10), "students", "k4");
    expect(bad.status).toBe("failed");
    expect(uploadStatusText(bad)).toBe(
      "上传失败：只接受 PDF 与 Word（.docx）文件",
    );
  });

  it("patchItem 只改目标行；状态文案", () => {
    const a = makeUploadItem(file("a.pdf", 10), "students", "a");
    const b = makeUploadItem(file("b.pdf", 10), "students", "b");
    const next = patchItem([a, b], "b", {
      status: "uploading",
      progress: 0.42,
    });
    expect(next[0]).toBe(a);
    expect(uploadStatusText(next[1] as typeof b)).toBe("上传中 42%");
    expect(uploadStatusText(a)).toBe("等待上传");
    expect(uploadStatusText({ ...a, status: "done", progress: 1 })).toBe(
      "已上传",
    );
  });
});
