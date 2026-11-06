import {
  type AnnotationSurfaceLayout,
  annotationBaseRefSchema,
  annotationDocSchema,
  annotationSurfaceLayoutCore,
  annotationSurfaceLayoutSchema,
} from "@tutor/contract";
import type { AnnotationLocalRecord } from "./annotation-store";

type QuestionSurfaceRecord = Pick<
  AnnotationLocalRecord,
  "localBase" | "base" | "sealedAt" | "conflict" | "retained"
> & {
  doc: AnnotationLocalRecord["doc"] | null;
  pending?: AnnotationLocalRecord["pending"];
  pendingMutationId?: string | null;
};

export interface QuestionSurfaceSource {
  kind: "local" | "cloud";
  baseId: string | null;
  layout: AnnotationSurfaceLayout;
  pixelWidth: number;
  pixelHeight: number;
}

export interface QuestionSurfaceResolution {
  status: "none" | "metadata-ready" | "legacy-evidence-required" | "blocked";
  source: QuestionSurfaceSource | null;
  readOnly: boolean;
  geometry: "unverified";
  reason: string | null;
}

/** 只核验来源和坐标域；调用方仍须异步核验真实 DOM，不授予显示墨层或写权。
 * record 必须来自当前账号/作答/题目/阶段的严格 store 读取；此层不跨键取稿。 */
export function resolveQuestionSurface(
  record: QuestionSurfaceRecord | null,
  questionRevisionId: string,
  externalReadOnly = false,
): QuestionSurfaceResolution {
  const readOnly = externalReadOnly || record?.sealedAt != null;
  const result = (
    status: QuestionSurfaceResolution["status"],
    source: QuestionSurfaceSource | null = null,
    reason: string | null = null,
  ): QuestionSurfaceResolution => ({
    status,
    source,
    readOnly,
    geometry: "unverified",
    reason,
  });
  if (record === null) return result("none");
  const base = record.base;
  const local = record.localBase;
  if (base !== null && !annotationBaseRefSchema.safeParse(base).success)
    return result("blocked", null, "原稿协议或底图引用损坏，原记录已保留");
  if (
    local !== null &&
    !annotationSurfaceLayoutSchema.safeParse(local.layout).success
  )
    return result("blocked", null, "原稿协议版本未知或布局损坏，原记录已保留");

  const hasLocalEdits =
    (record.pending?.mutationId ?? record.pendingMutationId ?? null) !== null ||
    record.conflict !== null ||
    record.retained !== null;
  if (local === null && hasLocalEdits)
    return result("blocked", null, "本机待同步正文缺少所属布局，原记录已保留");
  if (local === null && base === null) {
    if (
      record.doc === null ||
      record.doc.version !== 1 ||
      record.doc.baseWidth !== 0 ||
      record.doc.baseHeight !== 0 ||
      record.doc.strokes.length > 0 ||
      (record.doc.deleted?.length ?? 0) > 0 ||
      Object.keys(record.doc.anchors ?? {}).length > 0
    )
      return result("blocked", null, "圈画正文缺少所属底图，原记录已保留");
    return result("none");
  }
  let source: QuestionSurfaceSource;
  if (local !== null) {
    const sameBaseId = base !== null && local.boundBaseId === base.baseId;
    if (
      base !== null &&
      !sameBaseId &&
      !hasLocalEdits &&
      (base.state === "ready" || local.boundBaseId !== undefined)
    )
      return result(
        "blocked",
        null,
        "本机原稿与云端底图身份不同，原记录已保留，需先裁决",
      );
    if (
      base?.layout !== undefined &&
      (sameBaseId || !hasLocalEdits) &&
      JSON.stringify(annotationSurfaceLayoutCore(local.layout)) !==
        JSON.stringify(annotationSurfaceLayoutCore(base.layout))
    )
      return result(
        "blocked",
        null,
        "本机原稿与云端布局身份不同，原记录已保留",
      );
    source = {
      kind: "local",
      baseId: local.boundBaseId ?? null,
      layout: local.layout,
      pixelWidth: Math.ceil(local.layout.cssWidth * local.layout.pixelRatio),
      pixelHeight: Math.ceil(local.layout.cssHeight * local.layout.pixelRatio),
    };
  } else {
    if (base?.layout === undefined)
      return result(
        "blocked",
        null,
        "旧版 v1 原稿缺少真实题面位置证据，原记录已保留",
      );
    if (
      base.state !== "ready" ||
      base.pixelWidth === null ||
      base.pixelHeight === null
    )
      return result("blocked", null, "云端原稿尚未就绪，原记录已保留");
    source = {
      kind: "cloud",
      baseId: base.baseId,
      layout: base.layout,
      pixelWidth: base.pixelWidth,
      pixelHeight: base.pixelHeight,
    };
  }
  if (source.layout.questionRevisionId !== questionRevisionId)
    return result("blocked", source, "原稿与当前题目版本不符，原记录已保留");
  if (
    record.doc === null ||
    !annotationDocSchema.safeParse(record.doc).success ||
    record.doc.baseWidth !== source.pixelWidth ||
    record.doc.baseHeight !== source.pixelHeight
  )
    return result(
      "blocked",
      source,
      "原稿与圈画正文坐标不符或正文损坏，原记录已保留",
    );
  if (source.layout.compatibility === undefined)
    return result(
      "legacy-evidence-required",
      source,
      "旧稿缺少区域证据，须在原设备显式开笔核验原签名，原记录已保留",
    );
  return result("metadata-ready", source);
}
