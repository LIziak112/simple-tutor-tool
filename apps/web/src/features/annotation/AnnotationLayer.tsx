/**
 * 题卡级标注层（T6R.20）：「圈画题干」入口 + 两阶段底图流 + 编辑工作区。
 *
 * 形态（NoteLayer 同构，方案 §10「原始作答控件在标注模式外操作」）：
 * - **收起**：「圈画题干」按钮（有笔迹含笔数；同步异常提示点开处理）；
 * - **展开**：先走底图两阶段流（GET 视图 → 无底图则 POST base → 客户端
 *   栅格化 → POST base/image）——ready 才挂 AnnotationWorkspace（底图 img＋
 *   画布同 scale 变换）；**base 非 ready 不挂画布**，只显示状态：
 *   - disabled（超高题/EXPORT_ASSEMBLY_BROKEN/403）：「该题禁用标注，
 *     草稿照用」类文案——入口保留禁用态（重新打开可重试装配失败类）；
 *   - error（网络/栅格化瞬时失败）：原因 + 重试按钮；
 *   - sealed（审查修复 3①）：该 phase 已封存——只读固定态（AnnotationView
 *     回看：底图＋静态笔迹层），不挂编辑器；
 * - **内嵌形态（embedded，2026-10 订正重构实测反馈）**：无入口按钮/标题行/
 *   收起——挂载即走底图流，供订正工作台把「题干直接可圈画」嵌进题面卡：
 *   未就绪/禁用/出错时渲染调用方的 fallback 活题面（RichMarkdown）+ 状态，
 *   ready/sealed 后由底图（题干栅格，含选项）+ 画布接管题干显示——题面即
 *   圈画面，不再是独立折叠区；
 * - phase=correction 的封存检查点（2026-10 订正重构）：独立「添加订正标画」
 *   入口已移除，本层只作为订正工作台（CorrectionWorkspace）内的圈画面挂载；
 *   「保存订正」由工作台统一触发（seal-correction-annotation），本层不再
 *   提供独立保存按钮；
 * - 标注模式外保留原作答控件（本层是题干区的附加折叠区，不替换作答区）。
 */
import {
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Lock,
  PenLine,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AnnotationView } from "./AnnotationView";
import {
  AnnotationWorkspace,
  annotationWorkspaceBaseOf,
} from "./AnnotationWorkspace";
import { retryAnnotationUpload } from "./annotation-sync";
import { useAnnotationBase } from "./use-annotation-base";
import {
  useAnnotationRecord,
  useAnnotationSessionRef,
} from "./use-annotation-record";

export interface AnnotationLayerProps {
  attemptId: string;
  questionId: string;
  /** 阶段（答题期 scratch；订正期 correction——结果视图挂载） */
  phase?: "scratch" | "correction";
  /** 无障碍标签前缀（如「第 3 题」） */
  ariaPrefix?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  /** 结果回看可明确区分本次原标画与新订正。 */
  triggerLabel?: string;
  /**
   * 内嵌形态（订正工作台题面）：恒展开、无入口/标题/收起——挂载即走底图流。
   * 与 open/onOpenChange/showTrigger 互斥（内嵌不消费受控开合）。
   */
  embedded?: boolean;
  /**
   * 内嵌形态的活题面回退（RichMarkdown 题干+选项）：loading/idle/disabled/
   * error 时渲染（附带对应状态），底图 ready/sealed 后由底图+画布接管——
   * 题干任一刻可读，就绪后题面即圈画面。
   */
  fallback?: ReactNode;
}

