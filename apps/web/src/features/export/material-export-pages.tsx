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

/**
 * 离屏挂载 markdown 片段并等待就绪（P3-6 形态 ②：挂载与栅格化分离——
 * 量高只挂载不栅格化，整篇超限材料不再先付一次注定失败的 toBlob）。
 * 返回就绪容器与卸载函数；字体/图片等待口径与题面底图同一稳定等待。
 */
async function mountMaterial(
  host: HTMLElement,
  contentMd: string,
): Promise<{ target: HTMLElement; unmount: () => void }> {
  const root = createRoot(host);
  const unmount = () => root.unmount();
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
    // 离屏宿主（fixed -10000px）内的懒加载图片（::image 缺省 loading=lazy）
    // 永远不会进入视口触发加载——decode() 会无限挂起（QM-19 e2e 实测）。
    // 显式切 eager 再等待，与题面底图 question-base-image 的导出副本同款口径。
    for (const image of images) image.loading = "eager";
    // 等全部图片进入终态（成功/失败）再统一判失败——刚切 eager 时 404 图片
    // 可能尚未置 complete，直接判 broken 会漏判继续挂起
    await withTimeout(
      Promise.all(
        images.map(
          (image) =>
            new Promise<void>((resolve) => {
              if (image.complete) return resolve();
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
      ),
      STEP_TIMEOUT_MS,
      "材料配图加载超时，请重试",
    );
    const broken = images.filter(
      (image) => image.complete && image.naturalWidth === 0,
    );
    if (broken.length > 0) {
      throw new Error("材料配图加载失败，请重试");
    }
    await withTimeout(
      Promise.all(images.map((image) => image.decode())),
      STEP_TIMEOUT_MS,
      "材料配图解码超时，请重试",
    );
    return { target, unmount };
  } catch (error) {
    unmount();
    throw error;
  }
}

/** 已挂载容器 → PNG（固定矢量管线，无活画布截图） */
async function rasterizeMaterial(
  target: HTMLElement,
  fontCss: string,
): Promise<Blob> {
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
}

/** 测量单块渲染高度（挂载读 offsetHeight，不栅格化——低成本量高） */
async function measureBlockHeight(
  host: HTMLElement,
  contentMd: string,
): Promise<number> {
  const { target, unmount } = await mountMaterial(host, contentMd);
  try {
    return pngHeightOf(target.getBoundingClientRect().height);
  } finally {
    unmount();
  }
}

/**
 * CSS 高度 → PNG 像素高度估计（html-to-image 缺省 pixelRatio =
 * devicePixelRatio，与栅格化实际缩放同口径；MATERIAL_PAGE_MAX_PIXELS 上限
 * 在 PNG 像素域，量高侧同域比较才有效）
 */
function pngHeightOf(cssHeight: number): number {
  return Math.ceil(cssHeight * (window.devicePixelRatio || 1));
}

/**
 * 空行分块（围栏感知，P3-6 形态 ①）：只在**未进入** ```/~~~ 围栏的空行处
 * 切开——含空行的围栏代码块/引用块（`>` 续行的空行不是空行）不被切成两个
 * 残块（残开栏会把后续正文吞进代码块）。纯函数，供分页与单测共用。
 */
export function splitMaterialBlocks(contentMd: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  /** 开栏围栏（```/~~~ 至少 3 个，记录字符与长度；闭栏需同字符且长度≥开栏） */
  let fence: { char: string; length: number } | null = null;
  const openFence = /^ {0,3}(`{3,}|~{3,})/;
  const closeFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  for (const line of contentMd.split("\n")) {
    if (fence !== null) {
      current.push(line);
      const close = closeFence.exec(line);
      if (
        close !== null &&
        close[1]?.[0] === fence.char &&
        (close[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const open = openFence.exec(line);
    if (open !== null) {
      const marker = open[1] ?? "";
      fence = { char: marker[0] ?? "`", length: marker.length };
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      // 只在已积累非空内容处切段（首尾/连续空行不产生空块）
      if (current.some((entry) => entry.trim() !== "")) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.some((entry) => entry.trim() !== "")) {
    blocks.push(current.join("\n"));
  }
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/** 材料分页计划：空行分块贪心装箱；单块超限也独立成页（栅格化时显式失败） */
function planMaterialBlocks(blocks: string[], heights: number[]): string[][] {
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
      // P3-6 形态 ②：先低成本量高（挂载读 getBoundingClientRect，不栅格化）
      // 再决定整篇/分块——此前「先整篇 toBlob 读 PNG 头」在 Safari canvas
      // 面积上限（≈1677 万 px²）附近 toBlob 恒 null（页高无上限的超长材料），
      // 报错重试永远失败；量高路径永不栅格化超限内容，页高上限内的单页
      // 复用同一挂载直接栅格化（常态材料仍只付一次 toBlob）。
      const mounted = await mountMaterial(host, material.contentMd);
      const fullHeight = pngHeightOf(
        mounted.target.getBoundingClientRect().height,
      );
      if (fullHeight <= MATERIAL_PAGE_MAX_PIXELS) {
        try {
          pages.push({
            blob: await rasterizeMaterial(mounted.target, fontCss),
            label: `材料 ${material.letter}：${material.label}`,
          });
        } finally {
          mounted.unmount();
        }
        continue;
      }
      mounted.unmount();
      // 长材料按块分页（细项 4：不静默裁切；分块围栏感知，含空行的代码块/
      // 引用块不被切断）
      const blocks = splitMaterialBlocks(material.contentMd);
      const heights: number[] = [];
      for (const block of blocks) {
        heights.push(await measureBlockHeight(host, block));
      }
      const planned = planMaterialBlocks(blocks, heights);
      for (const [pageIndex, pageBlocks] of planned.entries()) {
        const page = await mountMaterial(host, pageBlocks.join("\n\n"));
        try {
          pages.push({
            blob: await rasterizeMaterial(page.target, fontCss),
            label: `材料 ${material.letter}：${material.label} · 第 ${pageIndex + 1}/${planned.length} 页`,
          });
        } finally {
          page.unmount();
        }
      }
    }
    return pages;
  } finally {
    host.remove();
  }
}
