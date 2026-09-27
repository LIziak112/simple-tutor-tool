/**
 * 二进制文件直出辅助（T2.8 起）：笔迹 PNG 等文件接口不走 { ok, data } 统一壳
 * （那是 JSON 接口的约定），按静态产物直出（同 /api/public/spec 的处理思路）。
 *
 * 缓存口径：`private, max-age=60`——笔迹在草稿阶段会被幂等覆盖更新，短缓存
 * 兼顾体验与新鲜度；ETag 用 `<inkId>-<updatedAt>`（文件覆盖后 updatedAt 变化，
 * 客户端条件请求可拿到新内容）。
 */
export function pngResponse(bytes: Uint8Array, etag: string): Response {
  // 用标准 Response 构造（BodyInit 原生接受 TypedArray），
  // 不经 c.body()——其重载类型对 Uint8Array<ArrayBufferLike> 不友好
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=60",
      etag,
    },
  });
}
