import type { GzipJsonMessages } from "@/features/runtime/client-types";
import type { ApiServices } from "@/features/runtime/ports/api-services";
export interface ClientServices extends ApiServices {
  readMaterialWithDeadline<T>(
    read: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  fetchGzipJson(
    path: string,
    msg: GzipJsonMessages,
    signal?: AbortSignal,
  ): Promise<unknown>;
  filenameFromDisposition(res: Response, fallback: string): string;
}
