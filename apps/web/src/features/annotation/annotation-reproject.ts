import type {
  AnnotationDoc,
  AnnotationSurfaceLayout,
  InkDeletedStroke,
  InkStroke,
} from "@tutor/contract";

/**
 * 圈画重投影（LR-6，学习记录模型设计稿 §5.3）：纯几何函数，不碰 DOM、可
 * 完整单测。权威坐标 = 节点相对坐标（文档恒存底图像素坐标 + 锚键 + 块矩形，
 * 与节点相对坐标**无损互转**——不升文档版本即拿到与渲染无关的坐标框）。
 *
 * - `reprojectAnnotation`：把保存底图坐标域的文档投影到目标布局（换设备/
 *   换窗口阅读与续画）。锚块两侧都在 → 按块矩形平移+等比缩放（纵横比以宽
 *   为基准，u、v 都除以块宽）；锚缺失（无锚旧稿 / 锚块在任一侧不存在）→
 *   按 root 整体等比缩放并计入 unanchored、整批标 approximate；
 * - `inverseReproject`：在目标布局上新画的笔画映射回保存底图坐标域（存盘
 *   用；文档坐标域恒为底图，不因近似模式改变）。
 */

/** 重投影结果：目标布局坐标域的笔画/墓碑 + 如实标记 */
export interface ReprojectedAnnotation {
  strokes: InkStroke[];
  deleted: InkDeletedStroke[];
  /** 含任一 root 兜底缩放的笔画时为 true（UI 标「已按内容对齐」） */
  approximate: boolean;
  /** 走 root 兜底缩放的笔画数（锚缺失如实计数） */
  unanchored: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 布局证据里的块矩形表（node 键 → 矩形；无 node 的块不入表） */
function keyedBlocksOf(layout: AnnotationSurfaceLayout): Map<string, Rect> {
  const map = new Map<string, Rect>();
  for (const block of layout.compatibility?.blocks ?? []) {
    if (block.node !== undefined && map.has(block.node) === false) {
      map.set(block.node, {
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
      });
    }
  }
  return map;
}

/** 保存侧的整域矩形（root 兜底缩放的源域；来自文档自身几何） */
function docDomainOf(doc: AnnotationDoc): Rect {
  return { x: 0, y: 0, width: doc.baseWidth, height: doc.baseHeight };
}

/** 目标布局的整域矩形（root 兜底缩放的宿主域；CSS × 像素比 = 底图像素） */
function targetDomainOf(layout: AnnotationSurfaceLayout): Rect {
  return {
    x: 0,
    y: 0,
    width: Math.ceil(layout.cssWidth * layout.pixelRatio),
    height: Math.ceil(layout.cssHeight * layout.pixelRatio),
  };
}

/** 点经块矩形映射：u、v 都除以源块宽、都乘目标块宽（设计稿 §5.3「都除以宽，
 * 保纵横比」——x/y 同一比例，几何不变形；纵向落点随锚块重对齐；root 兜底同口径） */
function mapPoint(
  px: number,
  py: number,
  from: Rect,
  to: Rect,
): { x: number; y: number } {
  const u = (px - from.x) / from.width;
  const v = (py - from.y) / from.width;
  return { x: to.x + u * to.width, y: to.y + v * to.width };
}

/** 单笔几何重投影（tool/color/rendering/id/startedAt/pointer/deletedAt/deletedBy
 * 等字段经泛型原样保留；weight 同域等比） */
function reprojectStroke<T extends InkStroke>(
  stroke: T,
  from: Rect,
  to: Rect,
  scale: number,
): T {
  return {
    ...stroke,
    weight: stroke.weight * scale,
    points: stroke.points.map((point) => {
      const mapped = mapPoint(point.x, point.y, from, to);
      return { ...point, x: mapped.x, y: mapped.y };
    }),
  };
}

/** 布局兼容性证据完整（blocks 带键）才可做节点级重投影 */
function hasKeyedBlocks(layout: AnnotationSurfaceLayout): boolean {
  return (layout.compatibility?.blocks ?? []).some(
    (block) => block.node !== undefined,
  );
}

/**
 * 把保存底图坐标域的文档投影到 target 布局。
 * 锚块缺失（含 saved 无该键 / target 无该键 / 笔画无锚）→ 按 root 整体
 * 等比缩放（宽比基准）并计入 unanchored；任一 root 兜底 → approximate。
 */
export function reprojectAnnotation(
  doc: AnnotationDoc,
  saved: AnnotationSurfaceLayout,
  target: AnnotationSurfaceLayout,
): ReprojectedAnnotation {
  const savedBlocks = keyedBlocksOf(saved);
  const targetBlocks = keyedBlocksOf(target);
  const docDomain = docDomainOf(doc);
  const targetDomain = targetDomainOf(target);
  const rootScale = targetDomain.width / docDomain.width;

  const mapStroke = <T extends InkStroke>(
    stroke: T,
  ): { stroke: T; unanchored: boolean } => {
    const anchorKey =
      stroke.id === undefined ? undefined : doc.anchors?.[stroke.id];
    const from =
      anchorKey === undefined ? undefined : savedBlocks.get(anchorKey);
    const to =
      anchorKey === undefined ? undefined : targetBlocks.get(anchorKey);
    if (
      from === undefined ||
      to === undefined ||
      to.width === 0 ||
      from.width === 0
    ) {
      return {
        stroke: reprojectStroke(stroke, docDomain, targetDomain, rootScale),
        unanchored: true,
      };
    }
    return {
      stroke: reprojectStroke(stroke, from, to, to.width / from.width),
      unanchored: false,
    };
  };

  let approximate = false;
  let unanchored = 0;
  const strokes: InkStroke[] = [];
  for (const stroke of doc.strokes) {
    const mapped = mapStroke(stroke);
    strokes.push(mapped.stroke);
    if (mapped.unanchored) {
      approximate = true;
      unanchored += 1;
    }
  }
  const deleted: InkDeletedStroke[] = [];
  for (const tomb of doc.deleted ?? []) {
    const mapped = mapStroke(tomb);
    deleted.push(mapped.stroke);
    if (mapped.unanchored) {
      approximate = true;
      unanchored += 1;
    }
  }
  return { strokes, deleted, approximate, unanchored };
}

/**
 * 反向映射：把在 target 布局上新画的笔画（nodeKey = 该笔在目标布局收笔时
 * 锚定的节点键，PR2 收笔即锚）映射回保存底图坐标域（存盘用）。锚块任一侧
 * 缺失 → 按 root 整体缩放回退（与正向同口径，调用方照常锚定/压实）。
 */
export function inverseReproject(
  stroke: InkStroke,
  nodeKey: string | undefined,
  saved: AnnotationSurfaceLayout,
  target: AnnotationSurfaceLayout,
): InkStroke {
  const savedBlocks = keyedBlocksOf(saved);
  const targetBlocks = keyedBlocksOf(target);
  const docDomain: Rect = {
    x: 0,
    y: 0,
    width: Math.ceil(saved.cssWidth * saved.pixelRatio),
    height: Math.ceil(saved.cssHeight * saved.pixelRatio),
  };
  const targetDomain = targetDomainOf(target);
  const from = nodeKey === undefined ? undefined : targetBlocks.get(nodeKey);
  const to = nodeKey === undefined ? undefined : savedBlocks.get(nodeKey);
  if (
    from === undefined ||
    to === undefined ||
    to.width === 0 ||
    from.width === 0
  ) {
    return reprojectStroke(
      stroke,
      targetDomain,
      docDomain,
      docDomain.width / targetDomain.width,
    );
  }
  return reprojectStroke(stroke, from, to, to.width / from.width);
}

/** 布局是否可用于节点级重投影（近似原位模式准入的一半：target 侧带键） */
export function reprojectable(
  saved: AnnotationSurfaceLayout,
  target: AnnotationSurfaceLayout,
): boolean {
  return hasKeyedBlocks(saved) && hasKeyedBlocks(target);
}
