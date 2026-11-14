import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { type ReactNode, useId } from "react";
import {
  INK_ERASER_MODES,
  INK_ERASER_SIZE_KEYS,
  INK_HIGHLIGHTER_COLOR_KEYS,
  INK_HIGHLIGHTER_SIZE_KEYS,
  INK_PEN_COLOR_KEYS,
  INK_PEN_SIZE_KEYS,
  INK_SHAPE_KINDS,
  type InkToolboxState,
} from "../engine/toolbox.ts";
import {
  INK_ERASER_SIZES,
  INK_HIGHLIGHTER_SIZES,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
  type InkToolType,
} from "../engine/types.ts";
import {
  EraserModeGlyph,
  HighlighterLineGlyph,
  InkShapeGlyph,
} from "./tool-glyphs.tsx";
import {
  INK_ERASER_MODE_HINT,
  INK_ERASER_MODE_LABEL,
  INK_ERASER_SIZE_LABEL,
  INK_HIGHLIGHTER_COLOR_LABEL,
  INK_HIGHLIGHTER_LINE_HINT,
  INK_HIGHLIGHTER_LINE_LABEL,
  INK_HIGHLIGHTER_LINES,
  INK_HIGHLIGHTER_SIZE_LABEL,
  INK_HIGHLIGHTER_SWATCH,
  INK_PEN_COLOR_LABEL,
  INK_PEN_SIZE_LABEL,
  INK_SHAPE_HINT,
  INK_SHAPE_LABEL,
  type InkHighlighterLine,
} from "./tool-labels.ts";

/**
 * 工具选项面板：每种工具一块，只改工具箱里对应的那份设置，不切换当前工具。
 * 每组选项是一个单选组（方向键移动并选中），选中后面板不收起，可以连着调。
 */

interface OptionGroupProps<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: Record<T, string>;
  onChange(value: T): void;
  /** 选项的图形（色块、圆点等）；名字由 optionLabel 提供给读屏 */
  render(option: T): ReactNode;
  /** 图形后面再写上名字：光看图形分不出来的选项用（擦除方式） */
  named?: boolean;
  /** 选项下面的一行说明（当前选中项是什么意思） */
  hint?: string;
}

