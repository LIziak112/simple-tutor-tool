/**
 * 草稿渲染夹具（T6R.6 复审⑥收敛）：单元测试（render-note.test）与
 * /dev/ink 渲染验证面板（NoteRenderVerifyPanel）共用的确定性文档工厂。
 * **非测试文件**（面板属生产代码路径），不依赖任何测试框架；形状一律经
 * noteDocSchema.parse 物化缺省（读入口径同生产：不物化默认值布局计算 NaN）。
 */

import {
  NOTE_PAPER_HEIGHT_MAX,
  type NoteDoc,
  type NoteDocInput,
  noteDocSchema,
} from "@tutor/contract";
import {
  INK_HIGHLIGHTER,
  INK_PEN_COLORS,
} from "@/features/ink/engine/types.ts";

/**
 * 严格解析并物化 NoteDoc（缺省高度/背景补默认；读入口径同生产）。
 * 形态非法时抛中文错误（首条 issue 消息），不静默跳过——note-store 播种、
 * note-sync keepCloud、image-sync 补图恢复三处共用（T6R.8 复审⑭收敛）。
 * @param subject 错误文案主语（如「云端草稿正文」）；hint 追加指引尾注
 */
export function parseNoteDocOrThrow(
  raw: unknown,
  subject = "草稿正文",
  hint = "",
): NoteDoc {
  const parsed = noteDocSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "形状错误";
    throw new Error(`${subject}损坏或版本不兼容：${first}${hint}`);
  }
  return parsed.data;
}

/** 长稿夹具纸高：直接取契约上限值（单一来源，不另写 3000 字面量） */
export const TALL_PAPER_HEIGHT = NOTE_PAPER_HEIGHT_MAX;

/** 笔画工厂可选参数 */
export interface NoteStrokeOptions {
  color?: string;
  weight?: number;
  tool?: "pen" | "highlighter";
  /** 压感从 0.2 渐变到 0.9（覆盖 atrament 压感路径；缺省恒 0.5） */
  pressureRamp?: boolean;
}

/** 单点（轻点）或折线笔画（契约形状；color 用引擎真实色板值保证保真） */
export function stroke(
  points: Array<[number, number]>,
  o: NoteStrokeOptions = {},
): NoteDocInput["ink"]["strokes"][number] {
  const pressureOf = (i: number): number =>
    o.pressureRamp && points.length > 1
      ? 0.2 + (0.7 * i) / (points.length - 1)
      : 0.5;
  return {
    tool: o.tool ?? "pen",
    color: o.color ?? INK_PEN_COLORS.black,
    weight: o.weight ?? 4,
    points: points.map(([x, y], i) => ({ x, y, p: pressureOf(i), t: 0 })),
  };
}

/**
 * 密集折线笔画：沿顶点每 ~5 逻辑单位插一个点（真实书写/回放的点距量级——
 * atrament 平滑对每点只前进约 17% 距离，稀疏点笔画的绘制终点会大幅滞后，
 * 这是引擎原语的既有语义，检查夹具必须密集才能断言完整笔迹）。
 */
export function denseStroke(
  vertices: Array<[number, number]>,
  o: NoteStrokeOptions = {},
): NoteDocInput["ink"]["strokes"][number] {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < vertices.length; i++) {
    const a = vertices[i] as [number, number];
    const b = vertices[i + 1] as [number, number];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5),
    );
    for (let k = 0; k < steps; k++) {
      pts.push([
        a[0] + ((b[0] - a[0]) * k) / steps,
        a[1] + ((b[1] - a[1]) * k) / steps,
      ]);
    }
  }
  pts.push(vertices[vertices.length - 1] as [number, number]);
  return stroke(pts, o);
}

/** 解析为物化默认值的 NoteDoc（缺省：高 800 / grid 背景） */
export function docOf(
  strokes: NoteDocInput["ink"]["strokes"],
  o: {
    background?: NoteDocInput["background"];
    paperHeightLogical?: number;
  } = {},
): NoteDoc {
  return noteDocSchema.parse({
    version: 1,
    ink: { width: 1000, strokes },
    ...(o.background !== undefined ? { background: o.background } : {}),
    ...(o.paperHeightLogical !== undefined
      ? { paperHeightLogical: o.paperHeightLogical }
      : {}),
  });
}

/** 荧光笔便捷常量（面板/单测的荧光笔夹具同源） */
export const HIGHLIGHTER_STROKE_OPTIONS: NoteStrokeOptions = {
  tool: "highlighter",
  color: INK_HIGHLIGHTER.color,
  weight: INK_HIGHLIGHTER.weight,
};
