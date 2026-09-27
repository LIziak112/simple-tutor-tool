import { useQuery } from "@tanstack/react-query";
import {
  fetchLectureUsageApi,
  fetchLibraryFolders,
  fetchLibraryLectures,
  fetchLibraryUnits,
  fetchUnitUsageApi,
  type LibraryListParams,
} from "@/lib/api";

/**
 * 资源库页面的 TanStack Query 封装（T2A.2）：
 * - 文件夹列表（未删除资源计数）；
 * - 讲义库 / 题库 / 回收站列表（folderId/q/deleted 组成 query key，切换即重取）；
 * - 使用情况（删除确认弹层按需加载）。
 * 搜索以前端即时过滤为主（§4-3），q 不进 query key——只在文件夹切换时重取。
 */

export const libraryFoldersKey = ["teacher", "library", "folders"] as const;

/** 文件夹列表（含计数） */
export function useLibraryFolders() {
  return useQuery({
    queryKey: libraryFoldersKey,
    queryFn: fetchLibraryFolders,
  });
}

/** 列表 query key：kind + 文件夹 + 回收站开关（q 由前端过滤，不参与 key） */
export function libraryListKey(
  kind: "lectures" | "units",
  params: LibraryListParams,
) {
  return [
    "teacher",
    "library",
    kind,
    {
      folderId: params.folderId === undefined ? "all" : params.folderId,
      deleted: params.deleted === true,
    },
  ] as const;
}

/** 讲义库 / 回收站讲义列表 */
export function useLibraryLectures(params: LibraryListParams) {
  return useQuery({
    queryKey: libraryListKey("lectures", params),
    queryFn: () => fetchLibraryLectures(params),
  });
}

/** 题库 / 回收站单元列表 */
export function useLibraryUnits(params: LibraryListParams) {
  return useQuery({
    queryKey: libraryListKey("units", params),
    queryFn: () => fetchLibraryUnits(params),
  });
}

/** 使用情况（删除确认弹层按需加载） */
export function useResourceUsage(kind: "lecture" | "unit", id: string | null) {
  return useQuery({
    queryKey: ["teacher", "library", "usage", kind, id],
    queryFn: () =>
      kind === "unit"
        ? fetchUnitUsageApi(id as string)
        : fetchLectureUsageApi(id as string),
    enabled: id !== null,
    retry: false,
  });
}

/** 使资源库相关缓存全部失效（任何写操作后调用） */
export const libraryInvalidations = {
  folders: libraryFoldersKey,
  listsPrefix: ["teacher", "library"] as const,
};
