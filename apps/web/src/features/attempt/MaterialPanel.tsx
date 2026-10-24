import type { AttemptContextMaterial } from "@tutor/contract";
import { FileText } from "lucide-react";
import { memo } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

/**
 * 槽位标记：{{slot-id}}（与 md-dsl materials.ts collectSlots 同一识别形态；
 * 空内容/未声明 id 的标记不替换——导入规范化后源文均为显式 id）
 */
const SLOT_MARKER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * 材料槽位标记 → 编号空位（QM-13 细项 1）：公共文章不使用带参考答案的
 * [[…]] 填空标记充当选择槽位——完形（choice）/配对（match）槽位按材料
 * 槽位序渲染为加粗编号（**（N）**），编号与子题/题干的「第 N 空」对应；
 * 未声明 id 的标记原样保留（防御：不猜测不崩溃）。教师预览走源码形态
 * （Qm.tsx 指令），不经本函数。
 */
function slotMarkedContentOf(material: AttemptContextMaterial): string {
  if (material.slots.length === 0) return material.contentMd;
  const ordinalById = new Map(
    material.slots.map((slot, index) => [slot.id, index + 1] as const),
  );
  return material.contentMd.replace(SLOT_MARKER_RE, (raw, id: string) => {
    const ordinal = ordinalById.get(id.trim());
    return ordinal === undefined ? raw : `**（${ordinal}）**`;
  });
}

/**
 * 共享材料面板（QM-08 细项 1/4）：组内子题共用的同一份冻结材料实例——
 * 标题（缺省「材料」）+ 正文经 RichMarkdown（与教师预览同一 markdown 管线
 * 与指令组件，共用数据解释）。材料正文是只读内容：无任何作答/选中态，
 * 导出与只读语境同形态。长表/长公式在 .material-reading 作用域内局部滚动
 * （index.css），图片放大/重试由 ::image 指令组件承担。
 *
 * memo 用 React 默认属性比较（AGENTS.md「作答圈画与草稿交互约定」）：
 * 不写仅比较 source 的自定义比较器——上下文回调或样式变化必须触发重渲染。
 */
export const MaterialPanel = memo(function MaterialPanel({
  material,
  variant = "block",
}: {
  material: AttemptContextMaterial;
  /**
   * block = 组块材料列/窄屏自然阅读（默认卡片形态）；
   * compact = 侧栏对照列（更紧凑的内边距，正文不变）
   */
  variant?: "block" | "compact";
}) {
  const title = material.title?.trim();
  return (
    <section
      data-slot="material-panel"
      data-material-id={material.id}
      aria-label={title && title.length > 0 ? `共享材料：${title}` : "共享材料"}
      className={
        variant === "compact"
          ? "flex min-w-0 flex-col gap-3 rounded-[8px] border border-border bg-card p-3 text-card-foreground"
          : "flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground sm:p-5"
      }
    >
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <FileText aria-hidden className="size-4 shrink-0" />
        {title && title.length > 0 ? title : "材料"}
      </p>
      <div className="material-reading min-w-0 text-base leading-[1.75]">
        <RichMarkdown source={slotMarkedContentOf(material)} />
      </div>
    </section>
  );
});
