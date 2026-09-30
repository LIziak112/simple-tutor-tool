/**
 * 二进制文件直出辅助（T2.8 起）：笔迹 PNG / gzip 矢量等文件接口不走
 * { ok, data } 统一壳（那是 JSON 接口的约定），按静态产物直出
 * （同 /api/public/spec 的处理思路）。
 *
 * 缓存口径：`private, max-age=60`——笔迹在草稿阶段会被幂等覆盖更新，短缓存
 * 兼顾体验与新鲜度；ETag 用 `<inkId>-<updatedAt>`（文件覆盖后 updatedAt 变化，
 * 客户端条件请求可拿到新内容）。
 *
 * bytes 用独立 ArrayBuffer（service 层已从 Node Buffer 拷贝）：
 * server 与 web 两侧 tsconfig 都会检查本文件，独立 ArrayBuffer 对
 * Response BodyInit 类型友好。
 */
export function binaryFileResponse(
  bytes: ArrayBuffer,
  contentType: string,
  etag: string,
): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=60",
      etag,
    },
  });
}

/** 笔迹快照 PNG 直出（T2.8） */
export function pngResponse(bytes: ArrayBuffer, etag: string): Response {
  return binaryFileResponse(bytes, "image/png", etag);
}

/**
 * 笔迹矢量文档 gzip 直出（T3.3，D12）：响应体即落盘的 .json.gz 原字节，
 * 前端用 DecompressionStream 解压——服务端不解不校验（原样回传，回放组件
 * 按 engine 分派时才消费结构）。
 */
export function gzipResponse(bytes: ArrayBuffer, etag: string): Response {
  return binaryFileResponse(bytes, "application/gzip", etag);
}
