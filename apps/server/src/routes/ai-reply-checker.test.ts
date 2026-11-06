import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAiReplyCheckerRoutes } from "./ai-reply-checker.ts";

it("公开分发只含检查器元数据和白名单文件，不读取学生数据", async () => {
  const directory = mkdtempSync(join(tmpdir(), "checker-download-"));
  try {
    const bytes = Buffer.from("检查器测试产物");
    const file = {
      name: "ownclass-ai-check.cjs",
      platform: "node",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    writeFileSync(join(directory, file.name), bytes);
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({ version: "1.0.0", files: [file] }),
    );
    const app = createAiReplyCheckerRoutes(directory);
    const manifest = await app.request("/manifest.json");
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toEqual({ version: "1.0.0", files: [file] });
    const response = await app.request("/1.0.0/ownclass-ai-check.cjs");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    for (const path of [
      "/0.9.0/ownclass-ai-check.cjs",
      "/1.0.0/secret.key",
      "/1.0.0/ownclass-ai-check.exe",
    ])
      expect((await app.request(path)).status).toBe(404);
    expect(
      JSON.stringify(await (await app.request("/manifest.json")).json()),
    ).not.toMatch(/studentId|answers|solutionMd|teacherComment|token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
