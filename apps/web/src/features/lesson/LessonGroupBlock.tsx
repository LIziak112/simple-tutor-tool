import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { Layers } from "lucide-react";
import { memo } from "react";
import { MaterialPanel } from "@/features/attempt/MaterialPanel";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

/**
 * 讲练页题组块（QM-14 细项 1）：groupSegmentsOfUnit 解释出的组段在讲练页
 * 单列布局的流式呈现——组头（标题/标签/说明）+ 共享材料列表，渲染在首个
 * 成员题卡之前一次。数据解释（组归属/材料解析/latestById）与材料渲染
 * （MaterialPanel，含槽位编号空位）全部复用既有单源，本组件只承担讲练
 * 语境的排版：不使用作答页 compare 网格的 xl:sticky/列跨类（讲练材料就在
 * 组员上方自然阅读，与结果回看同理由不挂「查看材料」跳转）。
 *
 * 材料/组内容来自冻结上下文（/attempts/:id/context），绝不含题块原文；
 * context 加载失败由页面层非阻断提示（材料列缺失不阻塞作答）。
 */
export const LessonGroupBlock = memo(function LessonGroupBlock({
  group,
  materials,
}: {
  group: AttemptContextGroup;
  /** 组引用解析后的冻结材料（attempt-context-view 单源产物，引用序） */
  materials: readonly AttemptContextMaterial[];
}) {
  const hasMaterials = materials.length > 0;
  const intro = group.introMd.trim();
  const title = group.title?.trim();
  const label = group.label?.trim();
  return (
    <section
      data-slot="lesson-group-block"
      data-group-id={group.id}
      aria-label={title && title.length > 0 ? `题组：${title}` : "题组"}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card/60 px-4 py-3 sm:px-5">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
          <Layers
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          {title && title.length > 0 ? title : "题组"}
          {label && label.length > 0 && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              {label}
            </span>
          )}
          {hasMaterials && (
            <span className="text-xs font-normal text-muted-foreground">
              共用下方材料作答
            </span>
          )}
        </p>
        {intro.length > 0 && (
          <div className="rich-markdown min-w-0 text-sm leading-7">
            <RichMarkdown source={intro} />
          </div>
        )}
      </header>
      {hasMaterials && (
        <div className="flex min-w-0 flex-col gap-4">
          {materials.map((material) => (
            <MaterialPanel key={material.id} material={material} />
          ))}
        </div>
      )}
    </section>
  );
});
