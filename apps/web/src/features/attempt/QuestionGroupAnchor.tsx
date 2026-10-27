import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { Columns2, Layers, Rows3 } from "lucide-react";
import { type CSSProperties, memo, useEffect, useMemo, useRef } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import type { GroupMaterialLayout } from "./group-material-layout-store";
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
 * 题组锚（QM-08 细项 1/2/3；审查 P1 修复）：组头 + 共享材料列的**兄弟
 * 锚点**——题行永不进入本组件子树（消费侧题行保持 li(key=question.id)
 * 稳定树位），context 后到/重试成功只是本锚点作为新兄弟插入，React 按
 * key 调和不卸载既有题卡（草稿/手写/标画控制器随行存活；重挂即绕过
 * 「切题先收笔落盘」保护流）。
 *
 * 分组呈现由消费侧单元 ol 的 CSS grid 承担（compare 模式 xl 起
 * minmax(0,1fr)×2：本锚 xl:contents 展开为网格项——组头横跨两列、材料列
 * 占首列并按 questionCount 跨本组题行、组外行跨两列）；stack（AI 侧栏
 * 对照激活）/窄屏/单题态为普通流（组头+材料自然堆叠）。布局切换与组段
 * 采纳都只是 className 与兄弟增删，不动题行树位（不重挂题面不变量）。
 *
 * 「查看材料」reveal：revealSignal 递增 → 材料列滚入视野并恢复会话内已读
 * 偏移（material-reading-position）；「返回本题」由题卡入口承担（材料列
 * 就在旁边或紧随其后，跳题链已提供定位）。
 *
 * memo 用 React 默认属性比较：revealSignal/回调变化都触发更新。
 */
