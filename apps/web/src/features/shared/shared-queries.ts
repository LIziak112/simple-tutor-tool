import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SharedFileSummary } from "@tutor/contract";
import {
  deleteSharedFileApi,
  fetchSharedFiles,
  importSharedFile,
  previewSharedFile,
  publishLectureToSharedApi,
  publishUnitToSharedApi,
  type SharedImportRequest,
} from "@/lib/api";

/**
 * 共享页的 TanStack Query 封装（T2B.7，D15–D18）：
 * - 列表：目录快照（发布/删除后失效）；
 * - 预览：按 filename + folderId 组 key（切目标文件夹即重算动作清单，D17）；
 * - 导入：写操作，成功后失效共享列表与资源库/内容树缓存；
 * - 删除：canDelete 为真的行才可发起（服务端再校验 D18，403 由页面分支提示）。
 */

/** 共享列表 key（发布/删除/导入成功后失效） */
export const sharedListKey = ["teacher", "shared"] as const;

/** 共享列表（D15 规模防线字段随响应返回，页面据此提示） */
export function useSharedFiles() {
  return useQuery({
    queryKey: sharedListKey,
    queryFn: fetchSharedFiles,
  });
}

/** 单文件预览 key（folderId 参与：目标文件夹变化重算动作清单） */
export function sharedPreviewKey(filename: string, folderId: string | null) {
  return ["teacher", "shared", "preview", filename, folderId] as const;
}

/** 共享文件预览（动作清单按本人域计算，D17）；retry false——404 提示后不自动重试 */
export function useSharedPreview(
  filename: string | null,
  folderId: string | null,
) {
  return useQuery({
    queryKey: sharedPreviewKey(filename ?? "", folderId),
    queryFn: () =>
      previewSharedFile({ filename: filename as string, folderId }),
    enabled: filename !== null,
    retry: false,
  });
}

/** 导入成功后失效共享页 + 资源库 + 内容树缓存 */
function useInvalidateAfterImport() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: sharedListKey });
    void queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
    void queryClient.invalidateQueries({ queryKey: ["teacher", "content"] });
  };
}

/** 导入共享文件进本人资源库（D17；422 LINT_ERROR 由抽屉分支展示） */
export function useImportSharedFile() {
  const invalidate = useInvalidateAfterImport();
  return useMutation({
    mutationFn: (request: SharedImportRequest) => importSharedFile(request),
    onSuccess: invalidate,
  });
}

/** 删除共享文件（D18：服务端校验发布者；403 FORBIDDEN_SHARED_FILE 由页面提示） */
export function useDeleteSharedFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: SharedFileSummary) => deleteSharedFileApi(file.filename),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharedListKey });
    },
  });
}

/** 发布单元到共享（确认弹层后调用；响应 filename 用于成功提示） */
export function usePublishUnitToShared() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishUnitToSharedApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharedListKey });
    },
  });
}

/** 发布讲义到共享 */
export function usePublishLectureToShared() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishLectureToSharedApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sharedListKey });
    },
  });
}
