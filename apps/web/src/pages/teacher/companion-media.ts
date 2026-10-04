/**
 * 导入随行图片：纯函数三件套（提取 ::image 引用 → 与所选文件配对 → 改写 src）。
 *
 * 与服务端 extractMediaImageSrcs 的口径差异（有意为之，不抽共享包）：
 * - 服务端只认严格哈希形态（blobs/media/<64hex>.<ext>）——它核对的是「服务端
 *   已上传文件」的存在性，内容寻址名才有文件可寻；
 * - 前端配对面对的是「本地磁盘文件名」：AI 生成文档里的图片名是模型起的
 *   64 位十六进制标识，与内容真实 sha256 不一致，因此这里匹配**任意**
 *   ::image src 值（任意文件名字符），再交给配对规则决定上传哪张。
 *
 * 三条硬口径（技术架构 §5.2「导入与图片随行」）：
 * 1. 只上传被任一所选 md 引用到的图片（配对成功才算引用到），未引用文件
 *    不上传、不读取内容；
 * 2. 改写只动配对成功的 src 字符串值（::image{src="…"} 的引号内），
 *    md 其余内容逐字节不变；
 * 3. 配不上 / 冲突的引用一律不改写，原样进入预览，由服务端
 *    IMAGE_SRC_NOT_BLOBS / IMAGE_SRC_NOT_FOUND 警告兜底。
 */

/** 随行图片上传并发上限（克制并行度，见任务口径「如 3 并发」） */
export const MEDIA_UPLOAD_CONCURRENCY = 3;

/** 配对候选：所选图片文件的描述（不读内容——未引用的连字节都不碰） */
export interface CompanionCandidate {
  /** 相对路径（文件夹/拖拽选择含子目录前缀；多选为文件名；选择范围内唯一） */
  readonly path: string;
  /** basename（文件名，不含目录） */
  readonly name: string;
  /** 字节数（仅展示用；多候选同名时不作内容判等依据，见 pairImageRefs） */
  readonly size: number;
}

/** 配对结果（src 全部来自当前所选 md 的 ::image 引用，去重后） */
export interface ImagePairing {
  /** 配对成功：md 里的 src → 所选文件 path（该文件需要上传，多 src 可指向同一文件） */
  readonly pairs: ReadonlyMap<string, string>;
  /**
   * basename 冲突：同名候选文件有多个，无法确定配哪张 → 不配对、不改写。
   * 口径比「内容不同才冲突」收严：不读文件字节无法证明多份同名文件内容相同，
   * 宁可提示用户消除歧义，也不冒「静默传错图」的险。
   */
  readonly conflicts: ReadonlyArray<{
    readonly src: string;
    readonly name: string;
  }>;
  /** 未配对（无匹配文件 / 外链 URL）：不改写，交给预览警告兜底 */
  readonly unmatched: readonly string[];
}

/** 跨平台分隔符取 basename（md src 与 webkitRelativePath 均为 / 分隔，防御 \ ） */
export function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * 外链 / 内联数据 URI 判定：带 URL scheme（http:、https:、data: …）或协议相对
 * `//` 开头的 src 不可能与本地文件配对（DSL 本就只支持 blobs/ 路径，外链由
 * lint IMAGE_SRC_NOT_BLOBS 警告），直接归入未配对。
 */
export function isExternalSrc(src: string): boolean {
  // scheme 至少 2 字符（{2,}）：单字母 + 冒号是 Windows 盘符（C:\…），不是协议
  return /^[a-z][a-z0-9+.-]{1,}:/i.test(src) || src.startsWith("//");
}

/**
 * 从 md 文本提取 ::image 引用的 src（任意文件名形态，去重保序）。
 * 正则与指令语法同构：`::image{…src="值"…}`，属性行内（不跨行）、双引号值；
 * 与服务端 extractMediaImageSrcs 的差异见文件头注释。
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
  // Set 保插入序：同图多处引用只收集一次，顺序稳定可测
  return [...seen];
}

/**
 * 配对规则（顺序即优先级，见「导入与图片随行」约定）：
 * ① src 与所选文件相对路径完全一致 → 优先配对（唯一：path 在选择范围内唯一）；
 * ② 否则按 basename 全局唯一匹配（md 引用常不带目录前缀，或前缀与所选
 *    文件夹的根名不同——如 src 是 blobs/media/x.jpg，所选文件相对路径是
 *    资料夹/blobs/media/x.jpg，精确匹配不上但 basename 唯一）；
 * ③ basename 命中多个候选文件 → 冲突，不配对（见 ImagePairing.conflicts 注释）；
 * ④ 配不上的引用不改写，原样进预览由服务端警告兜底。
 * 外链 URL（isExternalSrc）直接归未配对，不参与匹配。
 */
export function pairImageRefs(
  refs: readonly string[],
  candidates: readonly CompanionCandidate[],
): ImagePairing {
  const byPath = new Map<string, CompanionCandidate>();
  const byName = new Map<string, CompanionCandidate[]>();
  for (const candidate of candidates) {
    // 同 path 重复由调用方 upsert 保证唯一；防御性以后到者为准
    byPath.set(candidate.path, candidate);
    const list = byName.get(candidate.name);
    if (list === undefined) {
      byName.set(candidate.name, [candidate]);
    } else {
      list.push(candidate);
    }
  }

  const pairs = new Map<string, string>();
  const conflicts: ImagePairing["conflicts"][number][] = [];
  const unmatched: string[] = [];
  for (const src of refs) {
    if (isExternalSrc(src)) {
      unmatched.push(src);
      continue;
    }
    // ① 相对路径完全一致
    const exact = byPath.get(src);
    if (exact !== undefined) {
      pairs.set(src, exact.path);
      continue;
    }
    // ② basename 唯一匹配；③ 多候选 → 冲突
    const sameName = byName.get(basenameOf(src)) ?? [];
    if (sameName.length === 1) {
      const only = sameName[0];
      if (only !== undefined) pairs.set(src, only.path);
      continue;
    }
    if (sameName.length >= 2) {
      conflicts.push({ src, name: basenameOf(src) });
      continue;
    }
    // ④ 无匹配
    unmatched.push(src);
  }
  return { pairs, conflicts, unmatched };
}

/**
 * 把 md 中配对成功并已上传的 ::image src 改写为服务端返回的真实路径。
 * 只替换匹配到的 src 属性值（引导的属性行保持原样、alt/width 等不受影响），
 * 其余内容逐字节不变；rewrites 里没有的 src 原样保留。
 * 例：::image{alt="图" src="blobs/media/本地名.jpg"} + (本地名.jpg → blobs/media/<sha>.jpg)
 *   → ::image{alt="图" src="blobs/media/<sha>.jpg"}
 */
export function rewriteImageSrcs(
  markdown: string,
  rewrites: ReadonlyMap<string, string>,
): string {
  if (rewrites.size === 0) return markdown;
  return markdown.replace(
    /::image\{([^}\n]*?)\bsrc="([^"\n}]+)"/g,
    (whole: string, lead: string, src: string): string => {
      const to = rewrites.get(src);
      // 函数式替换：返回串里的 $ 等字符按字面处理（服务端 src 不含，防御性）
      return to === undefined ? whole : `::image{${lead}src="${to}"`;
    },
  );
}
