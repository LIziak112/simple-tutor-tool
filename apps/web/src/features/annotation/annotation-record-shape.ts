import { annotationBaseRefSchema, annotationDocSchema } from "@tutor/contract";
import type { AnnotationLocalRecord } from "./annotation-store";

export function freshRecord(): AnnotationLocalRecord {
  return {
    localBase: null,
    doc: { version: 1, baseWidth: 0, baseHeight: 0, strokes: [] },
    pending: null,
    baseRevision: 0,
    annotationId: null,
    sealedAt: null,
    base: null,
    baseDisabledReason: null,
    conflict: null,
    retained: null,
    denied: null,
    local: "saved",
    localError: null,
    editedAt: 0,
    docVersion: 0,
  };
}

/** 读取旧记录的防御性归一（缺字段补默认；非空坏形必须保留并报错）。
 *  localBase 不在此处装配（需异步取底图键），恒置 null 由调用方回填。 */
export function reviveRecord(
  raw: unknown,
): { record: AnnotationLocalRecord; rawLocalBase: unknown } | null {
  if (typeof raw !== "object" || raw === null)
    throw new Error("本机标画记录损坏，原记录已保留，请重试");
  const r = raw as Partial<AnnotationLocalRecord>;
  const doc = r.doc;
  if (!doc) throw new Error("本机圈画正文缺失，原记录已保留，请重试");
  const emptySentinel =
    doc?.version === 1 &&
    doc.baseWidth === 0 &&
    doc.baseHeight === 0 &&
    Array.isArray(doc.strokes) &&
    doc.strokes.length === 0 &&
    doc.deleted === undefined &&
    doc.anchors === undefined;
  if (!emptySentinel && !annotationDocSchema.safeParse(doc).success)
    throw new Error(
      "本机圈画正文版本未知或内容损坏，原记录已保留，请更新后重试",
    );
  if (
    r.pending != null &&
    (typeof r.pending.mutationId !== "string" ||
      !annotationDocSchema.safeParse(r.pending.doc).success)
  )
    throw new Error(
      "本机待传圈画版本未知或内容损坏，原记录已保留，请更新后重试",
    );
  if (r.base != null && !annotationBaseRefSchema.safeParse(r.base).success)
    throw new Error(
      "本机圈画底图引用版本未知或内容损坏，原记录已保留，请更新后重试",
    );
  return {
    record: {
      ...freshRecord(),
      localBase: null,
      resetVersion: typeof r.resetVersion === "number" ? r.resetVersion : 0,
      doc,
      pending: r.pending ?? null,
      baseRevision: typeof r.baseRevision === "number" ? r.baseRevision : 0,
      annotationId: typeof r.annotationId === "string" ? r.annotationId : null,
      sealedAt: typeof r.sealedAt === "string" ? r.sealedAt : null,
      base: r.base ?? null,
      baseDisabledReason:
        typeof r.baseDisabledReason === "string" ? r.baseDisabledReason : null,
      conflict:
        r.conflict == null
          ? null
          : {
              // 旧记录无 kind 的缺省推导：current 非空→revision（对齐重传）、
              // 空→mutation（重铸重传）——完整保留旧裁决行为；确是 layout 冲突的
              // 旧记录重撞一次后即带类别落库，自愈到新出口。
              kind:
                r.conflict.kind === "revision" ||
                r.conflict.kind === "mutation" ||
                r.conflict.kind === "layout"
                  ? r.conflict.kind
                  : r.conflict.current != null
                    ? "revision"
                    : "mutation",
              reason:
                typeof r.conflict.reason === "string" ? r.conflict.reason : "",
              current: r.conflict.current ?? null,
            },
      retained:
        r.retained && typeof r.retained.reason === "string"
          ? { reason: r.retained.reason }
          : null,
      denied: r.denied ?? null,
      editedAt: typeof r.editedAt === "number" ? r.editedAt : 0,
      docVersion: typeof r.docVersion === "number" ? r.docVersion : 0,
      // 持久副本恒归一化（存在于 IDB 即已落盘）
      local: "saved",
      localError: null,
    },
    rawLocalBase: (raw as { localBase?: unknown }).localBase,
  };
}
