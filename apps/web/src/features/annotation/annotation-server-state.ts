import type { AnnotationLocalRecord } from "./annotation-store";

/** 服务端维度派生：denied > conflict > retained > uploading > dirty > synced */
export function deriveAnnotationServerState(
  record: AnnotationLocalRecord,
  uploading: boolean,
): "denied" | "conflict" | "retained" | "uploading" | "dirty" | "synced" {
  if (record.denied !== null) return "denied";
  if (record.conflict !== null) return "conflict";
  if (record.retained !== null) return "retained";
  if (uploading) return "uploading";
  if (record.pending !== null) return "dirty";
  return "synced";
}
