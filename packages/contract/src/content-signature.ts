/** 非加密内容签名：FNV-1a 32 位八轮；固定算法，浏览器与服务端共用。 */
export function stableContentHash64(value: unknown): string {
  const text = JSON.stringify(value);
  let out = "";
  for (let round = 0; round < 8; round += 1) {
    let hash = 0x811c9dc5 ^ (round * 0x9e3779b1);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}
