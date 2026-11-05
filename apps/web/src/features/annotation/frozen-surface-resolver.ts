import {
  ANNOTATION_BASE_PNG_MAX_BYTES,
  type AnnotationSurfaceLayout,
  annotationBaseRefSchema,
  annotationDocSchema,
  annotationSurfaceLayoutCore,
  annotationSurfaceLayoutSchema,
} from "@tutor/contract";
import type { AnnotationLocalRecord } from "./annotation-store";

type FrozenQuestionRecord = Pick<
  AnnotationLocalRecord,
  "localBase" | "base" | "sealedAt" | "conflict" | "retained"
> & {
  doc: AnnotationLocalRecord["doc"] | null;
  pending?: AnnotationLocalRecord["pending"];
  pendingMutationId?: string | null;
};

export type FrozenQuestionSource =
  | {
      kind: "local";
      blob: Blob;
      pixelWidth: number;
      pixelHeight: number;
      layout: AnnotationSurfaceLayout;
    }
  | {
      kind: "cloud";
      baseId: string;
      downloadUrl: string;
      pixelWidth: number;
      pixelHeight: number;
      layout: AnnotationSurfaceLayout;
    };

export interface FrozenQuestionImageState {
  sourceUrl: string | null;
  decoded: {
    url: string;
    blob: Blob | null;
    width: number;
    height: number;
    failed: boolean;
  } | null;
}

export interface FrozenQuestionResolution {
  status: "none" | "legacy" | "waiting" | "ready" | "blocked";
  source: FrozenQuestionSource | null;
  canReadInk: boolean;
  canWrite: boolean;
  readOnly: boolean;
  reason: string | null;
}

function result(
  status: FrozenQuestionResolution["status"],
  source: FrozenQuestionSource | null,
  readOnly: boolean,
  reason: string | null = null,
): FrozenQuestionResolution {
  return {
    status,
    source,
    canReadInk: status === "ready",
    canWrite: status === "ready" && !readOnly,
    readOnly,
    reason,
  };
}

/** 同一判定供被动恢复和显式开笔；控件适配能力另由 answering 决定。 */
export function resolveFrozenQuestionSurface(
  record: FrozenQuestionRecord | null,
  image: FrozenQuestionImageState,
  externalReadOnly: boolean,
): FrozenQuestionResolution {
  if (record === null) return result("none", null, externalReadOnly);
  const readOnly = externalReadOnly || record.sealedAt !== null;
  const base = record.base;
  if (base !== null && !annotationBaseRefSchema.safeParse(base).success)
    return result(
      "blocked",
      null,
      readOnly,
      "原稿协议或底图引用损坏，原记录已保留",
    );
  const local = record.localBase;
  const hasLocalEdits =
    (record.pending?.mutationId ?? record.pendingMutationId ?? null) !== null ||
    record.conflict !== null ||
    record.retained !== null;
  if (
    local !== null &&
    !annotationSurfaceLayoutSchema.safeParse(local.layout).success
  )
    return result("blocked", null, readOnly, "原稿协议版本未知，原记录已保留");
  if (local === null && base === null) return result("none", null, readOnly);
  if (local === null && base?.layout === undefined)
    return result("legacy", null, true);

  let source: FrozenQuestionSource | null = null;
  const cloudReady = base?.state === "ready" && base.layout !== undefined;
  if (local === null && cloudReady) {
    if (
      base?.layout === undefined ||
      base.downloadUrl === undefined ||
      base.pixelWidth === null ||
      base.pixelHeight === null
    )
      return result(
        "blocked",
        null,
        readOnly,
        "云端原稿尚未可读，原记录已保留",
      );
    source = {
      kind: "cloud",
      baseId: base.baseId,
      downloadUrl: base.downloadUrl,
      pixelWidth: base.pixelWidth,
      pixelHeight: base.pixelHeight,
      layout: base.layout,
    };
  } else if (local !== null) {
    const sameBaseId = base !== null && local.boundBaseId === base.baseId;
    if (
      base !== null &&
      local.boundBaseId !== base.baseId &&
      !hasLocalEdits &&
      (base.state === "ready" || local.boundBaseId !== undefined)
    )
      return result(
        "blocked",
        null,
        readOnly,
        "本机原稿与云端底图身份不同，需先裁决或读取，不能叠画",
      );
    if (
      local.png.type !== "image/png" ||
      local.png.size === 0 ||
      local.png.size > ANNOTATION_BASE_PNG_MAX_BYTES
    )
      return result(
        "blocked",
        null,
        readOnly,
        "本机原稿图片损坏，原记录已保留",
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
        readOnly,
        "本机原稿与云端布局身份不同，不能叠画",
      );
    source = {
      kind: "local",
      blob: local.png,
      pixelWidth: Math.ceil(local.layout.cssWidth * local.layout.pixelRatio),
      pixelHeight: Math.ceil(local.layout.cssHeight * local.layout.pixelRatio),
      layout: local.layout,
    };
  } else if (base?.layout === undefined) {
    return result("legacy", null, true);
  } else {
    return result("blocked", null, readOnly, "云端原稿尚未就绪，原记录已保留");
  }

  if (
    record.doc === null ||
    !annotationDocSchema.safeParse(record.doc).success ||
    record.doc.baseWidth !== source.pixelWidth ||
    record.doc.baseHeight !== source.pixelHeight
  )
    return result(
      "blocked",
      source,
      readOnly,
      "原稿与圈画坐标不符，笔迹已保留",
    );
  const { sourceUrl, decoded } = image;
  const expectedUrl = source.kind === "cloud" ? source.downloadUrl : sourceUrl;
  if (
    !sourceUrl ||
    sourceUrl !== expectedUrl ||
    !decoded ||
    decoded.url !== expectedUrl ||
    decoded.blob !== (source.kind === "local" ? source.blob : null)
  )
    return result("waiting", source, readOnly);
  if (
    decoded.failed ||
    decoded.width !== source.pixelWidth ||
    decoded.height !== source.pixelHeight
  )
    return result(
      "blocked",
      source,
      readOnly,
      "原稿图片尺寸与保存的圈画坐标不符，笔迹已保留",
    );
  return result("ready", source, readOnly);
}
