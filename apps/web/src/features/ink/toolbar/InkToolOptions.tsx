import { cn } from "cn";
import { RadioGroup } from "radix-ui";
import { type ReactNode, useId } from "react";
import {
  INK_ERASER_SIZE_KEYS,
  INK_PEN_COLOR_KEYS,
  INK_PEN_SIZE_KEYS,
  type InkToolboxState,
} from "../engine/toolbox.ts";
import {
  INK_ERASER_SIZES,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
  type InkToolType,
} from "../engine/types.ts";
import {
  INK_ERASER_SIZE_LABEL,
  INK_PEN_COLOR_LABEL,
  INK_PEN_SIZE_LABEL,
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
}

function OptionGroup<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  render,
}: OptionGroupProps<T>) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="px-1 text-xs text-muted-foreground">
        {label}
      </span>
      <RadioGroup.Root
        aria-labelledby={labelId}
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
              "flex size-11 items-center justify-center rounded-lg border border-transparent outline-none transition-colors",
              "hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-[state=checked]:border-ring data-[state=checked]:bg-muted",
            )}
          >
            {render(option)}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
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

/** 橡皮：大小 */
function EraserOptions({ toolbox, onChange }: PanelProps) {
  const { eraser } = toolbox;
  return (
    <OptionGroup
      label="大小"
      value={eraser.size}
      options={INK_ERASER_SIZE_KEYS}
      optionLabel={INK_ERASER_SIZE_LABEL}
      onChange={(size) => onChange({ ...toolbox, eraser: { ...eraser, size } })}
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
  );
}

/** 有选项面板的工具；其余工具（滚动）点一下即生效，没有可调项 */
export function inkToolHasOptions(tool: InkToolType): boolean {
  return tool === "pen" || tool === "eraser";
}

export function InkToolOptions({
  tool,
  ...panel
}: PanelProps & { tool: InkToolType }) {
  return (
    <div className="flex flex-col gap-3">
      {tool === "pen" && <PenOptions {...panel} />}
      {tool === "eraser" && <EraserOptions {...panel} />}
    </div>
  );
}
