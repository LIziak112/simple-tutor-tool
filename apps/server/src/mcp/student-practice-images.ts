import type { StudentMcpPracticeQuestionData } from "@tutor/contract";
import { HttpError } from "../lib/http-error";
import {
  detectImageExt,
  extractMediaImageSrcs,
  mediaContentTypeOf,
  readMediaBlobAsync,
  statMediaSrc,
} from "../services/media-service.ts";
import { AI_MCP_CLAIM_IMAGES_MAX_BYTES } from "./mcp-image-budget.ts";

type ImageMeta = StudentMcpPracticeQuestionData["images"][number];
interface ImageContent {
  type: "image";
  mimeType: ImageMeta["mimeType"];
  data: string;
}

function broken(): never {
  throw new HttpError(
    500,
    "AI_MATERIAL_BROKEN",
    "本题图片缺失或格式损坏，请联系老师检查",
  );
}

function assertBudget(totalBytes: number): void {
  if (totalBytes > AI_MCP_CLAIM_IMAGES_MAX_BYTES) {
    throw new HttpError(
      413,
      "AI_MATERIAL_TOO_LARGE",
      "本题图片超过单次附图预算，可使用 includeImages=false 显式仅读文字",
      { totalBytes, maxBytes: AI_MCP_CLAIM_IMAGES_MAX_BYTES },
    );
  }
}

/**
 * 仅消费已授权公开题面/材料内的内容寻址引用；不接任意文件名/外链，不读任务材料。
 * 先按真实stat预算避免整块读入大文件，再复查实际读取字节，全部成功后才编码交付。
 */
export async function collectStudentPracticeImages(
  dataDir: string,
  publicMarkdowns: readonly string[],
  includeImages: boolean,
  beforeRead?: (metadata: readonly ImageMeta[]) => void,
): Promise<{
  imagesIncluded: boolean;
  images: ImageMeta[];
  content: ImageContent[];
}> {
  if (!includeImages) return { imagesIncluded: false, images: [], content: [] };
  const sources = extractMediaImageSrcs(publicMarkdowns);
  let statTotal = 0;
  const metadata: ImageMeta[] = [];
  for (const src of sources) {
    const file = statMediaSrc(dataDir, src);
    if ("reason" in file) broken();
    const mimeType = mediaContentTypeOf(src.slice("blobs/media/".length));
    if (mimeType === null || file.bytes === 0) broken();
    statTotal += file.bytes;
    metadata.push({ src, mimeType, byteSize: file.bytes });
  }
  assertBudget(statTotal);
  beforeRead?.(metadata);

  let totalBytes = 0;
  const collected: {
    src: string;
    mimeType: ImageMeta["mimeType"];
    byteSize: number;
    bytes: ArrayBuffer;
  }[] = [];
  for (const src of sources) {
    const filename = src.slice("blobs/media/".length);
    const blob = await readMediaBlobAsync(dataDir, filename);
    if (blob === null) return broken();
    const format = detectImageExt(new Uint8Array(blob.bytes));
    if (format === null) return broken();
    const mimeType: ImageMeta["mimeType"] =
      format === "jpg" ? "image/jpeg" : `image/${format}`;
    if (mimeType !== blob.contentType) return broken();
    const byteSize = blob.bytes.byteLength;
    if (byteSize === 0) return broken();
    totalBytes += byteSize;
    assertBudget(totalBytes);
    collected.push({ src, mimeType, byteSize, bytes: blob.bytes });
  }
  return {
    imagesIncluded: true,
    images: collected.map(({ src, mimeType, byteSize }) => ({
      src,
      mimeType,
      byteSize,
    })),
    content: collected.map(({ mimeType, bytes }) => ({
      type: "image",
      mimeType,
      data: Buffer.from(bytes).toString("base64"),
    })),
  };
}
