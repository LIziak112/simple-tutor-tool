import type { MediaUploadResult } from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createMediaClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { fetch } = http;
  function postTeacherMediaApi(file: File): Promise<MediaUploadResult> {
    const form = new FormData();
    form.append("file", file);
    return callApi(() =>
      fetch("/api/teacher/media", { method: "POST", body: form }),
    );
  }
  return { postTeacherMediaApi };
}
