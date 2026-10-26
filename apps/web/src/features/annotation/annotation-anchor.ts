import type {
  AnnotationSurfaceCompatibility,
  InkStroke,
} from "@tutor/contract";

/**
 * 圈画收笔锚定（LR-6，学习记录模型设计稿 §5.3）：纯几何计算，不碰 DOM、
 * 可脱离浏览器单测。收笔时对带键块（layout.compatibility.blocks[].node
 * 非空）按**重叠面积**取最大者为锚；全不相交取块心最近者；没有带键块
 * （旧布局）则不锚（调用方省略该笔的 anchors 键，anchoredRatio 如实降低）。
 */

/** 笔画包围盒（所在文档坐标域：圈画为底图像素） */
export interface StrokeBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type KeyedBlock = AnnotationSurfaceCompatibility["blocks"][number];

/** 笔画包围盒；空笔画（无点）返回 null（不锚） */
export function strokeBbox(stroke: InkStroke): StrokeBbox | null {
  if (stroke.points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of stroke.points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 矩形与包围盒的重叠面积（0 = 不相交） */
function overlapArea(bbox: StrokeBbox, block: KeyedBlock): number {
  const width =
    Math.min(bbox.maxX, block.x + block.width) - Math.max(bbox.minX, block.x);
  const height =
    Math.min(bbox.maxY, block.y + block.height) - Math.max(bbox.minY, block.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/** 包围盒中心到块中心的距离平方（无相交时的「最近块」度量） */
function centerDistanceSq(bbox: StrokeBbox, block: KeyedBlock): number {
  const bx = (bbox.minX + bbox.maxX) / 2;
  const by = (bbox.minY + bbox.maxY) / 2;
  const cx = block.x + block.width / 2;
  const cy = block.y + block.height / 2;
  return (bx - cx) ** 2 + (by - cy) ** 2;
}

/**
 * 笔画的锚节点键：带键块中按重叠面积最大者；全不相交取块心最近者；
 * 没有带键块时 undefined（旧布局不锚，不伪造——P1/§10-5）。
 */
export function anchorKeyForStroke(
  bbox: StrokeBbox,
  blocks: readonly KeyedBlock[],
): string | undefined {
  const keyed = blocks.filter((block) => block.node !== undefined);
  if (keyed.length === 0) return undefined;
  let best = keyed[0];
  let bestArea = -1;
  for (const block of keyed) {
    const area = overlapArea(bbox, block);
    if (area > bestArea) {
      best = block;
      bestArea = area;
    }
  }
  if (bestArea > 0) {
    const bestNode = best?.node;
    if (bestNode !== undefined) return bestNode;
  }
  // 全不相交：取块心最近（平局取先出现者，保持确定性）
  let nearest = keyed[0];
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const block of keyed) {
    const dist = centerDistanceSq(bbox, block);
    if (dist < nearestDist) {
      nearest = block;
      nearestDist = dist;
    }
  }
  return nearest?.node;
}
