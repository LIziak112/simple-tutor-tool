import type { AttemptContextMaterial } from "@tutor/contract";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  MaterialPanel,
  materialVersionKey,
  materialVersionNotesOf,
} from "./MaterialPanel";
import { MaterialSplitHandle } from "./MaterialSplitHandle";
import {
  materialReadingOffsetOf,
  useMaterialReadingPosition,
} from "./material-reading-position";

/**
 * 题级材料锚（P1-2）：solo 题（无组归属）的 ::ref 材料入口——题级引用
 * 材料此前仅导出/AI 闭包可达，作答/结果 UI 读不到（QM-19 第一批记档
 * P1-2）。数据经 questionMaterialsOf（attempt-context-view 单源）解析；
 * 本组件与题行同为单元 ol 的**兄弟项**（不包裹题行——树位纪律同
 * QuestionGroupAnchor：context 后到只是新兄弟插入，li(key=question.id)
 * 题卡不重挂，草稿/手写/标画控制器随行存活）。
 *
 * 呈现：材料常驻渲染自然阅读（不折叠不弹层）；题卡「查看本题材料」按钮
 * 只承担 reveal 滚入 + 恢复已读偏移 + 焦点可达。compare 网格单元由消费侧
 * className 跨两列（组材料列的 sticky/跨行类是组语义，题级材料随题滚动）。
 *
 * memo 用 React 默认属性比较（AGENTS.md 约定）：revealSignal/回调/className
 * 变化都触发更新。
 */
export const QuestionMaterialsAnchor = memo(function QuestionMaterialsAnchor({
  questionId,
  materials,
  readingKey,
  revealSignal = 0,
  hidden = false,
  className,
  attemptId,
  splitRatio,
  onSplitRatioChange,
  containerRef,
}: {
  questionId: string;
  /** questionMaterialsOf 解析后的冻结材料（attempt-context-view 单源） */
  materials: readonly AttemptContextMaterial[];
  /** 阅读位置存储键（`${attemptId}|q:${questionId}`）；缺省不记录 */
  readingKey?: string | undefined;
  /** 「查看本题材料」信号：递增触发滚入 + 恢复已读偏移 */
  revealSignal?: number;
  /** 单题模式等外层隐藏（隐藏不改 DOM 结构，控制器不卸载） */
  hidden?: boolean;
  /** 消费侧布局类（compare 网格跨列等；与默认流式类合并） */
  className?: string | undefined;
  /** 作答 attemptId（透传给 MaterialPanel 用于协同标画） */
  attemptId?: string | undefined;
  /** 当前分栏比例（百分比，35~65） */
  splitRatio?: number | undefined;
  /** 分栏比例变更回调（提供时激活中缝 Handle） */
  onSplitRatioChange?: ((ratio: number) => void) | undefined;
  /** 分栏外层容器引用，用于指针距离换算 */
  containerRef?: React.RefObject<HTMLElement | null> | undefined;
}) {
  const materialsRef = useRef<HTMLElement>(null);
  // 同材料多版本才逐版标注（QM-15 细项 4；单版本零徽标零视觉噪音）
  const versionNotes = useMemo(
    () => materialVersionNotesOf(materials),
    [materials],
  );
  useMaterialReadingPosition(materialsRef, readingKey);

  // reveal：滚入 + 恢复已读偏移 + 焦点落材料区（键盘可达；无组头回落目标）
  useEffect(() => {
    if (revealSignal === 0) return;
    const element = materialsRef.current;
    if (element === null) return;
    element.scrollIntoView({ block: "start", behavior: "auto" });
    const offset =
      readingKey === undefined ? 0 : materialReadingOffsetOf(readingKey);
    if (offset > 0) {
      if (element.scrollHeight > element.clientHeight)
        element.scrollTop = offset;
      else window.scrollBy({ top: -offset, behavior: "auto" });
    }
    element.focus();
  }, [revealSignal, readingKey]);

  return (
    <li
      data-slot="question-materials-anchor"
      data-question-id={questionId}
      hidden={hidden}
      className={
        hidden
          ? `flex min-w-0 flex-col gap-3${className ? ` ${className}` : ""}`
          : onSplitRatioChange !== undefined
            ? `flex min-w-0 flex-col gap-3 xl:contents${className ? ` ${className}` : ""}`
            : `flex min-w-0 flex-col gap-3${className ? ` ${className}` : ""}`
      }
    >
      <section
        ref={materialsRef}
        data-slot="question-materials"
        tabIndex={-1}
        aria-label="本题材料"
        className={
          onSplitRatioChange !== undefined
            ? "flex min-w-0 max-w-full flex-col gap-3 self-start scroll-mt-[calc(var(--attempt-header-height,64px)+16px)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring xl:sticky xl:top-[calc(var(--attempt-header-height,64px)+16px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:overflow-y-auto xl:overscroll-contain xl:pr-1 xl:col-start-1"
            : "flex min-w-0 max-w-full flex-col gap-3 scroll-mt-[calc(var(--attempt-header-height,64px)+16px)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        }
      >
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          本题材料
        </p>
        {materials.map((material) => (
          <MaterialPanel
            // QM-15 细项 4：键含冻结版本（同 materialId 撞键丢面板）
            key={materialVersionKey(material)}
            material={material}
            versionNote={versionNotes.get(materialVersionKey(material))}
            attemptId={attemptId}
            associatedQuestionIds={[questionId]}
          />
        ))}
      </section>
      {onSplitRatioChange !== undefined && (
        <div
          data-slot="question-split-handle-container"
          className="hidden xl:flex xl:col-start-2 xl:sticky xl:top-[calc(var(--attempt-header-height,64px)+16px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:justify-center xl:self-stretch"
        >
          <MaterialSplitHandle
            ratio={splitRatio ?? 50}
            onRatioChange={onSplitRatioChange}
            containerRef={containerRef}
          />
        </div>
      )}
    </li>
  );
});
