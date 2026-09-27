/**
 * 二进制文件直出辅助（T2.8 起）：笔迹 PNG 等文件接口不走 { ok, data } 统一壳
 * （那是 JSON 接口的约定），按静态产物直出（同 /api/public/spec 的处理思路）。
 *
 * 缓存口径：`private, max-age=60`——笔迹在草稿阶段会被幂等覆盖更新，短缓存
 * 兼顾体验与新鲜度；ETag 用 `<inkId>-<updatedAt>`（文件覆盖后 updatedAt 变化，
 * 客户端条件请求可拿到新内容）。
 *
 * bytes 用独立 ArrayBuffer（service 层已从 Node Buffer 拷贝）：
 * server 与 web 两侧 tsconfig 都会检查本文件，独立 ArrayBuffer 对
 * Response BodyInit 类型友好。
 */
export function pngResponse(bytes: ArrayBuffer, etag: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=60",
      etag,
    },
  });
}
