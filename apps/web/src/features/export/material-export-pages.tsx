import type {
  AttemptContextData,
  AttemptContextMaterial,
  MaterialRef,
} from "@tutor/contract";
import { lettersOf } from "@tutor/contract";
import { slotNumberedContentOf } from "@tutor/md-dsl";
import { toBlob } from "html-to-image";
import { createRoot } from "react-dom/client";
import {
  materialVersionKey,
  materialVersionNotesOf,
} from "@/features/attempt/MaterialPanel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import {
  collectFontEmbedCss,
  withTimeout,
} from "@/features/notes/rasterize-utils";

/**
 * 单题导出的材料页装配（QM-16 细项 1/4）：
 * - 闭包口径与服务端 frozenMaterialsForQuestion 同源——组材料 ∪ 题级
 *   materialRefs（学生题目投影携带），引用材料的全部版本（版本键不塌缩），
 *   (id, sourceVersion) 稳定排序（审查 P2-2/P3-2）；
 * - 正文槽位编号（{{slot-id}} → **（N）**，md-dsl 单源），多材料字母编号
 *   （材料 A/B…，与单题包 lettersOf 同口径）；
 * - 长材料按块分页（空行分段贪心装箱，页高上限内不静默裁切；超限块单独
 *   成页仍超限 → 显式失败「不整页截断」）；
 * - 渲染走导出副本（createRoot 离屏挂载 + html-to-image 固定栅格化），
 *   字体嵌入失败/栅格化失败显式抛错（AnnotationExportDialog 重试），
 *   不伪造图片。
 */

/** 材料页安全像素高度（canvas 4096 上限留余量；同 ANNOTATION_MAX_PIXEL_DIM 口径） */
const MATERIAL_PAGE_MAX_PIXELS = 3600;
const EXPORT_WIDTH = 720;
const STEP_TIMEOUT_MS = 15_000;

/** 导出材料条目（字母编号 + 版本徽标已并入 label） */
export interface ExportMaterial {
  /** 材料字母（A/B…，与单题包同一 lettersOf） */
  readonly letter: string;
  /** 展示标题（title + 版本徽标） */
  readonly label: string;
  /** 槽位编号后正文 */
  readonly contentMd: string;
}

/**
 * 该题的材料闭包（学生实际可见口径）：组引用 ∪ 题级 materialRefs（随学生
 * 题目投影下发，2026-10-25 审查 P2-2）→ 引用材料的全部版本（版本键不
 * 塌缩）。排序 (id, sourceVersion) 稳定——与服务端 frozenMaterialsForQuestion
 * 闭包单源同口径（审查 P3-2），两出口（PNG 材料页 / 单题包）字母编号一致。
 */
export function exportMaterialsOfQuestion(
  context: AttemptContextData,
  questionId: string,
  questionMaterialRefs?: readonly MaterialRef[],
): ExportMaterial[] {
  const materialsById = new Map<string, AttemptContextMaterial[]>();
  for (const material of context.materials) {
    const list = materialsById.get(material.id) ?? [];
    list.push(material);
    materialsById.set(material.id, list);
  }
  const notes = materialVersionNotesOf(context.materials);
  // 引用集：组材料（组快照 questionIds 含该题）∪ 题级引用，按材料 id 去重
  const wantedIds = new Set<string>();
  for (const group of context.groups) {
    if (!group.questionIds.includes(questionId)) continue;
    for (const ref of group.materialRefs) wantedIds.add(ref.material);
  }
  for (const ref of questionMaterialRefs ?? []) wantedIds.add(ref.material);
  const collected: (ExportMaterial & {
    id: string;
    sourceVersion: number;
  })[] = [];
  for (const id of wantedIds) {
    for (const material of [...(materialsById.get(id) ?? [])].sort(
      (a, b) => a.sourceVersion - b.sourceVersion,
    )) {
      const versionNote = notes.get(materialVersionKey(material));
      collected.push({
        id: material.id,
        sourceVersion: material.sourceVersion,
        letter: "",
        label: `${material.title?.trim() || "材料"}${versionNote === undefined ? "" : `（${versionNote}）`}`,
        contentMd: slotNumberedContentOf(material.contentMd, material.slots),
      });
    }
  }
  collected.sort(
    (a, b) => a.id.localeCompare(b.id) || a.sourceVersion - b.sourceVersion,
  );
  // 排序键（id/sourceVersion）只在闭包内部使用，不进导出条目
  return collected.map((material, index) => ({
    letter: lettersOf(index),
    label: material.label,
    contentMd: material.contentMd,
  }));
}

