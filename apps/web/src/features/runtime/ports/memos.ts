import type {
  Memo,
  MemoCreateMedia,
  MemoCreateText,
  MemoListData,
  MemoListQuery,
} from "@tutor/contract";
import type { UploadMemoMediaOptions } from "./memos-types";
export interface MemosPorts {
  listMemosApi(query?: MemoListQuery): Promise<MemoListData>;
  createTextMemoApi(input: MemoCreateText, account: string): Promise<Memo>;
  deleteMemoApi(id: string): Promise<{
    id: string;
  }>;
  uploadMemoMediaApi(
    blob: Blob,
    fields: MemoCreateMedia,
    account: string,
    options?: UploadMemoMediaOptions,
  ): Promise<Memo>;
}
