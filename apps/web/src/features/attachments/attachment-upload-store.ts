import type { AttachmentVisibility } from "@tutor/contract";
import { useMemo, useSyncExternalStore } from "react";
import { uploadAttachmentApi } from "@/lib/attachment-api";
import {
  completeItem,
  makeUploadItem,
  patchItem,
  pickUploadsToStart,
  retryItem,
  type UploadItem,
} from "./attachment-upload-queue";

/**
 * 上传队列的模块级状态（#103-05 第二轮）：并发上限 2 意味着第 3 个起的文件在选中
 * 那一刻还没发请求——队列若活在「资料」页签组件里，切页签（组件卸载）就会把没开始
 * 的文件无声丢掉，换课程（同一组件实例、courseId 变了）则会把为 A 选的文件传进 B。
 * 这里把队列搬到模块级：条目入队时记下 courseId，请求按条目自己的 courseId 发；
 * 页签只订阅并渲染本课程的条目，卸载不影响在传 / 排队的文件。
 * 完成通知：有页签在听就直接回调（刷新列表）；没有人听就把课程记成「列表过期」，
 * 页签下次挂载时 takeStaleAttachmentCourse 取走并刷新一次。
 */
let items: readonly UploadItem[] = [];
const listeners = new Set<() => void>();
const completedListeners = new Set<(item: UploadItem) => void>();
const staleCourses = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 只改状态并通知订阅者（进度更新用，不触发调度） */
function commit(next: readonly UploadItem[]): void {
  items = next;
  emit();
}

let scheduling = false;

/**
 * 改状态后补位：在传的不足上限就按入队顺序把待上传的发出去。run 同步把条目改成
 * uploading 时会再进到这里——补位期间不再嵌套调度，否则第二条会抢在第一条前发请求。
 */
function setItems(next: readonly UploadItem[]): void {
  commit(next);
  if (scheduling) return;
  scheduling = true;
  try {
    for (const item of pickUploadsToStart(items)) {
      if (item.file !== null) void run(item, item.file);
    }
  } finally {
    scheduling = false;
  }
}

async function run(item: UploadItem, file: File): Promise<void> {
  if (items.find((it) => it.key === item.key)?.status !== "queued") return;
  setItems(
    patchItem(items, item.key, {
      status: "uploading",
      progress: 0,
      error: null,
    }),
  );
  try {
    const result = await uploadAttachmentApi(file, {
      courseId: item.courseId,
      visibility: item.visibility,
      uploadId: item.uploadId,
      onProgress: (ratio) =>
        commit(patchItem(items, item.key, { progress: ratio })),
    });
    setItems(completeItem(items, item.key, result));
    const done = items.find((it) => it.key === item.key);
    if (done === undefined) return;
    if (completedListeners.size === 0) {
      staleCourses.add(done.courseId);
      return;
    }
    for (const listener of completedListeners) listener(done);
  } catch (err) {
    setItems(
      patchItem(items, item.key, {
        status: "failed",
        error: err instanceof Error ? err.message : "未知原因",
      }),
    );
  }
}

/** 选文件入队（追加到队尾：显示顺序 = 入队顺序 = 上传顺序），有空位立即开始 */
export function enqueueAttachmentUploads(
  files: readonly File[],
  courseId: string,
  defaultVisibility: AttachmentVisibility,
): void {
  setItems([
    ...items,
    ...files.map((file) => makeUploadItem(file, courseId, defaultVisibility)),
  ]);
}

/** 重试：只对仍持有文件的失败项生效，回到待上传由调度补位 */
export function retryAttachmentUpload(key: string): void {
  setItems(retryItem(items, key));
}

/** 移除一行（在传的行不提供移除） */
export function removeAttachmentUpload(key: string): void {
  setItems(items.filter((item) => item.key !== key));
}

/** 某条上传成功时回调（页签据此刷新该课程的资料列表；按条目的 courseId，不限当前页签） */
export function onAttachmentUploadCompleted(
  listener: (item: UploadItem) => void,
): () => void {
  completedListeners.add(listener);
  return () => {
    completedListeners.delete(listener);
  };
}

/** 页签挂载时取走「没人听时完成过上传」的标记：true = 该课程列表需要刷新一次 */
export function takeStaleAttachmentCourse(courseId: string): boolean {
  return staleCourses.delete(courseId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 本课程的队列条目（其他课程的条目仍在后台传，各自在各自的页签里显示） */
export function useAttachmentUploadQueue(
  courseId: string,
): readonly UploadItem[] {
  const all = useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
  return useMemo(
    () => all.filter((item) => item.courseId === courseId),
    [all, courseId],
  );
}

/** 测试用：清空队列与通知状态 */
export function resetAttachmentUploadStoreForTest(): void {
  items = [];
  staleCourses.clear();
  completedListeners.clear();
  emit();
}
