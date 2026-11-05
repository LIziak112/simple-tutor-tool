import {
  ANNOTATION_MAX_PIXEL_DIM,
  ANNOTATION_SURFACE_PIXEL_RATIO,
  type AttemptQuestionPublic,
} from "@tutor/contract";
import { analyzeSlots } from "@/features/answering/prepare-question";

// 开发页原型的内存快照；不进入持久化、接口或正式契约。
export interface FrozenQuestionManifest {
  readonly version: 0;
  readonly questionId: string;
  readonly questionRevisionId: string;
  readonly contentSignature: string;
  readonly slots: readonly {
    readonly key: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
}

export interface MaterialTile {
  readonly top: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/** 目标端只用公开题目结构核对键，不读取目标 DOM 的坐标。 */
export function frozenQuestionKeys(question: AttemptQuestionPublic): string[] {
  switch (question.type) {
    case "fill":
      return analyzeSlots(question.stemMd).map((slot) => `fill:${slot.slotId}`);
    case "choice":
      return (question.options ?? []).map((_, index) => `choice:${index}`);
    case "matching":
      return (question.matchingSlots ?? []).map(
        (slot) => `matching:${slot.id}`,
      );
    default:
      return [];
  }
}

export function validateFrozenQuestion(
  manifest: FrozenQuestionManifest,
  question: AttemptQuestionPublic,
  contentSignature: string,
): boolean {
  if (
    manifest.version !== 0 ||
    manifest.questionId !== question.id ||
    manifest.questionRevisionId !== question.questionRevisionId ||
    manifest.contentSignature !== contentSignature
  )
    return false;
  const expected = frozenQuestionKeys(question);
  return (
    manifest.slots.length === expected.length &&
    manifest.slots.every(
      (slot, index) =>
        slot.key === expected[index] &&
        [slot.x, slot.y, slot.width, slot.height].every(Number.isFinite) &&
        slot.x >= 0 &&
        slot.y >= 0 &&
        slot.width >= 44 &&
        slot.height >= 44,
    )
  );
}

/** 源 DOM 同一次稳定布局的控件框，和题面 PNG 共用 CSS 逻辑域。 */
export function captureQuestionSlots(
  question: AttemptQuestionPublic,
  surface: HTMLElement,
  contentSignature: string,
): FrozenQuestionManifest {
  const keys = frozenQuestionKeys(question);
  const root = surface.getBoundingClientRect();
  const controls: HTMLElement[] = [];
  if (question.type === "fill") {
    for (let index = 0; index < keys.length; index++) {
      const input = surface.querySelector<HTMLElement>(
        `input[data-testid="blank-${index + 1}"]`,
      );
      if (input === null) throw new Error("填空槽位与公开结构不符");
      controls.push(input);
    }
  } else if (question.type === "choice") {
    for (let index = 0; index < keys.length; index++) {
      const label = surface.querySelector<HTMLElement>(
        `label[data-lr-node="options/option/${index}"]`,
      );
      if (label === null) throw new Error("选项槽位与公开结构不符");
      controls.push(label);
    }
  } else if (question.type === "matching") {
    controls.push(...surface.querySelectorAll<HTMLElement>("select"));
  }
  const allControls = surface.querySelectorAll(
    "input, select, textarea, button",
  );
  if (allControls.length !== keys.length || controls.length !== keys.length)
    throw new Error("题面包含未知控件，不能绑定冻结表面");
  const slots = controls.map((element, index) => {
    const rect = element.getBoundingClientRect();
    return {
      key: keys[index] ?? "",
      x: rect.x - root.x,
      y: rect.y - root.y,
      width: rect.width,
      height: rect.height,
    };
  });
  const manifest: FrozenQuestionManifest = {
    version: 0,
    questionId: question.id,
    questionRevisionId: question.questionRevisionId,
    contentSignature,
    slots,
  };
  if (!validateFrozenQuestion(manifest, question, contentSignature))
    throw new Error("冻结控件框不完整，原稿仅可查看");
  return manifest;
}

/** 不构造整篇超高 canvas；片坐标是同一已排版材料内的连续 CSS 偏移。 */
export function materialTilePlan(
  cssWidth: number,
  cssHeight: number,
  pixelRatio: number = ANNOTATION_SURFACE_PIXEL_RATIO,
): MaterialTile[] {
  if (
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0 ||
    Math.floor(ANNOTATION_MAX_PIXEL_DIM / pixelRatio) < 1
  )
    throw new Error("材料像素比无效");
  if (
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    cssWidth * pixelRatio > ANNOTATION_MAX_PIXEL_DIM
  )
    throw new Error("材料宽度超出单片画布上限");
  if (!Number.isFinite(cssHeight) || cssHeight <= 0)
    throw new Error("材料高度无效");
  const tileHeight = Math.min(
    1600,
    Math.floor(ANNOTATION_MAX_PIXEL_DIM / pixelRatio),
  );
  const tiles: MaterialTile[] = [];
  for (let top = 0; top < cssHeight; top += tileHeight) {
    const height = Math.min(tileHeight, cssHeight - top);
    tiles.push({
      top,
      height,
      pixelWidth: Math.ceil(cssWidth * pixelRatio),
      pixelHeight: Math.ceil(height * pixelRatio),
    });
  }
  return tiles;
}

export function materialTileAt(
  tiles: readonly MaterialTile[],
  cssY: number,
): MaterialTile | null {
  return (
    tiles.find((tile) => cssY >= tile.top && cssY < tile.top + tile.height) ??
    null
  );
}
