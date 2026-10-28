import { Columns2, Rows3 } from "lucide-react";
import type { GroupMaterialLayout } from "./group-material-layout-store";

/**
 * 材料排版切换单选组（左右分栏 / 列表形式）——题组锚与题级材料锚共用同一
 * 实现（触控目标 ≥44px，键盘方向键切换；偏好经 group-material-layout-store
 * 持久化）。仅在排版实际可生效时由调用方渲染（AI 对照激活等强制上下排布
 * 的语境不提供切换，控件状态与真实布局保持一致）。
 */
export function MaterialLayoutToggle({
  layoutMode,
  onLayoutModeChange,
}: {
  layoutMode: GroupMaterialLayout;
  onLayoutModeChange: (mode: GroupMaterialLayout) => void;
}) {
  const isSplit = layoutMode === "split";
  return (
    <div
      role="radiogroup"
      aria-label="题组材料排版方式"
      className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-xs font-medium text-muted-foreground shadow-2xs"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          onLayoutModeChange("stack");
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          onLayoutModeChange("split");
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 分段单选控件遵循 WAI-ARIA radiogroup 规范 */}
      <button
        type="button"
        role="radio"
        aria-checked={isSplit}
        title="左右分栏：左材料，右题目"
        onClick={() => onLayoutModeChange("split")}
        className={`inline-flex min-h-11 select-none items-center gap-1 rounded-sm px-2 py-0.5 text-xs transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
          isSplit
            ? "bg-muted font-semibold text-foreground shadow-2xs"
            : "hover:text-foreground"
        }`}
      >
        <Columns2 className="size-3.5 shrink-0" aria-hidden />
        <span>左右分栏</span>
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: 分段单选控件遵循 WAI-ARIA radiogroup 规范 */}
      <button
        type="button"
        role="radio"
        aria-checked={!isSplit}
        title="列表形式：材料置顶，题目在下方"
        onClick={() => onLayoutModeChange("stack")}
        className={`inline-flex min-h-11 select-none items-center gap-1 rounded-sm px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
          !isSplit
            ? "bg-muted font-semibold text-foreground shadow-2xs"
            : "hover:text-foreground"
        }`}
      >
        <Rows3 className="size-3.5 shrink-0" aria-hidden />
        <span>列表形式</span>
      </button>
    </div>
  );
}
