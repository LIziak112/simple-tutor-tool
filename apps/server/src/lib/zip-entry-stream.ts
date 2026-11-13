import { createWriteStream } from "node:fs";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import {
  assertZipEntryIntegrity,
  type ZipEntryPlan,
  ZipReadError,
} from "./zip-read.ts";

function* compressedChunks(bytes: Buffer) {
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    yield bytes.subarray(offset, offset + chunkBytes);
  }
}

/** 逐块写入暂存文件，校验通过前调用方不得采用此文件。 */
export async function writePlannedZipEntry(
  entry: ZipEntryPlan,
  destination: string,
): Promise<void> {
  let bytes = 0;
  let crc = 0;
  const validate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > entry.uncompressedSize) {
        callback(
          new ZipReadError(`压缩包损坏（条目展开大小不符：${entry.name}）`),
        );
        return;
      }
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(compressedChunks(entry.compressed)),
      entry.method === 8 ? createInflateRaw() : new PassThrough(),
      validate,
      createWriteStream(destination, { flags: "wx" }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("Z_")
    ) {
      throw new ZipReadError(`压缩包损坏（条目解压失败：${entry.name}）`);
    }
    throw error;
  }
  assertZipEntryIntegrity(entry, bytes, crc);
}