/** 离屏渲染 markdown 片段并栅格化为 PNG（固定矢量管线，无活画布截图） */
async function renderMarkdownPng(
  host: HTMLElement,
  contentMd: string,
  fontCss: string,
): Promise<Blob> {
  const root = createRoot(host);
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        root.render(
          <div
            ref={(node) => {
              if (node) resolve();
            }}
            className="material-reading"
            style={{
              width: `${EXPORT_WIDTH}px`,
              padding: "24px",
              backgroundColor: "#ffffff",
              color: "#0f172a",
            }}
          >
            <RichMarkdown source={contentMd} />
          </div>,
        );
      }),
      STEP_TIMEOUT_MS,
      "材料渲染挂载超时",
    );
    const target = host.firstElementChild;
    if (!(target instanceof HTMLElement)) {
      throw new Error("材料渲染未挂载，请重试");
    }
    // 图片与公式就绪（与题面底图同一稳定等待口径；失败抛可读错误）
    if (document.fonts) await document.fonts.ready;
    const images = [...target.querySelectorAll<HTMLImageElement>("img")];
    const broken = images.filter(
      (image) => image.complete && image.naturalWidth === 0,
    );
    if (broken.length > 0) {
      throw new Error("材料配图加载失败，请重试");
    }
    await Promise.all(images.map((image) => image.decode()));
    const blob = await withTimeout(
      toBlob(target, {
        backgroundColor: "#ffffff",
        fontEmbedCSS: fontCss,
      }),
      STEP_TIMEOUT_MS,
      "材料栅格化超时",
    );
    if (blob === null) throw new Error("材料图片编码失败，请重试");
    return blob;
  } finally {
    root.unmount();
  }
}

/** 测量单块渲染高度（复用同一 host；渲染失败按超限处理交由上层报错） */
async function measureBlockHeight(
  host: HTMLElement,
  contentMd: string,
  fontCss: string,
): Promise<number> {
  const blob = await renderMarkdownPng(host, contentMd, fontCss);
  // PNG IHGR 高度读取（24 偏移，与题面底图同款校验口径）
  const header = new DataView(await blob.slice(0, 24).arrayBuffer());
  return header.byteLength >= 24 ? header.getUint32(20) : 0;
}

/** 材料分页计划：空行分块贪心装箱；单块超限也独立成页（栅格化时显式失败） */
function planMaterialBlocks(contentMd: string, heights: number[]): string[][] {
  const blocks =
    contentMd
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0) ?? [];
  if (blocks.length !== heights.length) {
    throw new Error("材料分块与测量不一致，请重试");
  }
  const pages: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const [index, block] of blocks.entries()) {
    const height = heights[index] ?? 0;
    if (current.length > 0 && used + height > MATERIAL_PAGE_MAX_PIXELS) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(block);
    used += height;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

export interface MaterialExportPage {
  readonly blob: Blob;
  /** 页标签（材料 A · 第 1/2 页）；单页材料不带页序 */
  readonly label: string;
}

/** 材料页装配入口：失败显式抛错（可重试），永不静默省略材料 */
export async function renderMaterialExportPages(
  materials: readonly ExportMaterial[],
): Promise<MaterialExportPage[]> {
  if (materials.length === 0) return [];
  const host = document.createElement("div");
  host.dataset.slot = "material-export-host";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    backgroundColor: "#ffffff",
  });
  document.body.appendChild(host);
  try {
    const fontCss = await withTimeout(
      collectFontEmbedCss(host),
      STEP_TIMEOUT_MS,
      "本地字体嵌入超时",
    );
    const pages: MaterialExportPage[] = [];
    for (const material of materials) {
      // 先整篇渲染：页高内直接单页（材料常态），超限再分块装箱
      const fullBlob = await renderMarkdownPng(
        host,
        material.contentMd,
        fontCss,
      );
      const fullHeader = new DataView(
        await fullBlob.slice(0, 24).arrayBuffer(),
      );
      const fullHeight =
        fullHeader.byteLength >= 24 ? fullHeader.getUint32(20) : 0;
      if (fullHeight <= MATERIAL_PAGE_MAX_PIXELS) {
        pages.push({
          blob: fullBlob,
          label: `材料 ${material.letter}：${material.label}`,
        });
        continue;
      }
      // 长材料按块分页（细项 4：不静默裁切）
      const blocks =
        material.contentMd
          .split(/\n\s*\n/)
          .map((block) => block.trim())
          .filter((block) => block.length > 0) ?? [];
      const heights: number[] = [];
      for (const block of blocks) {
        heights.push(await measureBlockHeight(host, block, fontCss));
      }
      const planned = planMaterialBlocks(material.contentMd, heights);
      for (const [pageIndex, pageBlocks] of planned.entries()) {
        const blob = await renderMarkdownPng(
          host,
          pageBlocks.join("\n\n"),
          fontCss,
        );
        pages.push({
          blob,
          label: `材料 ${material.letter}：${material.label} · 第 ${pageIndex + 1}/${planned.length} 页`,
        });
      }
    }
    return pages;
  } finally {
    host.remove();
  }
}
