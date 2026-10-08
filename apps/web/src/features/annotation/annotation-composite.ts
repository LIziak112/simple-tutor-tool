/**
 * 标注合成图导出（T6R.20，方案 §10）：底图 PNG ＋ 标注笔迹层合成单张 PNG。
 *
 * 实现：**canvas 直绘**（drawImage 底图 → replayAnnotationStroke 逐笔重放，
 * 与活编辑/草稿渲染同一绘制路径）——笔迹是 canvas 原生内容，不走 html-to-image
 * （方案 §10「合成图」对 foreignObject 保真性的保留意见在此直接绕开）。
 *
 * 底图缺失纪律：底图加载失败 → 显式「底图缺失」错误、拒绝合成（绝不导出
 * 孤立的圈——zip 装配侧同口径，见 review-pack-annotation 服务端测试）。
 * 依赖可注入（图片加载器/编码器）供 jsdom 测试。
 */

import type { AnnotationBaseRef, AnnotationDoc } from "@tutor/contract";
import type Atrament from "atrament";
import { createProgrammaticAtrament } from "@/features/ink/engine/atrament-adapter.ts";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png.ts";
import { replayAnnotationStroke } from "./annotation-surface";

/** 合成失败分类 */
export type AnnotationCompositeErrorKind =
  /** 底图加载失败（缺失/网络）——拒绝合成，不导出孤立的圈 */
  | "base-missing"
  /** 编码失败（空 Blob/非 PNG） */
  | "encode"
  /** 其他未分类失败 */
  | "internal";

export interface AnnotationCompositeError {
  readonly kind: AnnotationCompositeErrorKind;
  readonly message: string;
}

export type AnnotationCompositeResult =
  | { readonly ok: true; readonly blob: Blob }
  | { readonly ok: false; readonly error: AnnotationCompositeError };

/** 注入点（jsdom 测试用；生产缺省真实链路） */
export interface AnnotationCompositeDeps {
  /** 加载底图为 Image（缺省 new Image + decode/load） */
  readonly loadImage?: (url: string) => Promise<HTMLImageElement>;
  /** canvas → PNG Blob（缺省 canvasToPngBlob） */
  readonly encodePng?: (canvas: HTMLCanvasElement) => Promise<Blob>;
}

async function loadBaseImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const fail = (): void =>
      reject(new Error(`底图加载失败（${url}）——文件可能已缺失`));
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
  });
  return image;
}

/**
 * 合成导出（canvas 直绘）：
 * 画布 = 底图像素域（doc.baseWidth×baseHeight）→ drawImage 底图（整幅）→
 * 逐笔重放标注 → 单张 PNG。画布须参与布局（atrament 用 offsetWidth 换算：
 * 离屏宿主移出视口但保持真实 CSS 尺寸——cssPerBase=1 时坐标/线宽直落位图）。
 */
export async function exportAnnotationComposite(
  base: AnnotationBaseRef,
  doc: AnnotationDoc,
  deps: AnnotationCompositeDeps = {},
): Promise<AnnotationCompositeResult> {
  const url = base.downloadUrl;
  if (base.state !== "ready" || url === undefined || base.pixelWidth === null) {
    return {
      ok: false,
      error: {
        kind: "base-missing",
        message: "底图缺失或未就绪，无法导出合成图（不会只导出笔迹）",
      },
    };
  }
  let image: HTMLImageElement;
  try {
    image = await (deps.loadImage !== undefined
      ? deps.loadImage(url)
      : loadBaseImage(url));
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "base-missing",
        message: `底图缺失，无法合成：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const host = document.createElement("div");
  host.setAttribute("data-annotation-composite-host", "");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    zIndex: "-1",
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = doc.baseWidth;
    canvas.height = doc.baseHeight;
    // 参与布局（CSS 尺寸 = 位图尺寸 → atrament 的 offsetWidth 换算恒等）
    canvas.style.width = `${doc.baseWidth}px`;
    canvas.style.height = `${doc.baseHeight}px`;
    host.appendChild(canvas);
    document.body.appendChild(host);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return {
        ok: false,
        error: { kind: "internal", message: "无法创建画布上下文" },
      };
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, doc.baseWidth, doc.baseHeight);
    let atrament: Atrament | null = null;
    try {
      atrament = createProgrammaticAtrament(canvas);
      for (const stroke of doc.strokes) {
        replayAnnotationStroke(atrament, 1, stroke);
      }
    } finally {
      atrament?.destroy();
    }
    let blob: Blob;
    try {
      blob = await (deps.encodePng !== undefined
        ? deps.encodePng(canvas)
        : canvasToPngBlob(canvas));
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "encode",
          message: `合成图编码失败（${err instanceof Error ? err.message : String(err)}）`,
        },
      };
    }
    if (blob.size === 0) {
      return {
        ok: false,
        error: { kind: "encode", message: "合成图编码产出为空，已放弃" },
      };
    }
    // PNG 魔数校验已删（审查修复 10/Q-L3）：canvasToPngBlob 走原生
    // canvas.toBlob("image/png")，产物类型由浏览器保证；空 Blob 上面已拦
    return { ok: true, blob };
  } finally {
    host.remove();
  }
}

/** 合成图文件名（annotation-q<题号>-<phase>.png；题号由调用方给展示序号） */
export function annotationCompositeFilename(
  questionNo: number,
  phase: string,
): string {
  return `annotation-q${questionNo}-${phase}.png`;
}
