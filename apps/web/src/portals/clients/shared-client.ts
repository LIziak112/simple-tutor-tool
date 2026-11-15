import type {
  ImportCommitData,
  SharedFileList,
  SharedImportRequest,
  SharedPreviewData,
  SharedPreviewRequest,
  SharedPublishData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createSharedClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchSharedFiles(): Promise<SharedFileList> {
    return callApi(() => api.api.teacher.shared.$get());
  }
  function publishUnitToSharedApi(id: string): Promise<SharedPublishData> {
    return callApi(() =>
      api.api.teacher.library.units[":id"].publish.$post({ param: { id } }),
    );
  }
  function publishLectureToSharedApi(id: string): Promise<SharedPublishData> {
    return callApi(() =>
      api.api.teacher.library.lectures[":id"].publish.$post({ param: { id } }),
    );
  }
  function previewSharedFile(
    request: SharedPreviewRequest,
  ): Promise<SharedPreviewData> {
    return callApi(() =>
      api.api.teacher.shared.preview.$post({ json: request }),
    );
  }
  function importSharedFile(
    request: SharedImportRequest,
  ): Promise<ImportCommitData> {
    return callApi(() =>
      api.api.teacher.shared.import.$post({ json: request }),
    );
  }
  function deleteSharedFileApi(filename: string): Promise<null> {
    return callApi(() =>
      api.api.teacher.shared[":filename"].$delete({
        param: { filename },
      }),
    );
  }
  function fetchAdminSharedFiles(): Promise<SharedFileList> {
    return callApi(() => api.api.admin["shared-files"].$get());
  }
  function deleteAdminSharedFileApi(filename: string): Promise<null> {
    return callApi(() =>
      api.api.admin["shared-files"][":filename"].$delete({
        param: { filename },
      }),
    );
  }
  return {
    fetchSharedFiles,
    publishUnitToSharedApi,
    publishLectureToSharedApi,
    previewSharedFile,
    importSharedFile,
    deleteSharedFileApi,
    fetchAdminSharedFiles,
    deleteAdminSharedFileApi,
  };
}
