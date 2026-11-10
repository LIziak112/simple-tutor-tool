import type { Attachment } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import {
  completeItem,
  localPrecheck,
  MAX_CONCURRENT_UPLOADS,
  makeUploadItem,
  patchItem,
  pickUploadsToStart,
  retryItem,
  uploadStatusText,
} from "./attachment-upload-queue";

const COURSE = "0b6f18ae-6b9a-4d0e-8b7c-9b1b1b1b1b1b";

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
      COURSE,
      "students",
      "k1",
    );
    expect(answer).toMatchObject({
      visibility: "teacher_only",
      answerLike: true,
      status: "queued",
    });
    const plain = makeUploadItem(
      file("2024 真题.pdf", 10),
      COURSE,
      "students",
      "k2",
    );
    expect(plain).toMatchObject({ visibility: "students", answerLike: false });
    const teacherOnly = makeUploadItem(
      file("Answer Key.docx", 10),
      COURSE,
      "teacher_only",
      "k3",
    );
    expect(teacherOnly).toMatchObject({
      visibility: "teacher_only",
      answerLike: false,
    });
    const bad = makeUploadItem(file("图.png", 10), COURSE, "students", "k4");
    expect(bad.status).toBe("failed");
    expect(uploadStatusText(bad)).toBe(
      "上传失败：只接受 PDF 与 Word（.docx）文件",
    );
  });

  it("每个条目带一个 UUID 幂等键 uploadId，随条目保留（重试复用，#103-04）", () => {
    const item = makeUploadItem(file("a.pdf", 10), COURSE, "students", "k1");
    expect(item.uploadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const other = makeUploadItem(file("b.pdf", 10), COURSE, "students", "k2");
    expect(other.uploadId).not.toBe(item.uploadId);
    const retried = patchItem([item], "k1", {
      status: "queued",
      error: null,
    })[0] as typeof item;
    expect(retried.uploadId).toBe(item.uploadId);
  });

  it("调度：同时最多 2 个在传，按入队顺序补位；失败 / 完成 / 无文件的不参与（#103-05）", () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(2);
    const items = ["a", "b", "c", "d"].map((k) =>
      makeUploadItem(file(`${k}.pdf`, 10), COURSE, "students", k),
    );
    expect(pickUploadsToStart(items).map((i) => i.key)).toEqual(["a", "b"]);
    const oneRunning = patchItem(items, "a", { status: "uploading" });
    expect(pickUploadsToStart(oneRunning).map((i) => i.key)).toEqual(["b"]);
    const twoRunning = patchItem(oneRunning, "b", { status: "uploading" });
    expect(pickUploadsToStart(twoRunning)).toEqual([]);
    const aDone = completeItem(twoRunning, "a", {} as Attachment);
    expect(pickUploadsToStart(aDone).map((i) => i.key)).toEqual(["c"]);
    // 失败的、本地预检失败（没有文件可传）的都不会被挑中
    const withFailed = [
      ...patchItem(items, "c", { status: "failed", error: "x" }),
      makeUploadItem(file("e.png", 10), COURSE, "students", "e"),
    ];
    expect(pickUploadsToStart(withFailed, 10).map((i) => i.key)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("完成项释放 File 但保留展示信息；重试只对持有文件的失败项生效（#103-05）", () => {
    const item = makeUploadItem(file("a.pdf", 2048), COURSE, "students", "a");
    expect(item.file).not.toBeNull();
    const done = completeItem([item], "a", { id: "x" } as Attachment)[0];
    expect(done).toMatchObject({
      status: "done",
      progress: 1,
      file: null,
      fileName: "a.pdf",
      fileSize: 2048,
      result: { id: "x" },
    });
    const failed = patchItem([item], "a", {
      status: "failed",
      error: "网络",
      progress: 0.3,
    });
    const retried = retryItem(failed, "a")[0];
    expect(retried).toMatchObject({
      status: "queued",
      error: null,
      progress: 0,
      uploadId: item.uploadId,
    });
    // 已完成的不会被重试；本地预检失败的没有文件、也不会
    expect(retryItem([done as typeof item], "a")[0]?.status).toBe("done");
    const bad = makeUploadItem(file("图.png", 10), COURSE, "students", "b");
    expect(bad.file).toBeNull();
    expect(retryItem([bad], "b")[0]?.status).toBe("failed");
  });

  it("patchItem 只改目标行；状态文案", () => {
    const a = makeUploadItem(file("a.pdf", 10), COURSE, "students", "a");
    const b = makeUploadItem(file("b.pdf", 10), COURSE, "students", "b");
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
