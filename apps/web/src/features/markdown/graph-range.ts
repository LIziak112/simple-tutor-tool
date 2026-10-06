/**
 * ::graph 的 range 属性解析（markdown 域纯工具，T6R.12 复审 B5 自 Media.tsx
 * 迁出）：如 "-3,3" → x 轴区间；非法返回 null（调用方交给 function-plot 自动
 * 选取）。组件渲染（GraphDirective）与静态素材导出（question-materials 的
 * 图表静态化）同一口径，搬家不抄数。
 */
export function parseGraphRange(
  range: string | undefined,
): { domain: [number, number] } | null {
  if (!range) return null;
  const parts = range.split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [min, max] = parts as [number, number];
  if (min >= max) return null;
  return { domain: [min, max] };
}
