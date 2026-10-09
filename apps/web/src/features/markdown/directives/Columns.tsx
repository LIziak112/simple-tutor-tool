import type { ColDirectiveAttrs } from "@tutor/contract";
import type { CSSProperties } from "react";
import type { DirectiveBaseProps, DirectiveProps } from "./types";

/**
 * ::::columns / :::col 分栏容器：iPad 横屏并排（flex-row）、竖屏/窄屏自动堆叠。
 * width 属性（如 "40%"）映射为 flex-basis，缺省各栏均分。
 */
export function ColumnsDirective({ children }: DirectiveBaseProps) {
  return (
    <div
      data-slot="columns"
      className="my-4 flex flex-col gap-4 md:flex-row md:items-start"
    >
      {children}
    </div>
  );
}

export function ColDirective({
  attrs,
  children,
}: DirectiveProps<ColDirectiveAttrs>) {
  const width = attrs.width?.trim();
  const style: CSSProperties | undefined =
    width && width.length > 0 ? { flex: `0 0 ${width}` } : undefined;
  return (
    <div data-slot="col" className="min-w-0 flex-1" style={style}>
      {children}
    </div>
  );
}