export function AnnotationLayer({
  attemptId,
  questionId,
  phase = "scratch",
  ariaPrefix = "本题",
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  triggerLabel = "圈画题干",
  embedded = false,
  fallback,
}: AnnotationLayerProps) {
  const session = useAnnotationSessionRef();
  const record = useAnnotationRecord(attemptId, questionId, phase);
  const { flow, ensureBase } = useAnnotationBase({
    session,
    attemptId,
    questionId,
    phase,
  });
  const [internalOpen, setInternalOpen] = useState(false);
  const open = embedded ? true : (controlledOpen ?? internalOpen);
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const label = `${ariaPrefix}题干标注`;

  // 展开即触发两阶段流（收起再展开：ready/disabled/sealed 幂等不重跑）
  useEffect(() => {
    if (open) void ensureBase();
  }, [open, ensureBase]);

  const strokeCount = record?.doc?.strokes.length ?? 0;

  // base prop 已收窄为工作台最小结构：契约 ready 引用经适配函数过渡（不伪造身份字段）。
  const workspaceBase =
    flow.kind === "ready"
      ? annotationWorkspaceBaseOf(flow.base, attemptId)
      : null;

  const onRetryDenied = useCallback(() => {
    if (session !== null) {
      void retryAnnotationUpload(session, { attemptId, questionId, phase });
    }
  }, [session, attemptId, questionId, phase]);

  return (
    <div
      data-slot="annotation-layer"
      data-embedded={embedded ? "true" : undefined}
      className={
        !embedded && !showTrigger && !open
          ? "hidden"
          : "flex min-w-0 flex-col gap-2"
      }
    >
      {/* 收起形态：入口按钮（标注模式切换明确——显式开/收；内嵌形态无入口） */}
      {!embedded && !open && showTrigger && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-1.5"
            onClick={() => setOpen(true)}
          >
            <PenLine aria-hidden className="size-4" />
            {triggerLabel}
            {strokeCount > 0 && (
              <span className="text-muted-foreground">· {strokeCount} 笔</span>
            )}
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          {(record?.conflict != null ||
            record?.denied != null ||
            record?.local === "failed") && (
            <span
              role="status"
              className="flex items-center gap-1 text-xs text-amber-600"
            >
              <CircleAlert aria-hidden className="size-3.5" />
              标注同步需处理
              {record?.denied?.kind === "access" && (
                <Button
                  variant="outline"
                  className="ml-1 h-9 px-2.5 text-xs"
                  onClick={onRetryDenied}
                >
                  重试同步
                </Button>
              )}
            </span>
          )}
        </div>
      )}

      {/* 展开形态：标题行 + 收起按钮（内嵌形态无标题/收起——题面即圈画面） */}
      {!embedded && open && (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <PenLine aria-hidden className="size-4" />
            {triggerLabel}
            {strokeCount > 0 && (
              <span className="font-normal text-muted-foreground">
                {strokeCount} 笔
              </span>
            )}
            {phase === "correction" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                订正标注
              </span>
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1 px-2.5"
            onClick={() => setOpen(false)}
            aria-label={`收起${label}`}
          >
            <ChevronDown aria-hidden className="size-4" />
            收起
          </Button>
        </div>
      )}

      {/* 展开体：base 生命周期 gate——ready 才挂画布（没有可靠底图不能落墨） */}
      {open && (
        <>
          {flow.kind === "loading" &&
            (embedded ? (
              <>
                {fallback}
                <p
                  role="status"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                  正在准备题干圈画…
                </p>
              </>
            ) : (
              <div
                role="status"
                className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
              >
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                正在生成题干底图…
              </div>
            ))}
          {workspaceBase && flow.kind !== "sealed" && (
            <AnnotationWorkspace
              attemptId={attemptId}
              questionId={questionId}
              phase={phase}
              base={workspaceBase}
              ariaPrefix={ariaPrefix}
            />
          )}
          {/* 已封存固定态（审查修复 3①）：只读回看视图（底图＋静态笔迹层），
              不挂编辑器——scratch=已随交卷固定；correction=已随订正保存固定
              （后续订正仍可用草稿纸重做，圈画保留只读） */}
          {flow.kind === "sealed" && (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock aria-hidden className="size-3.5" />
                {phase === "correction"
                  ? "已随订正保存固定（再修改会新开一份）"
                  : "已随交卷固定（订正期另开新标注）"}
              </p>
              <AnnotationView
                viewer="student"
                attemptId={attemptId}
                questionId={questionId}
                phase={phase}
                ariaPrefix={ariaPrefix}
              />
            </div>
          )}
          {flow.kind === "disabled" &&
            (embedded ? (
              <>
                {fallback}
                <div
                  role="note"
                  className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{flow.reason}</span>
                </div>
              </>
            ) : (
              <div
                role="note"
                className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{flow.reason}</span>
              </div>
            ))}
          {flow.kind === "error" &&
            (embedded ? (
              <>
                {fallback}
                <div
                  role="alert"
                  className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
                >
                  <p className="text-destructive">
                    题干圈画准备失败：{flow.message}
                  </p>
                  <Button
                    variant="outline"
                    className="h-10 px-3 text-xs"
                    onClick={() => void ensureBase()}
                  >
                    重试
                  </Button>
                </div>
              </>
            ) : (
              <div
                role="alert"
                className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
              >
                <p className="text-destructive">底图生成失败：{flow.message}</p>
                <Button
                  variant="outline"
                  className="h-10 px-3 text-xs"
                  onClick={() => void ensureBase()}
                >
                  重试
                </Button>
              </div>
            ))}
          {flow.kind === "idle" &&
            (embedded ? (
              <>
                {fallback}
                <p
                  role="status"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                  正在准备题干圈画…
                </p>
              </>
            ) : (
              <div
                role="status"
                className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
              >
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                正在准备题干标注…
              </div>
            ))}
        </>
      )}
    </div>
  );
}
