import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AI_REPLY_CHECK_VERSION,
  aiReplyCheckerManifestSchema,
} from "@tutor/contract";
import { Hono } from "hono";

/** 只分发构建产物，不读取 DATA_DIR 或任何账号数据。 */
export function createAiReplyCheckerRoutes(directory?: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = directory
    ? [directory]
    : [
        join(here, "ai-reply-checker"),
        resolve(here, "../../../../dist/ai-reply-checker"),
      ];
  const manifest = () => {
    for (const path of candidates) {
      try {
        const data = aiReplyCheckerManifestSchema.parse(
          JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")),
        );
        if (
          data.version === AI_REPLY_CHECK_VERSION &&
          data.files.every(
            (file) => statSync(join(path, file.name)).size === file.bytes,
          )
        )
          return { directory: path, data };
      } catch {
        /* 尚未生成或版本不兼容，不公布不可用下载。 */
      }
    }
    return null;
  };
  return new Hono()
    .get("/manifest.json", (c) => {
      const current = manifest();
      if (!current)
        return c.json(
          {
            error: "CHECKER_UNAVAILABLE",
            message: "检查器尚未部署，可使用 MCP check_ai_reply。",
          },
          503,
        );
      return c.json(current.data, 200, { "Cache-Control": "no-cache" });
    })
    .get("/:version/:file", (c) => {
      const current = manifest();
      const file = current?.data.files.find(
        (item) => item.name === c.req.param("file"),
      );
      if (!current || !file || c.req.param("version") !== current.data.version)
        return c.notFound();
      const stream = createReadStream(join(current.directory, file.name));
      return new Response(
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${file.name}"`,
            "Content-Length": String(file.bytes),
            ETag: `"${file.sha256}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=300",
          },
        },
      );
    });
}
