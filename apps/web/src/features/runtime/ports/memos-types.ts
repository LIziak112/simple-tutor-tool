export interface UploadMemoMediaOptions {
  onProgress?: ((ratio: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}
export class MemoNetworkError extends Error {
  constructor() {
    super("连不上服务器，这条随笔已存在本机，联网后会自动补传");
    this.name = "MemoNetworkError";
  }
}
