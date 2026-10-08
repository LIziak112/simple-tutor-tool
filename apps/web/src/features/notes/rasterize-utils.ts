import { getFontEmbedCSS } from "html-to-image";

/**
 * 栅格化共享原语（T6R.19 合成图 / T6R.20 标注底图共用；审查修复 6+7 抽出）：
 * 教师节哨兵、PNG 魔数校验、单步异步超时、图片预解码、整页空白采样——两条
 * 管线此前各持一份机械副本；字体嵌入 CSS 的模块级缓存（Q-H3：应用级静态
 * 资源、会话内不变，失败不缓存——下次生成重试）。
 */

/** 教师模板节哨兵（学生载荷守卫：题面混入教师域内容即拒绝生成） */
export const TEACHER_SECTION_MARKERS = [
  "**参考答案**",
  "**详解**",
  "**判定**",
  "**老师评语**",
  ":::solution",
  ":::answer",
] as const;

/** PNG 魔数（编码产物校验：空输出/非 PNG 拒绝落盘） */
export const PNG_MAGIC = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

/** 单步异步超时（iOS/旧 WebKit 的 decode()/canvas 挂起防线，超时转分类失败） */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 图片 URL 预解码（new Image + decode 优先；失败/不支持回退 onload） */
export async function preloadImages(urls: readonly string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          const image = new Image();
          const fail = (): void => reject(new Error(`图片加载失败：${url}`));
          if (typeof image.decode === "function") {
            image.src = url;
            image.decode().then(
              () => resolve(),
              () => fail(),
            );
          } else {
            image.onload = () => resolve();
            image.onerror = () => fail();
            image.src = url;
          }
        }),
    ),
  );
}

/** 采样判断 PNG 是否整页白色（透明像素不计；NaN 等异常值不算白） */
export function rgbaSampleAllBlank(data: Uint8ClampedArray): boolean {
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // 透明像素不计
    if (!(data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)) {
      return false;
    }
  }
  return true;
}

/**
 * 采样判断整页空白（「不下载空白 PNG 后显示成功」的产物侧防线）：整页绘制
 * 缩到 64×64 离屏小画布后**单次** getImageData 读回、内存里取样判断——
 * 逐像素 getImageData 是 4096 次同步 GPU 读回，在 iPad WebKit 会引发整机
 * 卡顿（T6R.19 审查修复轮 HIGH）。画布不可用时不误杀（返回非空白）。
 */
export async function samplePngBlank(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("空白校验图加载失败"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return false;
    ctx.drawImage(image, 0, 0, 64, 64);
    return rgbaSampleAllBlank(ctx.getImageData(0, 0, 64, 64).data);
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Blob 头 8 字节是否 PNG 魔数（<8 字节直接判否） */
export async function pngBlobHasMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return PNG_MAGIC.every((byte, i) => head[i] === byte);
}

// ---------- 字体嵌入缓存（审查修复 7 / Q-H3） ----------

/**
 * 字体嵌入 CSS 的模块级单例缓存（按宿主节点 WeakMap）：字体是应用级静态
 * 资源、会话内不变——getFontEmbedCSS 每次都要遍历样式表与 font-face 规则
 * （大应用数百毫秒），两次导出/两次底图生成重复收集纯浪费。**失败不缓存**
 * （rejected promise 即刻出表，下次生成重试）；已缓存的进行中请求并发共享。
 */
const fontEmbedCssByNode = new WeakMap<HTMLElement, Promise<string>>();

export function cachedFontEmbedCss(node: HTMLElement): Promise<string> {
  const cached = fontEmbedCssByNode.get(node);
  if (cached !== undefined) return cached;
  const pending = getFontEmbedCSS(node);
  fontEmbedCssByNode.set(node, pending);
  void pending.catch(() => {
    // 失败不缓存：下次生成重新收集
    fontEmbedCssByNode.delete(node);
  });
  return pending;
}
