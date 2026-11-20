import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { questionEvidenceBindings } from "@tutor/contract";
import type { KernelFormalInkAnchor } from "@tutor/contract/kernel-question-delivery";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ink, type ResponseRow } from "../db/schema.ts";
import { resolveWithinRoot } from "../lib/blob-io.ts";
import { canonicalJsonOf } from "../lib/canonical-json.ts";
import { HttpError } from "../lib/http-error.ts";
import { snapshotOfRow } from "./snapshot.ts";

export function inkFileAbs(
  dataDir: string,
  relPath: string,
  suffix: string | undefined,
): string {
  return resolveWithinRoot(dataDir, join("blobs", "ink"), relPath, {
    ...(suffix ? { suffix } : {}),
    violationCode: "INK_UNREADABLE",
  });
}

export function needsFormalInkAnchor(
  row: Pick<ResponseRow, "attemptId" | "questionId" | "questionSnapshotJson">,
): boolean {
  const question = snapshotOfRow(row);
  return Boolean(
    question &&
      questionEvidenceBindings[question.type].paperRole === "answerInk",
  );
}

function readAttachment(dataDir: string, path: string, suffix: string) {
  const bytes = readFileSync(inkFileAbs(dataDir, path, suffix));
  return {
    bytes,
    reference: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** 调用方已校验该卷与冻结题的归属，并在写锁内选择提交版本。 */
export function captureFormalInkAnchor(
  db: Db,
  dataDir: string,
  attemptId: string,
  questionId: string,
): KernelFormalInkAnchor {
  const current = db
    .select()
    .from(ink)
    .where(and(eq(ink.attemptId, attemptId), eq(ink.questionId, questionId)))
    .get();
  if (!current) return { questionId, ink: null };
  try {
    const strokes = readAttachment(dataDir, current.strokesPath, ".json.gz");
    const png = readAttachment(dataDir, current.pngPath, ".png");
    const hash = createHash("sha256")
      .update(strokes.bytes)
      .update(png.bytes)
      .digest("hex");
    if (current.bodyHash !== null && current.bodyHash !== hash)
      throw new Error("正式笔迹上传摘要不符");
    return {
      questionId,
      ink: {
        inkId: current.id,
        revision: current.revision,
        strokeCount: current.strokeCount,
        strokes: strokes.reference,
        png: png.reference,
      },
    };
  } catch {
    throw new HttpError(
      500,
      "INK_UNREADABLE",
      "正式笔迹文件无法核对，请联系老师处理",
    );
  }
}

export function assertFormalInkAnchor(
  db: Db,
  dataDir: string,
  attemptId: string,
  expected: KernelFormalInkAnchor,
): void {
  const current = captureFormalInkAnchor(
    db,
    dataDir,
    attemptId,
    expected.questionId,
  );
  if (canonicalJsonOf(current) !== canonicalJsonOf(expected))
    throw new HttpError(
      409,
      "INK_REVISION_CONFLICT",
      "正式笔迹已变化，请核对后重试",
    );
}
