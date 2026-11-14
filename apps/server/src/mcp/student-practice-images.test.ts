import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mediaService from "../services/media-service.ts";
import { AI_MCP_CLAIM_IMAGES_MAX_BYTES } from "./mcp-image-budget.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture(size: number, extension = "png") {
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-mcp-read-image-"));
  temporary.push(dataDir);
  mkdirSync(join(dataDir, "blobs", "media"), { recursive: true });
  const filename = `${"a".repeat(64)}.${extension}`;
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  writeFileSync(join(dataDir, "blobs", "media", filename), bytes);
  return { dataDir, src: `blobs/media/${filename}` };
}

describe("学生 MCP 公开题图预算", () => {
  it.each([AI_MCP_CLAIM_IMAGES_MAX_BYTES - 1, AI_MCP_CLAIM_IMAGES_MAX_BYTES])(
    "真实原字节 %i 在预算内完整返回",
    async (size) => {
      const { collectStudentPracticeImages } = await import(
        "./student-practice-images.ts"
      );
      const { dataDir, src } = fixture(size);
      const result = await collectStudentPracticeImages(
        dataDir,
        [`::image{src="${src}"}`],
        true,
      );
      expect(result.imagesIncluded).toBe(true);
      expect(result.images).toEqual([
        { src, byteSize: size, mimeType: "image/png" },
      ]);
      expect(result.content).toHaveLength(1);
      expect(
        Buffer.from(result.content[0]?.data ?? "", "base64").byteLength,
      ).toBe(size);
    },
  );

  it("多处引用同图只计一次，预算超一字节明确失败，不交付部分图片", async () => {
    const { collectStudentPracticeImages } = await import(
      "./student-practice-images.ts"
    );
    const { dataDir, src } = fixture(AI_MCP_CLAIM_IMAGES_MAX_BYTES + 1);
    await expect(
      collectStudentPracticeImages(
        dataDir,
        [`::image{src="${src}"}`, `::image{src='${src}'}`],
        true,
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "AI_MATERIAL_TOO_LARGE", status: 413 }),
    );
  });

  it("同图跨题面与材料去重，并按真实MIME出SDK图片", async () => {
    const { collectStudentPracticeImages } = await import(
      "./student-practice-images.ts"
    );
    const { dataDir, src } = fixture(76);
    const result = await collectStudentPracticeImages(
      dataDir,
      [`::image{src="${src}"}`, `::image{src='${src}'}`],
      true,
    );
    expect(result.images).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("显式不附图不触碰缺失文件，绝不暗建任务或租约", async () => {
    const { collectStudentPracticeImages } = await import(
      "./student-practice-images.ts"
    );
    const { dataDir, src } = fixture(76);
    rmSync(join(dataDir, src));
    expect(
      await collectStudentPracticeImages(
        dataDir,
        [`::image{src="${src}"}`],
        false,
      ),
    ).toEqual({ imagesIncluded: false, images: [], content: [] });
    await expect(
      collectStudentPracticeImages(dataDir, [`::image{src="${src}"}`], true),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "AI_MATERIAL_BROKEN" }),
    );
  });

  it("不读取外链或任意路径；合法引用的格式损坏不能虚报已附图", async () => {
    const { collectStudentPracticeImages } = await import(
      "./student-practice-images.ts"
    );
    const { dataDir, src } = fixture(76, "jpg");
    expect(
      (
        await collectStudentPracticeImages(
          dataDir,
          [
            '::image{src="https://example.com/x.png"}',
            '::image{src="../secret.png"}',
          ],
          true,
        )
      ).content,
    ).toEqual([]);
    await expect(
      collectStudentPracticeImages(dataDir, [`::image{src="${src}"}`], true),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "AI_MATERIAL_BROKEN" }),
    );
  });

  it("私有memo/notes/ink/附件引用不进入全局媒体namespace，零文件读取", async () => {
    const { collectStudentPracticeImages } = await import(
      "./student-practice-images.ts"
    );
    const { dataDir } = fixture(76);
    const privateFile = "blobs/notes/foreign-student/private.png";
    mkdirSync(join(dataDir, "blobs/notes/foreign-student"), {
      recursive: true,
    });
    writeFileSync(join(dataDir, privateFile), Buffer.from("真实私有文件哨兵"));
    const read = vi.spyOn(mediaService, "readMediaBlobAsync");
    const refs = [
      privateFile,
      `blobs/ink/foreign-attempt/${"a".repeat(64)}.png`,
      `blobs/annotations/${"a".repeat(64)}.png`,
      "/api/student/memos/foreign-memo/media",
      "/api/student/attachments/foreign-attachment/content",
    ];
    expect(
      await collectStudentPracticeImages(
        dataDir,
        refs.map((src) => `::image{src="${src}"}`),
        true,
      ),
    ).toEqual({ imagesIncluded: true, images: [], content: [] });
    expect(read).not.toHaveBeenCalled();
  });
});
