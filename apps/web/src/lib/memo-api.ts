import { defaultClientServices } from "@/portals/clients/default-services";

export * from "@/features/runtime/ports/memos-types";
export const listMemosApi = defaultClientServices.listMemosApi;
export const createTextMemoApi = defaultClientServices.createTextMemoApi;
export const deleteMemoApi = defaultClientServices.deleteMemoApi;
export const uploadMemoMediaApi = defaultClientServices.uploadMemoMediaApi;
