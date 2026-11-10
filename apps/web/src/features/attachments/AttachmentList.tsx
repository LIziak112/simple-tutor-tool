import { useMutation } from "@tanstack/react-query";
import type { Attachment, AttachmentVisibility } from "@tutor/contract";
import {
  ATTACHMENT_FORMAT_LABEL,
  attachmentFileUrl,
  formatAttachmentBytes,
} from "@tutor/contract";
import { Download, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteAttachmentApi, updateAttachmentApi } from "@/lib/attachment-api";
import { formatCnTime } from "@/lib/time";

/**
 * 课程资料列表（模块 6 第一步，CourseAttachmentsTab 的列表段）：格式徽标 / 文件名 /
 * 大小 / 页数（已知时）/ 上传时间；可见性开关（学生可查看和下载 ⇄ 仅教师可见）、
 * 下载（直出地址）、删除（Dialog 确认，软删）。改动后由宿主刷新查询。
 */
export const VISIBILITY_LABEL: Record<AttachmentVisibility, string> = {
  students: "学生可查看和下载",
  teacher_only: "仅教师可见",
};

export function AttachmentList({
  attachments,
  onChanged,
}: {
  attachments: readonly Attachment[];
  onChanged: () => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const toggle = useMutation({
    mutationFn: (item: Attachment) =>
      updateAttachmentApi(item.id, {
        visibility:
          item.visibility === "students" ? "teacher_only" : "students",
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAttachmentApi(id),
    onSuccess: () => {
      setPendingDelete(null);
      onChanged();
    },
  });
  return (
    <>
      <ul className="flex flex-col gap-2">
        {attachments.map((item) => (
          <li
            key={item.id}
            data-attachment-id={item.id}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                  {ATTACHMENT_FORMAT_LABEL[item.format]}
                </span>
                <span className="truncate font-medium">{item.fileName}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {formatAttachmentBytes(item.bytes)}
                {item.pageCount !== null && ` · ${item.pageCount} 页`}
                {` · ${formatCnTime(item.createdAt)}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-9"
                aria-pressed={item.visibility === "students"}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(item)}
                title="点击切换可见性"
              >
                {item.visibility === "students" ? (
                  <Eye aria-hidden className="size-3.5" />
                ) : (
                  <EyeOff aria-hidden className="size-3.5" />
                )}
                {VISIBILITY_LABEL[item.visibility]}
              </Button>
              <Button variant="outline" size="sm" className="min-h-9" asChild>
                <a
                  href={attachmentFileUrl("teacher", item.id)}
                  download={item.fileName}
                >
                  <Download aria-hidden className="size-3.5" />
                  下载
                </a>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-9 text-destructive hover:text-destructive"
                aria-label={`删除 ${item.fileName}`}
                onClick={() => setPendingDelete(item)}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {toggle.isError && (
        <p role="alert" className="text-xs text-destructive">
          可见性修改失败：
          {toggle.error instanceof Error ? toggle.error.message : "网络异常"}
        </p>
      )}
      {pendingDelete !== null && (
        <Dialog
          open
          onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>删除资料</DialogTitle>
              <DialogDescription>
                「{pendingDelete.fileName}」将从本课程移除，学生立即无法下载。
              </DialogDescription>
            </DialogHeader>
            {remove.isError && (
              <p role="alert" className="text-sm text-destructive">
                {remove.error instanceof Error
                  ? remove.error.message
                  : "删除失败，请重试"}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                className="min-h-11"
                disabled={remove.isPending}
                onClick={() => remove.mutate(pendingDelete.id)}
              >
                {remove.isPending && (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                )}
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
