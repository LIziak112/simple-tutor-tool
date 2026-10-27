import type { AttemptContextMaterial } from "@tutor/contract";
import { slotNumberedContentOf } from "@tutor/md-dsl";
import { FileText } from "lucide-react";
import { memo } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { MaterialAnnotationOverlay } from "./MaterialAnnotationOverlay";

/**
 * 材料槽位标记 → 编号空位（QM-13 细项 1）：公共文章不使用带参考答案的
 * [[…]] 填空标记充当选择槽位——完形（choice）/配对（match）槽位按材料
 * 槽位序渲染为加粗编号（**（N）**），编号与子题/题干的「第 N 空」对应；
 * 未声明 id 的标记原样保留（防御：不猜测不崩溃）。教师预览走源码形态
 * （Qm.tsx 指令），不经本函数。QM-16 起实现收归 md-dsl
 * slotNumberedContentOf 单源（服务端导出与受控 AI 出口共用同一编号口径）。
 */
function slotMarkedContentOf(material: AttemptContextMaterial): string {
  return slotNumberedContentOf(material.contentMd, material.slots);
}

/**
 * 材料条目的版本感知键（QM-15 细项 4）：同材料不同历史版本同时选入
 * （wrong 重练双版本卷）时分别保留——React key / 消费方去重必须用
 * (id, sourceVersion)，不能按 materialId（设计方案 §5.3「不能按 materialId
 * 合并覆盖」；快照身份 = id + 冻结版本）。
 */
export function materialVersionKey(material: {
  id: string;
  sourceVersion: number;
}): string {
  return `${material.id}|${material.sourceVersion}`;
}

/**
 * 同 id 多版本才有的版本徽标文案（QM-15 细项 4）：单版本材料不带徽标
 * （正常卷恒单版本，零视觉噪音）；双版本并存时逐版标注，学生可对上
 * 「这道题当时看到的是哪一版」。键 = materialVersionKey。
 */
export function materialVersionNotesOf(
  materials: readonly { readonly id: string; readonly sourceVersion: number }[],
): Map<string, string> {
  const countById = new Map<string, number>();
  for (const material of materials) {
    countById.set(material.id, (countById.get(material.id) ?? 0) + 1);
  }
  const notes = new Map<string, string>();
  for (const material of materials) {
    if ((countById.get(material.id) ?? 0) > 1) {
      notes.set(
        materialVersionKey(material),
        `历史版本 ${material.sourceVersion}`,
      );
    }
  }
  return notes;
}

/**
 * 共享材料面板（QM-08 细项 1/4）：组内子题共用的同一份冻结材料实例——
 * 标题（缺省「材料」）+ 正文经 RichMarkdown（与教师预览同一 markdown 管线
 * 与指令组件，共用数据解释）。材料正文是只读内容：无任何作答/选中态，
 * 导出与只读语境同形态。长表/长公式在 .material-reading 作用域内局部滚动
 * （index.css），图片放大/重试由 ::image 指令组件承担。
 * 提供 attemptId 时挂载 MaterialAnnotationOverlay 协同标画层。
 *
 * memo 用 React 默认属性比较（AGENTS.md「作答圈画与草稿交互约定」）：
 * 不写仅比较 source 的自定义比较器——上下文回调或样式变化必须触发重渲染。
 */
export const MaterialPanel = memo(function MaterialPanel({
  material,
  variant = "block",
  versionNote,
  attemptId,
  associatedQuestionIds,
}: {
  material: AttemptContextMaterial;
  /**
   * block = 组块材料列/窄屏自然阅读（默认卡片形态）；
   * compact = 侧栏对照列（更紧凑的内边距，正文不变）
   */
  variant?: "block" | "compact";
  /**
   * 同材料多版本并存时的版本徽标文案（materialVersionNotesOf 的值）；
   * 单版本不传（不渲染徽标）
   */
  versionNote?: string | undefined;
  /** 作答会话 attemptId（提供时挂载材料圈画图层；缺省不挂载） */
  attemptId?: string | undefined;
  /** 本材料所属题目 ID 集合（仅关联题进入标注态时激活材料手写） */
  associatedQuestionIds?: readonly string[] | undefined;
}) {
  const title = material.title?.trim();
  const content = (
    <div className="material-reading min-w-0 text-base leading-[1.75]">
      <RichMarkdown source={slotMarkedContentOf(material)} />
    </div>
  );

  return (
    <section
      data-slot="material-panel"
      data-material-id={material.id}
      aria-label={title && title.length > 0 ? `共享材料：${title}` : "共享材料"}
      className={
        variant === "compact"
          ? "flex min-w-0 flex-col gap-3 rounded-[8px] border border-border bg-card p-3 text-card-foreground isolate"
          : "flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground sm:p-5 isolate"
      }
    >
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <FileText aria-hidden className="size-4 shrink-0" />
        {title && title.length > 0 ? title : "材料"}
        {versionNote !== undefined && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
            {versionNote}
          </span>
        )}
      </p>
      {attemptId ? (
        <MaterialAnnotationOverlay
          attemptId={attemptId}
          materialId={material.id}
          associatedQuestionIds={associatedQuestionIds}
        >
          {content}
        </MaterialAnnotationOverlay>
      ) : (
        content
      )}
    </section>
  );
});
