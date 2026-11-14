import type { AttachmentVisibility } from "@tutor/contract";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  type PortalRuntime,
  usePortalRuntime,
} from "@/features/runtime/portal-runtime";
import {
  completeItem,
  makeUploadItem,
  patchItem,
  pickUploadsToStart,
  retryItem,
  type UploadItem,
} from "./attachment-upload-queue";

type AttachmentRuntime = Pick<PortalRuntime, "subject" | "clients" | "signal">;
type AttachmentLease = AttachmentRuntime & {
  subject: NonNullable<PortalRuntime["subject"]>;
};
let items: readonly UploadItem[] = [];
const leases = new Map<string, AttachmentLease>();
const listeners = new Set<() => void>();
const completedListeners = new Set<{
  owner: string;
  listener: (item: UploadItem) => void;
}>();
const staleCourses = new Set<string>();
const ownerOf = (runtime: AttachmentRuntime) =>
  runtime.subject
    ? JSON.stringify([runtime.subject.type, runtime.subject.id])
    : null;
const courseKey = (owner: string, courseId: string) =>
  JSON.stringify([owner, courseId]);
function capture(runtime: AttachmentRuntime): AttachmentLease {
  if (runtime.subject === null) throw new Error("请登录后选择上传文件");
  runtime.signal.throwIfAborted();
  return Object.freeze({
    subject: runtime.subject,
    clients: runtime.clients,
    signal: runtime.signal,
  });
}
function emit() {
  for (const listener of listeners) listener();
}
function commit(next: readonly UploadItem[]) {
  items = next;
  emit();
}
let scheduling = false;
function setItems(next: readonly UploadItem[]) {
  commit(next);
  if (scheduling) return;
  scheduling = true;
  try {
    for (const item of pickUploadsToStart(
      items.filter((item) => {
        const lease = leases.get(item.key);
        return lease && !lease.signal.aborted;
      }),
    ))
      if (item.file !== null) void run(item, item.file);
  } finally {
    scheduling = false;
  }
}
async function run(item: UploadItem, file: File) {
  const lease = leases.get(item.key);
  if (
    !lease ||
    lease.signal.aborted ||
    items.find((it) => it.key === item.key)?.status !== "queued"
  )
    return;
  const current = () => leases.get(item.key) === lease && !lease.signal.aborted;
  setItems(
    patchItem(items, item.key, {
      status: "uploading",
      progress: 0,
      error: null,
    }),
  );
  try {
    const result = await lease.clients.uploadAttachmentApi(file, {
      courseId: item.courseId,
      visibility: item.visibility,
      uploadId: item.uploadId,
      onProgress: (ratio) => {
        if (current()) commit(patchItem(items, item.key, { progress: ratio }));
      },
    });
    if (!current()) return;
    setItems(completeItem(items, item.key, result));
    const done = items.find((it) => it.key === item.key);
    if (!done) return;
    const owner = ownerOf(lease);
    if (owner === null) return;
    const consumers = [...completedListeners].filter(
      (entry) => entry.owner === owner,
    );
    if (consumers.length === 0)
      staleCourses.add(courseKey(owner, done.courseId));
    for (const entry of consumers) entry.listener(done);
  } catch (error) {
    if (current())
      setItems(
        patchItem(items, item.key, {
          status: "failed",
          error: error instanceof Error ? error.message : "未知原因",
        }),
      );
  }
}
/** 条目拥有入队主体与不可重绑租约；重试不会借用后来账号。 */
export function enqueueAttachmentUploads(
  runtime: AttachmentRuntime,
  files: readonly File[],
  courseId: string,
  defaultVisibility: AttachmentVisibility,
) {
  const lease = capture(runtime);
  const added = files.map((file) =>
    makeUploadItem(file, courseId, defaultVisibility),
  );
  for (const item of added) leases.set(item.key, lease);
  setItems([...items, ...added]);
}
export function retryAttachmentUpload(key: string) {
  setItems(retryItem(items, key));
}
export function removeAttachmentUpload(key: string) {
  leases.delete(key);
  setItems(items.filter((item) => item.key !== key));
}
/** 同一已确认主体重新进入时显式接回待传文件，旧作业仍持有旧租约并丢弃迟到结果。 */
export function resumeAttachmentUploads(runtime: AttachmentRuntime) {
  const owner = ownerOf(runtime);
  if (owner === null || runtime.signal.aborted) return;
  let next = items;
  let lease: AttachmentLease | undefined;
  for (const item of items) {
    const previous = leases.get(item.key);
    if (
      !previous ||
      ownerOf(previous) !== owner ||
      !previous.signal.aborted ||
      item.file === null
    )
      continue;
    lease ??= capture(runtime);
    leases.set(item.key, lease);
    next = patchItem(next, item.key, {
      status: "queued",
      progress: 0,
      error: null,
    });
  }
  if (next !== items) setItems(next);
}
export function onAttachmentUploadCompleted(
  runtime: AttachmentRuntime,
  listener: (item: UploadItem) => void,
) {
  const owner = ownerOf(runtime);
  if (owner === null) return () => {};
  const entry = { owner, listener };
  completedListeners.add(entry);
  return () => {
    completedListeners.delete(entry);
  };
}
export function takeStaleAttachmentCourse(
  runtime: AttachmentRuntime,
  courseId: string,
) {
  const owner = ownerOf(runtime);
  return owner !== null && staleCourses.delete(courseKey(owner, courseId));
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useAttachmentUploadQueue(
  courseId: string,
): readonly UploadItem[] {
  const runtime = usePortalRuntime();
  const owner = ownerOf(runtime);
  useEffect(() => resumeAttachmentUploads(runtime), [runtime]);
  const all = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
  return useMemo(
    () =>
      all.filter((item) => {
        const lease = leases.get(item.key);
        return (
          item.courseId === courseId &&
          owner !== null &&
          lease !== undefined &&
          ownerOf(lease) === owner
        );
      }),
    [all, courseId, owner],
  );
}
export function resetAttachmentUploadStoreForTest() {
  items = [];
  leases.clear();
  staleCourses.clear();
  completedListeners.clear();
  emit();
}
