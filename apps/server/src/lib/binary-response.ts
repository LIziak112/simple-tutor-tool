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

/**
 * 笔记版本文档/派生图直出（T6R.5）：Cache-Control: no-store——这些字节按
 * 归属链授权下发（versionId/imageId 是账号私有数据），共享设备上切换账号后
 * 浏览器缓存不得回放另一账号仍可见的内容（版本内容虽不可变，但「授权」会
 * 随账号变化，immutable/短缓存两个前提都不成立；与 ink 的 private,max-age=60
 * 和 /blobs/media 的内容寻址长缓存是三种不同口径）。no-store 下不会有条件
 * 请求，ETag 无意义不设。
 *
 * bytes 兼容 Uint8Array<ArrayBuffer>（T6R.13 起 zip 文件直出共用：导出/
 * 备份/单题包的下载内容随批改与图片状态变化，同样禁缓存；Response BodyInit
 * 对独立 ArrayBuffer 底座的 Uint8Array 直接接受）。
 */
export function noStoreBinaryResponse(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
  contentType: string,
  options: {
    /**
     * 附件下载语义：给定时设置 content-disposition: attachment，经
     * attachmentDisposition 编码（可含中文；undici 的 Response 头不接受非
     * ASCII 字节，直接放中文文件名会抛错——纯 ASCII 名只多一段无害的
     * filename* 参数，T6R.13 起 ASCII 调用点与 T7.8 中文包名共用同一口径）
     */
    attachmentFilename?: string;
  } = {},
): Response {
  return new Response(bytes, {
    status: 200,
    headers: noStoreAttachmentHeaders(contentType, options.attachmentFilename),
  });
}

/**
 * no-store 附件三件套响应头（T6R.13 收敛）：bytes 直出（上函数）与流式
 * 直出（备份下载的 Readable.toWeb 形态）共用同一套头，不再各自手抄三行。
 */
export function noStoreAttachmentHeaders(
  contentType: string,
  attachmentFilename?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "no-store",
  };
  if (attachmentFilename !== undefined) {
    headers["content-disposition"] = attachmentDisposition(attachmentFilename);
  }
  return headers;
}

/**
 * RFC 6266/5987 附件文件名头值：filename=ASCII 兜底 + filename*=UTF-8''编码
 * （支持中文附件名；ASCII 兜底给不支持 filename* 的旧客户端）。
 */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  const fallback = ascii.length > 0 ? ascii : "export";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 剥离路径段末尾的 .png 后缀（T6R.5 复审⑦收敛）：ink 与 note 图片路由的
 * 「.png 可选后缀、同一资源双 URL 形态」分流惯例共用。questionId/imageId
 * 本身可能含点（来自 DSL/uuid），只剥末尾固定后缀。
 */
export function stripPngSuffix(raw: string): string {
  return raw.endsWith(".png") ? raw.slice(0, -".png".length) : raw;
}
