import type {
  ContentTree,
  ImportBatchData,
  ImportCommitData,
  ImportCommitRequest,
  ImportPreviewBatchData,
  ImportPreviewBatchRequest,
  ImportPreviewData,
  ImportPreviewRequest,
  PublicConfigData,
  SpecFileName,
  TeacherInfo,
  TeacherLoginRequest,
  TeacherRegisterRequest,
  TeacherSetupRequest,
  TeacherStatusData,
} from "@tutor/contract";
import type { HealthData } from "@/features/runtime/client-types";
import { callApi, invalidApiResponse } from "@/lib/api-response";
import { saveBlobAs } from "@/lib/save-blob";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createGeneralClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  async function fetchHealth(): Promise<HealthData> {
    let res: Awaited<ReturnType<typeof api.api.public.health.$get>>;
    try {
      res = await api.api.public.health.$get();
    } catch {
      // 网络层失败（后端未启动、代理不可达等）
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (!res.ok) {
      throw invalidApiResponse(res.status);
    }
    const body = await res.json();
    return body.data;
  }

  function filenameFromDisposition(res: Response, fallback: string): string {
    const disposition = res.headers.get("content-disposition") ?? "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    if (star !== undefined) {
      // 坏 % 序列（非规范编码）解码会抛 URIError——回退 filename= 段，不让
      // 一个畸形头把整个下载变成裸异常（本 helper 被全部下载器共用）
      try {
        return decodeURIComponent(star);
      } catch {
        // 落到下方 filename= 解析
      }
    }
    // 负向断言排除 filename*= 形态（上面未命中才走到这里，防御同名段并存）
    const matched = /filename(?!\*)="?([^";]+)"?/i.exec(disposition)?.[1];
    return matched !== undefined && matched.length > 0 ? matched : fallback;
  }
  function fetchTeacherStatus(): Promise<TeacherStatusData> {
    return callApi(() => api.api.public.teacher.status.$get());
  }
  function fetchPublicConfig(): Promise<PublicConfigData> {
    return callApi(() => api.api.public.config.$get());
  }
  async function fetchSpecFile(file: SpecFileName): Promise<string> {
    let res: Response;
    try {
      res = await api.api.public.spec[":file"].$get({ param: { file } });
    } catch {
      throw new Error(
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      );
    }
    if (res.status === 404) {
      throw new Error("规范文档不存在（spec 文件缺失，请检查服务端部署）");
    }
    if (!res.ok) {
      throw invalidApiResponse(res.status);
    }
    return res.text();
  }
  function setupTeacher(request: TeacherSetupRequest): Promise<TeacherInfo> {
    return callApi(() => api.api.public.teacher.setup.$post({ json: request }));
  }
  function loginTeacher(
    request: TeacherLoginRequest,
  ): Promise<import("@tutor/contract").TeacherLoginData> {
    return callApi(() => api.api.public.teacher.login.$post({ json: request }));
  }
  function registerTeacher(
    request: TeacherRegisterRequest,
  ): Promise<TeacherInfo> {
    return callApi(() =>
      api.api.public.teacher.register.$post({ json: request }),
    );
  }
  function logoutTeacher(): Promise<null> {
    return callApi(() => api.api.teacher.logout.$post());
  }
  function fetchTeacherMe(): Promise<TeacherInfo> {
    return callApi(() => api.api.teacher.me.$get());
  }
  function fetchContentTree(): Promise<ContentTree> {
    return callApi(() => api.api.teacher.content.$get());
  }
  function previewImport(
    request: ImportPreviewRequest,
  ): Promise<ImportPreviewData> {
    return callApi(() =>
      api.api.teacher.import.preview.$post({ json: request }),
    );
  }
  function commitImport(
    request: ImportCommitRequest,
  ): Promise<ImportCommitData> {
    return callApi(() =>
      api.api.teacher.import.commit.$post({ json: request }),
    );
  }
  function previewImportBatch(
    request: ImportPreviewBatchRequest,
  ): Promise<ImportPreviewBatchData> {
    return callApi(() =>
      api.api.teacher.import["preview-batch"].$post({ json: request }),
    );
  }
  function fetchImportBatch(batchId: string): Promise<ImportBatchData> {
    return callApi(() =>
      api.api.teacher.import.batches[":batchId"].$get({ param: { batchId } }),
    );
  }
  return {
    fetchHealth,
    saveBlobAs,
    fetchTeacherStatus,
    fetchPublicConfig,
    fetchSpecFile,
    setupTeacher,
    loginTeacher,
    registerTeacher,
    logoutTeacher,
    fetchTeacherMe,
    fetchContentTree,
    previewImport,
    commitImport,
    previewImportBatch,
    fetchImportBatch,
    filenameFromDisposition,
  };
}
