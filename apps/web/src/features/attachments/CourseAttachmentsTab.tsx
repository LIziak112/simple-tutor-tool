import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttachmentVisibility } from "@tutor/contract";
import { formatAttachmentBytes } from "@tutor/contract";
import { FileText, RotateCcw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { listAttachmentsApi } from "@/lib/attachment-api";
import { AttachmentList, VISIBILITY_LABEL } from "./AttachmentList";
import { type UploadItem, uploadStatusText } from "./attachment-upload-queue";
import {
  enqueueAttachmentUploads,
  onAttachmentUploadCompleted,
  removeAttachmentUpload,
  retryAttachmentUpload,
  takeStaleAttachmentCourse,
  useAttachmentUploadQueue,
} from "./attachment-upload-store";

/**
 * 课程「资料」页签（2026-11-10 个人学习迭代模块 6 第一步）：上传 PDF / docx 原件
 * （进度、失败原因、重试、移除；按入队顺序最多 2 个同时在传，成功后释放文件，
 * #103-05；队列是模块级的 attachment-upload-store——切页签 / 换课程不丢排队中的
 * 文件、也不会把文件传进别的课程）、资料列表（文件名 / 格式 / 大小 / 页数已知时 /
 * 可见性 / 上传时间）、改可见性、下载、删除（软删）。
 * 可见性文案与契约一致：students =「学生可查看和下载」/ teacher_only =「仅教师可见」。
 */
export const attachmentsKey = (courseId: string) =>
  ["attachments", courseId] as const;

export function CourseAttachmentsTab({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: attachmentsKey(courseId),
    queryFn: () => listAttachmentsApi(courseId),
    staleTime: 15_000,
  });
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: attachmentsKey(courseId) }),
    [queryClient, courseId],
  );

  const [defaultVisibility, setDefaultVisibility] =
    useState<AttachmentVisibility>("students");
  const queue = useAttachmentUploadQueue(courseId);
  const inputRef = useRef<HTMLInputElement>(null);

  // 上传成功 → 刷新那门课的列表（按条目的 courseId，哪怕完成的是别的课程的文件）；
  // 没有页签在听时完成的，挂载时补刷一次
  useEffect(() => {
    if (takeStaleAttachmentCourse(courseId)) void invalidate();
    return onAttachmentUploadCompleted((item) => {
      void queryClient.invalidateQueries({
        queryKey: attachmentsKey(item.courseId),
      });
    });
  }, [courseId, invalidate, queryClient]);

  const onFilesChosen = (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    enqueueAttachmentUploads(Array.from(files), courseId, defaultVisibility);
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="上传资料"
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            multiple
            className="sr-only"
            aria-label="选择要上传的资料文件"
            onChange={(event) => onFilesChosen(event.target.files)}
          />
          <Button
            className="min-h-11"
            onClick={() => inputRef.current?.click()}
          >
            <Upload aria-hidden />
            上传资料
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">新上传默认</span>
            <select
              className="min-h-11 rounded-lg border border-input bg-background px-3 text-sm"
              value={defaultVisibility}
              onChange={(event) =>
                setDefaultVisibility(event.target.value as AttachmentVisibility)
              }
            >
              <option value="students">{VISIBILITY_LABEL.students}</option>
              <option value="teacher_only">
                {VISIBILITY_LABEL.teacher_only}
              </option>
            </select>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          PDF / Word（.docx），单个 ≤ 20 MB，按文件内容识别格式；文件名像含答案
          （答案 / 解析 / 参考 / answer /
          key）的会先按「仅教师可见」上传，上传后可改。 学生能否下载 = 课程成员
          + 这里设为「学生可查看和下载」。
        </p>
        {queue.length > 0 && (
          <ul aria-label="上传队列" className="flex flex-col gap-2">
            {queue.map((item) => (
              <UploadRow
                key={item.key}
                item={item}
                onRetry={() => retryAttachmentUpload(item.key)}
                onRemove={() => removeAttachmentUpload(item.key)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="资料列表" className="flex flex-col gap-2">
        {listQuery.isPending && (
          <p className="text-sm text-muted-foreground">正在加载资料…</p>
        )}
        {listQuery.isError && (
          <div role="alert" className="flex items-center gap-2 text-sm">
            <span className="text-destructive">
              资料加载失败：
              {listQuery.error instanceof Error
                ? listQuery.error.message
                : "网络异常"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void listQuery.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {listQuery.data &&
          (listQuery.data.attachments.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              还没有资料。上传的 PDF / Word
              会列在这里，学生在课程页「资料」区下载。
            </p>
          ) : (
            <AttachmentList
              attachments={listQuery.data.attachments}
              onChanged={() => void invalidate()}
            />
          ))}
      </section>
    </div>
  );
}

function UploadRow({
  item,
  onRetry,
  onRemove,
}: {
  item: UploadItem;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const percent = Math.round(item.progress * 100);
  return (
    <li
      data-upload-status={item.status}
      className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <FileText
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-medium">{item.fileName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatAttachmentBytes(item.fileSize)}
          </span>
        </span>
        <span className="flex items-center gap-1">
          {item.status === "failed" && item.file !== null && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw aria-hidden className="size-3.5" />
              重试
            </Button>
          )}
          {item.status !== "uploading" && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`移除 ${item.fileName}`}
              onClick={onRemove}
            >
              <X aria-hidden className="size-4" />
            </Button>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={
            item.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {uploadStatusText(item)}
        </span>
        {item.answerLike && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            文件名像含答案，已按「仅教师可见」上传，可在列表里改
          </span>
        )}
      </div>
      {item.status === "uploading" && (
        <progress
          aria-label={`${item.fileName} 上传进度`}
          className="h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
          max={100}
          value={percent}
        />
      )}
    </li>
  );
}
