import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { Layers } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { useAiCompareActive } from "@/features/student-ai/ai-companion-layout";
import { MaterialPanel } from "./MaterialPanel";
import {
  materialReadingOffsetOf,
  noteMaterialReadingOffset,
} from "./material-reading-position";

/**
 * 题组块（QM-08 细项 1/2/3）：组公共说明 + 共享材料列 + 子题列。
 *
 * 布局（纯 CSS 切换，不重挂子树——AGENTS.md「布局切换不重挂题面」）：
 * - compare（默认）：xl 起双栏——材料列 sticky 自滚动、子题列 minmax(0,1fr)
 *   跟随容器宽度（题卡外框宽度不变量：不按题型/草稿/AI 开合另设上限）；
 * - stack：AI 侧栏对照激活（useAiCompareActive）或窄屏——上下自然阅读。
 *   AI/手写开合不把内容挤成多窄栏（外框宽度不变量）。
 *
 * 「查看材料」reveal：revealSignal 递增 → 材料列滚入视野并恢复会话内已读
 * 偏移（material-reading-position）；「返回本题」由题卡入口承担（材料列
 * 无需自带——子题列就在旁边或紧随其后，跳题链已提供定位）。
 *
 * memo 用 React 默认属性比较：revealSignal/回调/children 变化都触发更新。
 */
export const QuestionGroupBlock = memo(function QuestionGroupBlock({
  group,
  materials,
  readingKey,
  revealSignal = 0,
  hidden = false,
  children,
}: {
  group: AttemptContextGroup;
  /** 组引用解析后的冻结材料（attempt-context-view 单源） */
  materials: readonly AttemptContextMaterial[];
  /** 阅读位置存储键（`${attemptId}|${groupId}`）；缺省不记录 */
  readingKey?: string | undefined;
  /** 「查看材料」信号：递增触发材料列滚入 + 恢复已读偏移 */
  revealSignal?: number;
  /** 单题模式等外层隐藏（隐藏不改 DOM 结构，控制器不卸载） */
  hidden?: boolean;
  /** 子题列内容（题卡 ol） */
  children: ReactNode;
}) {
  // AI 侧栏对照激活 → 回退上下排布（与题卡草稿「自动」布局同款信号）
  const compareActive = useAiCompareActive();
  const materialsRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  // 阅读位置记录：材料列自身滚动（compare 模式）或窗口滚过材料顶（stack）
  useEffect(() => {
    if (readingKey === undefined) return;
    const element = materialsRef.current;
    if (element === null) return;
    let frame = 0;
    const record = () => {
      frame = 0;
      const node = materialsRef.current;
      if (node === null || readingKey === undefined) return;
      if (node.scrollHeight > node.clientHeight) {
        // compare 模式：列内自身滚动，偏移即 scrollTop
        noteMaterialReadingOffset(readingKey, node.scrollTop);
      } else {
        // stack 模式：页面滚过材料顶部的距离（截断到材料自身高度）
        const top = node.getBoundingClientRect().top;
        noteMaterialReadingOffset(
          readingKey,
          Math.min(Math.max(-top, 0), node.scrollHeight),
        );
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(record);
    };
    element.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule);
    };
  }, [readingKey]);

  // reveal：滚入 + 恢复已读偏移 + 焦点落材料列（键盘可达）
  useEffect(() => {
    if (revealSignal === 0) return;
    const element = materialsRef.current ?? headerRef.current;
    if (element === null) return;
    element.scrollIntoView({ block: "start", behavior: "auto" });
    const offset =
      readingKey === undefined ? 0 : materialReadingOffsetOf(readingKey);
    if (offset > 0) {
      const node = materialsRef.current;
      if (node !== null && node.scrollHeight > node.clientHeight)
        node.scrollTop = offset;
      else window.scrollBy({ top: -offset, behavior: "auto" });
    }
    const focusable = materialsRef.current;
    if (focusable !== null) focusable.focus();
  }, [revealSignal, readingKey]);

  const hasMaterials = materials.length > 0;
  const intro = group.introMd.trim();
  const title = group.title?.trim();
  const label = group.label?.trim();
  return (
    <section
      data-slot="question-group-block"
      data-group-id={group.id}
      hidden={hidden}
      aria-label={title && title.length > 0 ? `题组：${title}` : "题组"}
      className="flex min-w-0 flex-col gap-4"
    >
      <header
        ref={headerRef}
        data-slot="question-group-header"
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3"
      >
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
          <Layers
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          {title && title.length > 0 ? title : "题组"}
          {label && label.length > 0 ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              {label}
            </span>
          ) : null}
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
      <div
        data-slot="question-group-body"
        data-layout={compareActive ? "stack" : "compare"}
        className={
          compareActive
            ? "grid min-w-0 grid-cols-1 gap-4"
            : "grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        }
      >
        {hasMaterials && (
          <section
            ref={materialsRef}
            data-slot="group-materials"
            tabIndex={-1}
            aria-label="本组共享材料"
            className="flex min-w-0 flex-col gap-4 self-start focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring xl:sticky xl:top-[calc(var(--attempt-header-height,64px)+16px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:overflow-y-auto xl:overscroll-contain xl:pr-1"
          >
            {materials.map((material) => (
              <MaterialPanel key={material.id} material={material} />
            ))}
          </section>
        )}
        <div
          data-slot="group-questions"
          className="flex min-w-0 flex-col gap-4"
        >
          {children}
        </div>
      </div>
    </section>
  );
});
