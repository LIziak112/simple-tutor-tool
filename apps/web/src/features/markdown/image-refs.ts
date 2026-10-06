/**
 * ::image 引用提取（**任意文件名形态**，去重保序）——markdown 域共享位
 * （T6R.12 复审 B4：自 pages/teacher/companion-media 迁出，导入随行配对与
 * 静态素材导出共用，消 features→pages 反向依赖）。
 *
 * 与服务端 extractMediaImageSrcs 的口径差异（有意为之，不抽共享包）：
 * - 服务端只认严格哈希形态（blobs/media/<64hex>.<ext>）——它核对的是「服务端
 *   已上传文件」的存在性，内容寻址名才有文件可寻；
 * - 前端面对的是「本地磁盘文件名 / 待下载素材」：AI 生成文档里的图片名是
 *   模型起的 64 位十六进制标识，与内容真实 sha256 不一致，因此这里匹配
 *   **任意** ::image src 值（任意文件名字符），再由配对/下载规则决定用途。
 *
 * 正则与指令语法同构：`::image{…src="值"…}`，属性行内（不跨行）、双引号值。
 */
export function extractImageRefs(markdowns: readonly string[]): string[] {
  // 字面量求值即新对象（同服务端口径：避免共享 /g 实例跨调用串 lastIndex）
  const pattern = /::image\{[^}\n]*?\bsrc="([^"\n}]+)"/g;
  const seen = new Set<string>();
  for (const md of markdowns) {
    for (const match of md.matchAll(pattern)) {
      const src = match[1];
      if (src !== undefined) seen.add(src);
    }
  }
  // Set 保插入序：同图多处引用只收集一份，顺序稳定可测
  return [...seen];
}