function OptionGroup<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  render,
  named = false,
  hint,
}: OptionGroupProps<T>) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="px-1 text-xs text-muted-foreground">
        {label}
      </span>
      <RadioGroup.Root
        aria-labelledby={labelId}
        aria-describedby={hint === undefined ? undefined : hintId}
        orientation="horizontal"
        value={value}
        onValueChange={(next) => {
          const option = options.find((item) => item === next);
          if (option !== undefined) onChange(option);
        }}
        // 间距 2px：六个 44px 色块在 320px 屏上也排成一行
        className="flex flex-wrap gap-0.5"
      >
        {options.map((option) => (
          <RadioGroup.Item
            key={option}
            value={option}
            aria-label={optionLabel[option]}
            title={optionLabel[option]}
            className={cn(
              "flex h-11 items-center justify-center rounded-lg border border-transparent outline-none transition-colors",
              "hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-[state=checked]:border-ring data-[state=checked]:bg-muted",
              named ? "gap-1.5 px-2.5 text-sm" : "w-11",
            )}
          >
            {render(option)}
            {named && <span aria-hidden>{optionLabel[option]}</span>}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {hint !== undefined && (
        <span id={hintId} className="px-1 text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

interface PanelProps {
  toolbox: InkToolboxState;
  onChange(next: InkToolboxState): void;
}

/** 笔：颜色与粗细（形状工具共用这两项） */
function PenOptions({ toolbox, onChange }: PanelProps) {
  const { pen } = toolbox;
  return (
    <>
      <OptionGroup
        label="颜色"
        value={pen.color}
        options={INK_PEN_COLOR_KEYS}
        optionLabel={INK_PEN_COLOR_LABEL}
        onChange={(color) => onChange({ ...toolbox, pen: { ...pen, color } })}
        render={(color) => (
          <span
            aria-hidden
            className="size-6 rounded-full border border-black/10"
            style={{ backgroundColor: INK_PEN_COLORS[color] }}
          />
        )}
      />
      <OptionGroup
        label="粗细"
        value={pen.size}
        options={INK_PEN_SIZE_KEYS}
        optionLabel={INK_PEN_SIZE_LABEL}
        onChange={(size) => onChange({ ...toolbox, pen: { ...pen, size } })}
        render={(size) => {
          // 圆点直径随线宽放大，看着就是这一档落在纸上的粗细感
          const dot = 3 + INK_PEN_SIZES[size] * 1.7;
          return (
            <span
              aria-hidden
              className="rounded-full"
              style={{
                width: dot,
                height: dot,
                backgroundColor: INK_PEN_COLORS[pen.color],
              }}
            />
          );
        }}
      />
    </>
  );
}

/**
 * 荧光笔：线条（手绘或直线）、颜色与粗细。图形用横条（像划过一行字），和
 * 笔的圆点区分开
 */
function HighlighterOptions({ toolbox, onChange }: PanelProps) {
  const { highlighter } = toolbox;
  const line: InkHighlighterLine = highlighter.straight ? "straight" : "free";
  return (
    <>
      <OptionGroup
        label="线条"
        value={line}
        options={INK_HIGHLIGHTER_LINES}
        optionLabel={INK_HIGHLIGHTER_LINE_LABEL}
        hint={INK_HIGHLIGHTER_LINE_HINT[line]}
        onChange={(next) =>
          onChange({
            ...toolbox,
            highlighter: { ...highlighter, straight: next === "straight" },
          })
        }
        render={(option) => (
          <HighlighterLineGlyph
            line={option}
            color={INK_HIGHLIGHTER_SWATCH[highlighter.color]}
          />
        )}
        named
      />
      <OptionGroup
        label="颜色"
        value={highlighter.color}
        options={INK_HIGHLIGHTER_COLOR_KEYS}
        optionLabel={INK_HIGHLIGHTER_COLOR_LABEL}
        onChange={(color) =>
          onChange({ ...toolbox, highlighter: { ...highlighter, color } })
        }
        render={(color) => (
          <span
            aria-hidden
            className="h-4 w-7 rounded-sm border border-black/10"
            style={{ backgroundColor: INK_HIGHLIGHTER_SWATCH[color] }}
          />
        )}
      />
      <OptionGroup
        label="粗细"
        value={highlighter.size}
        options={INK_HIGHLIGHTER_SIZE_KEYS}
        optionLabel={INK_HIGHLIGHTER_SIZE_LABEL}
        onChange={(size) =>
          onChange({ ...toolbox, highlighter: { ...highlighter, size } })
        }
        render={(size) => (
          <span
            aria-hidden
            className="w-7 rounded-sm"
            style={{
              // 横条的高随线宽变：细 8、中 12、粗 18 像素
              height: Math.round(2 + INK_HIGHLIGHTER_SIZES[size] * 0.6),
              backgroundColor: INK_HIGHLIGHTER_SWATCH[highlighter.color],
            }}
          />
        )}
      />
    </>
  );
}

/** 橡皮：擦除方式与大小 */
function EraserOptions({ toolbox, onChange }: PanelProps) {
  const { eraser } = toolbox;
  return (
    <>
      <OptionGroup
        label="擦除方式"
        value={eraser.mode}
        options={INK_ERASER_MODES}
        optionLabel={INK_ERASER_MODE_LABEL}
        hint={INK_ERASER_MODE_HINT[eraser.mode]}
        onChange={(mode) =>
          onChange({ ...toolbox, eraser: { ...eraser, mode } })
        }
        render={(mode) => <EraserModeGlyph mode={mode} />}
        named
      />
      <OptionGroup
        label="大小"
        value={eraser.size}
        options={INK_ERASER_SIZE_KEYS}
        optionLabel={INK_ERASER_SIZE_LABEL}
        onChange={(size) =>
          onChange({ ...toolbox, eraser: { ...eraser, size } })
        }
        render={(size) => {
          const ring = 8 + INK_ERASER_SIZES[size] * 0.6;
          return (
            <span
              aria-hidden
              className="rounded-full border-2 border-foreground/70"
              style={{ width: ring, height: ring }}
            />
          );
        }}
      />
    </>
  );
}

/** 形状：画哪一种；颜色、粗细就是笔的那两项（改了笔也跟着变） */
function ShapeOptions({ toolbox, onChange }: PanelProps) {
  const { shape } = toolbox;
  return (
    <>
      <OptionGroup
        label="形状"
        value={shape.kind}
        options={INK_SHAPE_KINDS}
        optionLabel={INK_SHAPE_LABEL}
        hint={INK_SHAPE_HINT[shape.kind]}
        onChange={(kind) => onChange({ ...toolbox, shape: { ...shape, kind } })}
        render={(kind) => <InkShapeGlyph kind={kind} className="size-6" />}
      />
      <PenOptions toolbox={toolbox} onChange={onChange} />
    </>
  );
}

/** 有选项面板的工具；其余工具（滚动）点一下即生效，没有可调项 */
export function inkToolHasOptions(tool: InkToolType): boolean {
  return (
    tool === "pen" ||
    tool === "highlighter" ||
    tool === "eraser" ||
    tool === "shape"
  );
}

export function InkToolOptions({
  tool,
  ...panel
}: PanelProps & { tool: InkToolType }) {
  return (
    <div className="flex flex-col gap-3">
      {tool === "pen" && <PenOptions {...panel} />}
      {tool === "highlighter" && <HighlighterOptions {...panel} />}
      {tool === "eraser" && <EraserOptions {...panel} />}
      {tool === "shape" && <ShapeOptions {...panel} />}
    </div>
  );
}