export const QuestionGroupAnchor = memo(function QuestionGroupAnchor({
  group,
  materials,
  questionCount = group.questionIds.length,
  readingKey,
  revealSignal = 0,
  hidden = false,
  attemptId,
  splitRatio,
  onSplitRatioChange,
  containerRef,
  layoutMode,
  onLayoutModeChange,
}: {
  group: AttemptContextGroup;
  /** 组引用解析后的冻结材料（attempt-context-view 单源） */
  materials: readonly AttemptContextMaterial[];
  /** 本卷内组题数（compare 网格材料列跨行数；缺省用组声明题数） */
  questionCount?: number;
  /** 阅读位置存储键（`${attemptId}|${groupId}`）；缺省不记录 */
  readingKey?: string | undefined;
  /** 「查看材料」信号：递增触发材料列滚入 + 恢复已读偏移 */
  revealSignal?: number;
  /** 单题模式等外层隐藏（隐藏不改 DOM 结构，控制器不卸载） */
  hidden?: boolean;
  /** 作答 attemptId（透传给 MaterialPanel 用于协同标画） */
  attemptId?: string | undefined;
  /** 当前分栏比例（百分比，35~65） */
  splitRatio?: number | undefined;
  /** 分栏比例变更回调（提供时激活中缝 Handle） */
  onSplitRatioChange?: ((ratio: number) => void) | undefined;
  /** 分栏外层容器引用，用于指针距离换算 */
  containerRef?: React.RefObject<HTMLElement | null> | undefined;
  /** 当前排版模式：split（左右分栏）或 stack（列表形式） */
  layoutMode?: GroupMaterialLayout | undefined;
  /** 排版模式变更回调（提供时激活切换控件） */
  onLayoutModeChange?: ((mode: GroupMaterialLayout) => void) | undefined;
}) {
  const materialsRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // 同材料多版本才逐版标注（QM-15 细项 4；单版本零徽标零视觉噪音）
  const versionNotes = useMemo(
    () => materialVersionNotesOf(materials),
    [materials],
  );

  // 阅读位置记录：材料列自身滚动（compare 模式）或窗口滚过材料顶（stack）
  useMaterialReadingPosition(materialsRef, readingKey);

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
  const isSplit = layoutMode !== "stack";

  return (
    <li
      data-slot="question-group-anchor"
      data-group-id={group.id}
      hidden={hidden}
      // 非 compare（stack/窄屏/单题态）锚点自身是流式块；compare 时 lg/xl 起
      // contents 展开让组头/材料列直接成为单元网格的项。hidden 的 UA
      // display:none 优先——单题态收起不被 lg:contents/xl:contents 抵消。
      className={
        hidden || !isSplit
          ? "flex flex-col gap-4"
          : "flex flex-col gap-4 lg:contents xl:contents"
      }
    >
      <section
        aria-label={title && title.length > 0 ? `题组：${title}` : "题组"}
        // compare 时与外层 li 同为 contents——组头/材料列直接成为单元网格的项
        className={
          isSplit
            ? "flex min-w-0 flex-col gap-4 lg:contents xl:contents"
            : "flex min-w-0 flex-col gap-4"
        }
      >
        <header
          ref={headerRef}
          data-slot="question-group-header"
          // reveal 滚入目标让出粘性顶栏（零材料组的回落目标；审查 P2-2）
          className={`flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 scroll-mt-[calc(var(--attempt-header-height,64px)+16px)] ${
            isSplit
              ? onSplitRatioChange !== undefined
                ? "lg:col-span-full xl:col-span-full"
                : "lg:col-span-2 xl:col-span-2"
              : ""
          }`}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
            <Layers
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <RichMarkdown
              source={title && title.length > 0 ? title : "题组"}
              className="min-w-0 flex-1 [&_p]:my-0"
            />
            {label && label.length > 0 ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                {label}
              </span>
            ) : null}
            {hasMaterials && (
              <span className="text-xs font-normal text-muted-foreground">
                {isSplit ? "共用材料作答" : "共用下方材料作答"}
              </span>
            )}
            {hasMaterials && onLayoutModeChange !== undefined && (
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
                  className={`inline-flex min-h-[26px] select-none items-center gap-1 rounded-sm px-2 py-0.5 text-xs transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
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
                  className={`inline-flex min-h-[26px] select-none items-center gap-1 rounded-sm px-2 py-0.5 text-xs transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
                    !isSplit
                      ? "bg-muted font-semibold text-foreground shadow-2xs"
                      : "hover:text-foreground"
                  }`}
                >
                  <Rows3 className="size-3.5 shrink-0" aria-hidden />
                  <span>列表形式</span>
                </button>
              </div>
            )}
          </div>
          {intro.length > 0 && (
            <div className="rich-markdown min-w-0 text-sm leading-7">
              <RichMarkdown source={intro} />
            </div>
          )}
        </header>
        {hasMaterials && (
          <>
            <section
              ref={materialsRef}
              data-slot="group-materials"
              tabIndex={-1}
              aria-label="本组共享材料"
              // compare 网格材料列跨行数经 CSS 变量传入（Tailwind 任意属性在
              // lg/xl 才生效；非网格语境下 grid-row 声明无害）
              style={
                {
                  "--qg-row-span": String(Math.max(questionCount, 1)),
                } as CSSProperties
              }
              className={
                isSplit
                  ? "flex min-w-0 max-w-full flex-col gap-4 self-start scroll-mt-[calc(var(--attempt-header-height,64px)+16px)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:sticky xl:sticky lg:top-[calc(var(--attempt-header-height,64px)+16px)] xl:top-[calc(var(--attempt-header-height,64px)+16px)] lg:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] lg:overflow-y-auto xl:overflow-y-auto lg:overscroll-contain xl:overscroll-contain lg:pr-1 xl:pr-1 lg:col-start-1 xl:col-start-1 lg:[grid-row:span_var(--qg-row-span)] xl:[grid-row:span_var(--qg-row-span)]"
                  : "flex min-w-0 max-w-full flex-col gap-4 self-start scroll-mt-[calc(var(--attempt-header-height,64px)+16px)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              }
            >
              {materials.map((material) => (
                <MaterialPanel
                  // QM-15 细项 4：键含冻结版本——同材料多版本分别保留（React
                  // key 按 materialId 会在双版本卷撞键丢面板）
                  key={materialVersionKey(material)}
                  material={material}
                  versionNote={versionNotes.get(materialVersionKey(material))}
                  attemptId={attemptId}
                  associatedQuestionIds={group.questionIds}
                />
              ))}
            </section>
            {isSplit && onSplitRatioChange !== undefined && (
              <div
                data-slot="group-split-handle-container"
                style={
                  {
                    "--qg-row-span": String(Math.max(questionCount, 1)),
                  } as CSSProperties
                }
                className="hidden lg:flex xl:flex lg:col-start-2 xl:col-start-2 lg:[grid-row:span_var(--qg-row-span)] xl:[grid-row:span_var(--qg-row-span)] lg:sticky xl:sticky lg:top-[calc(var(--attempt-header-height,64px)+16px)] xl:top-[calc(var(--attempt-header-height,64px)+16px)] lg:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] xl:max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] lg:justify-center xl:justify-center lg:self-stretch xl:self-stretch"
              >
                <MaterialSplitHandle
                  ratio={splitRatio ?? 50}
                  onRatioChange={onSplitRatioChange}
                  containerRef={containerRef}
                />
              </div>
            )}
          </>
        )}
      </section>
    </li>
  );
});
