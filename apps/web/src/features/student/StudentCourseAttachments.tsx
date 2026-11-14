import { useQuery } from "@tanstack/react-query";
import {
  ATTACHMENT_FORMAT_LABEL,
  attachmentFileUrl,
  formatAttachmentBytes,
} from "@tutor/contract";
import { Download, Paperclip } from "lucide-react";
import { usePortalClients } from "@/features/runtime/portal-runtime";

import { formatCnTime } from "@/lib/time";

/**
 * 学生课程页「资料」区（模块 6 第一步）：老师设为「学生可查看和下载」的 PDF / Word
 * 原件，点击即由浏览器下载（Content-Disposition，服务端按课程成员资格判权）。
 * 没有资料时整块不渲染；加载失败只给一行可重试的提示，不影响目录。
 */
export const studentCourseAttachmentsKey = (courseId: string) =>
  ["student", "course-attachments", courseId] as const;

export function StudentCourseAttachments({ courseId }: { courseId: string }) {
  const { listStudentCourseAttachmentsApi } = usePortalClients();

  const query = useQuery({
    queryKey: studentCourseAttachmentsKey(courseId),
    queryFn: () => listStudentCourseAttachmentsApi(courseId),
    enabled: courseId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  if (query.isError) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        课程资料暂时加载不出来，
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={() => void query.refetch()}
        >
          重试
        </button>
      </p>
    );
  }
  if (query.data === undefined || query.data.attachments.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="课程资料"
      data-testid="student-course-attachments"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Paperclip aria-hidden className="size-4 text-primary" />
        资料（{query.data.attachments.length}）
      </h2>
      <ul className="flex flex-col gap-1.5">
        {query.data.attachments.map((item) => (
          <li key={item.id}>
            <a
              href={attachmentFileUrl("student", item.id)}
              download={item.fileName}
              className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                {ATTACHMENT_FORMAT_LABEL[item.format]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {item.fileName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatAttachmentBytes(item.bytes)}
                  {item.pageCount !== null && ` · ${item.pageCount} 页`}
                  {` · ${formatCnTime(item.createdAt)}`}
                </span>
              </span>
              <Download
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
