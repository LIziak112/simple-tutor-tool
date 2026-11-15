import type {
  CourseProgressData,
  LectureMetaData,
  LectureMetaUpdate,
  LibraryBatchData,
  LibraryBatchRequest,
  LibraryFolder,
  LibraryFolderCreate,
  LibraryFolderReorder,
  LibraryFolderUpdate,
  LibraryLectureList,
  LibraryUnitList,
  LibraryUsage,
  UnitMetaData,
  UnitMetaUpdate,
} from "@tutor/contract";
import type { LibraryListParams } from "@/features/runtime/client-types";
import { callApi, throwShellError } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createLibraryClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const { api, fetch } = http;
  function fetchCourseProgressApi(
    courseId: string,
  ): Promise<CourseProgressData> {
    return callApi(() =>
      api.api.teacher.courses[":id"].progress.$get({ param: { id: courseId } }),
    );
  }
  function libraryListQuery(params: LibraryListParams): Record<string, string> {
    const query: Record<string, string> = {};
    if (params.folderId !== undefined) {
      query.folderId = params.folderId === null ? "none" : params.folderId;
    }
    if (params.q !== undefined && params.q.trim().length > 0) {
      query.q = params.q.trim();
    }
    if (params.deleted) {
      query.deleted = "1";
    }
    return query;
  }
  function fetchLibraryFolders(): Promise<{
    folders: LibraryFolder[];
  }> {
    return callApi(() => api.api.teacher.library.folders.$get());
  }
  function createLibraryFolderApi(
    request: LibraryFolderCreate,
  ): Promise<LibraryFolder> {
    return callApi(() =>
      api.api.teacher.library.folders.$post({ json: request }),
    );
  }
  function renameLibraryFolderApi(
    id: string,
    request: LibraryFolderUpdate,
  ): Promise<LibraryFolder> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.library.folders[":id"].$patch(args));
  }
  function deleteLibraryFolderApi(
    id: string,
  ): Promise<{ movedLectures: number; movedUnits: number }> {
    return callApi(() =>
      api.api.teacher.library.folders[":id"].$delete({ param: { id } }),
    );
  }
  function reorderLibraryFoldersApi(
    request: LibraryFolderReorder,
  ): Promise<null> {
    return callApi(() =>
      api.api.teacher.library.folders.reorder.$post({ json: request }),
    );
  }
  function fetchLibraryLectures(
    params: LibraryListParams = {},
  ): Promise<LibraryLectureList> {
    return callApi(() =>
      api.api.teacher.library.lectures.$get({
        query: libraryListQuery(params),
      }),
    );
  }
  function fetchLibraryUnits(
    params: LibraryListParams = {},
  ): Promise<LibraryUnitList> {
    return callApi(() =>
      api.api.teacher.library.units.$get({ query: libraryListQuery(params) }),
    );
  }
  function updateUnitMetaApi(
    id: string,
    request: UnitMetaUpdate,
  ): Promise<UnitMetaData> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.units[":id"].$patch(args));
  }
  function deleteUnitApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.units[":id"].$delete({ param: { id } }),
    );
  }
  function restoreUnitApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.units[":id"].restore.$post({ param: { id } }),
    );
  }
  function purgeUnitApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.units[":id"].purge.$delete({ param: { id } }),
    );
  }
  function updateLectureFolderApi(
    id: string,
    request: LectureMetaUpdate,
  ): Promise<LectureMetaData> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.teacher.lectures[":id"].$patch(args));
  }
  function restoreLectureApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.lectures[":id"].restore.$post({ param: { id } }),
    );
  }
  function purgeLectureApi(id: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.lectures[":id"].purge.$delete({ param: { id } }),
    );
  }
  function fetchUnitUsageApi(id: string): Promise<LibraryUsage> {
    return callApi(() =>
      api.api.teacher.units[":id"].usage.$get({ param: { id } }),
    );
  }
  function fetchLectureUsageApi(id: string): Promise<LibraryUsage> {
    return callApi(() =>
      api.api.teacher.lectures[":id"].usage.$get({ param: { id } }),
    );
  }
  function batchLibraryApi(
    request: LibraryBatchRequest,
  ): Promise<LibraryBatchData> {
    return callApi(() =>
      api.api.teacher.library.batch.$post({ json: request }),
    );
  }
  async function downloadExportMd(
    kind: "unit" | "lecture",
    id: string,
  ): Promise<void> {
    const path =
      kind === "unit"
        ? `/api/teacher/units/${encodeURIComponent(id)}/export.md`
        : `/api/teacher/lectures/${encodeURIComponent(id)}/export.md`;
    let res: Response;
    try {
      res = await fetch(path);
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      // 文件接口的错误仍是统一 JSON 壳
      await throwShellError(res);
    }
    deps().saveBlobAs(
      await res.blob(),
      deps().filenameFromDisposition(res, `${id}.md`),
    );
  }
  async function downloadTeachingPack(
    kind: "unit" | "lecture",
    id: string,
  ): Promise<void> {
    const path =
      kind === "unit"
        ? `/api/teacher/units/${encodeURIComponent(id)}/export-pack.zip`
        : `/api/teacher/lectures/${encodeURIComponent(id)}/export-pack.zip`;
    let res: Response;
    try {
      res = await fetch(path);
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      await throwShellError(res);
    }
    deps().saveBlobAs(
      await res.blob(),
      deps().filenameFromDisposition(res, `${id}.zip`),
    );
  }
  return {
    fetchCourseProgressApi,
    fetchLibraryFolders,
    createLibraryFolderApi,
    renameLibraryFolderApi,
    deleteLibraryFolderApi,
    reorderLibraryFoldersApi,
    fetchLibraryLectures,
    fetchLibraryUnits,
    updateUnitMetaApi,
    deleteUnitApi,
    restoreUnitApi,
    purgeUnitApi,
    updateLectureFolderApi,
    restoreLectureApi,
    purgeLectureApi,
    fetchUnitUsageApi,
    fetchLectureUsageApi,
    batchLibraryApi,
    downloadExportMd,
    downloadTeachingPack,
  };
}
