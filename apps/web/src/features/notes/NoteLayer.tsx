/**
 * 题卡级草稿层（T6R.9，方案 §4.3/§5.3）：非手写题（选择/多选/判断/填空）
 * 的演算草稿纸。手写题不走本组件（继续 HandwrittenControls 的作答 ink）。
 *
 * 形态：
 * - **收起**：只显示「草稿纸 · N 笔」标记按钮（有笔迹时含笔数与待处理
 *   提示）；纸面隐藏保留（复审⑦：收起后引擎保活 NOTE_ENGINE_KEEPALIVE_MS，
 *   重开零重建；超时才卸载）；
 * - **展开**：精简工具条（笔/橡皮/撤销/手指书写/更多——「手指书写」按钮
 *   归属本工具条，T6R.7 衔接注记①定案；会话偏好 store 两侧共用不变）
 *   + 纸面（InkPad 隐藏工具条形态）+ 四维状态区。
 *   T6R.15：工具条与引擎接线核心抽至 NoteToolbar / useNoteEditor（订正
 *   编辑器 CorrectionWorkspace 共用），冲突/被拒动作接线抽至 useNoteSyncActions
 *   （闸门修复 F4；CorrectionSection 补充稿块共用），本组件
 *   保留答题页形态编排（用户展开/保活/布局 preference/答题页 head 接线/
 *   补图重试）。
 * - phase=correction（2026-10 订正重构实测反馈）：订正工作台（CorrectionWorkspace）
 *   直接挂本组件做草稿纸——与答题页同一套手感/自动加高/全屏/布局偏好/
 *   保活（「弹出页与习题的草稿一致」）；差异仅：正文走 correction 行、
 *   派生图片维度关闭（订正查看走本地确定性渲染，无服务端图片语义）、
 *   不接答题页编辑协调器（结果页无 Provider，coordinator 恒 null）。
 *
 * 纸高（方案 §4.3 / T6R.7 衔接注记②定案）：逻辑高持久化在 NoteDoc，
 * CSS 高 = paperCssHeight(逻辑高, 纸宽) 每次换算；自动加高统一走
 * paper-geometry 逻辑口径（use-note-editor 内）；load 不触发 dirty
 * （reason 过滤）；触底包围盒增量维护（复审⑥）。
 *
 * 自写自载守卫（复审②）：比对 note-store 的**正文版本令牌 docVersion**
 * ——见 use-note-editor（随核心搬家）。
 *
 * 多题隔离：正文键含 questionId（note-store 五元键），各题各自一份；布局
 * 切换只改外框宽度——逻辑坐标笔画恒在纸内，不新建笔记、不改正文身份。
 */
import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Maximize2,
  NotebookPen,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { attemptMaterialsEditable } from "@/features/attempt/attempt-material-recovery";
import { useDraftSyncRecovery } from "@/features/attempt/use-draft-sync";
import { InkPad } from "@/features/ink/InkPad";
import { PaperPresentation } from "@/features/ink/PaperPresentation";
import {
  PAPER_KEEPALIVE_MS,
  useRetainedPaper,
} from "@/features/ink/use-retained-paper";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { recoverNoteImages } from "@/features/notes/image-sync";
import { NoteStatusArea } from "@/features/notes/NoteStatusArea";
import { NoteToolbar } from "@/features/notes/NoteToolbar";
import {
  type NoteLayoutPreference,
  setNoteLayoutPreference,
  useNoteLayoutPreference,
} from "@/features/notes/note-layout";
import {
  EMPTY_NOTE_DOC,
  inkDocOf,
  useNoteEditor,
} from "@/features/notes/use-note-editor";
import { useNoteHead, useNoteSessionRef } from "@/features/notes/use-note-head";
import { useNoteSyncActions } from "@/features/notes/use-note-sync-actions";
import { getNoteRecord, settleNotePersistence } from "./note-store";

/**
 * 收起后的引擎保活时长（复审⑦暂定 45s，区间 30-60s）：收起题卡高频发生在
 * 「先做选项再回草稿」的往返里，立即卸载会让重开整段重建（引擎实例 + 笔迹
 * 重放）。超时（确无回写意图）才真正卸载释放画布内存。
 */
export const NOTE_ENGINE_KEEPALIVE_MS = PAPER_KEEPALIVE_MS;

const LAYOUT_LABEL: Record<NoteLayoutPreference, string> = {
  auto: "自动（按宽度）",
  side: "左右分栏",
  below: "上下排列",
};

export interface NoteLayerProps {
  attemptId: string;
  questionId: string;
  /** 展开/收起受控（题卡持有：side 布局展开时才分栏） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 无障碍标签前缀（如「第 3 题」），空格拼接「草稿纸」 */
  ariaPrefix?: string;
  /** 题头已提供入口时隐藏重复按钮。 */
  showTrigger?: boolean;
  /**
   * 编辑 phase（2026-10 订正重构）：scratch=答题页草稿（缺省）；
   * correction=订正工作台草稿——同一套编辑器/同步管线/形态，正文走
   * correction 行、图片维度关闭、不接答题页协调器
   */
  phase?: "scratch" | "correction";
  /** 全屏态外发（订正工作台持屏期间拦 Esc/遮罩关闭外层弹窗） */
  onFullscreenChange?: (fullscreen: boolean) => void;
  stemMd?: string;
  /** 学生公开选项，用于全屏参考；不包含答案或解析。 */
  options?: readonly string[] | undefined;
}

export function NoteLayer({
  attemptId,
  questionId,
  open,
  onOpenChange,
  ariaPrefix = "本题",
  showTrigger = true,
  phase = "scratch",
  onFullscreenChange,
  stemMd,
  options,
}: NoteLayerProps) {
  const recovery = useDraftSyncRecovery();
  const session = useNoteSessionRef();
  const editor = useNoteEditor({
    session,
    attemptId,
    questionId,
    phase,
    active: open,
  });
  const { view } = editor;
  const coordinator = useAttemptEditor(null);
  const finish = useCallback(async () => {
    editor.engineRef.current?.finish?.();
    await settleNotePersistence();
    if (session) {
      const saved = await getNoteRecord(session, {
        attemptId,
        questionId,
        phase,
      });
      if (saved?.local === "failed")
        throw new Error(saved.localError ?? "草稿本机保存失败");
    }
  }, [editor.engineRef, session, attemptId, questionId, phase]);
  // 编辑协调器（交卷 flush）只在答题页挂载；订正工作台无 Provider
  // （coordinator 恒 null）且收笔/落盘语义已由 finish 自持，不注册
  useEffect(
    () =>
      phase === "scratch"
        ? coordinator?.register(questionId, finish, "scratch")
        : undefined,
    [coordinator?.register, questionId, finish, phase],
  );
  // scratch head 仅答题页草稿消费（补图重试）；订正工作台关闭查询——
  // 不拉 scratch head、不触发其播种/补图副作用
  const headQuery = useNoteHead(attemptId, questionId, {
    enabled: phase === "scratch",
  });
  const layoutPref = useNoteLayoutPreference();

  const doc = view?.doc ?? null;
  const strokeCount = doc?.ink.strokes.length ?? 0;

  // 旧稿到达只回显笔数，不替用户展开纸面。
  const [fullscreen, setFullscreen] = useState(false);
  // 全屏态外发（ref 转发：内联回调不重建 changeFullscreen）
  const onFullscreenChangeRef = useRef(onFullscreenChange);
  onFullscreenChangeRef.current = onFullscreenChange;
  const changeFullscreen = useCallback((next: boolean) => {
    setFullscreen(next);
    onFullscreenChangeRef.current?.(next);
  }, []);
  const [paperError, setPaperError] = useState<string | null>(null);
  const requestOpenChange = async (next: boolean) => {
    try {
      if (!next) await finish();
      changeFullscreen(false);
      setPaperError(null);
      onOpenChange(next);
    } catch (cause) {
      setPaperError(
        cause instanceof Error ? cause.message : "草稿本机保存失败，请重试",
      );
    }
  };
  const closeFullscreen = async () => {
    try {
      await finish();
      changeFullscreen(false);
      setPaperError(null);
    } catch (cause) {
      setPaperError(
        cause instanceof Error ? cause.message : "草稿本机保存失败，请重试",
      );
    }
  };

  // ---- 收起保活（复审⑦）：展开即清计时；收起计时到点才卸载纸面 ----
  const paperAlive = useRetainedPaper(open || fullscreen, finish);

  // ---- 冲突裁决 / 被拒重试（共享 hook useNoteSyncActions，scope 定在
  // 编辑 phase；图片维度逻辑留本组件，仅 scratch 消费）/ 补图重试 ----
  const { resolveError, keepLocal, keepCloud, retryDenied, adoptCloud } =
    useNoteSyncActions(session, {
      attemptId,
      questionId,
      phase,
    });
  const [imageRetrying, setImageRetrying] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  /** 正文 synced 且图片 failed/missing 的手动补图入口（重进入已自动触发
   * 过）。先 refetch head 再取版本补图（复审⑮）：以服务端当下生效版本为
   * 目标，不用可能陈旧的缓存——成功后 head 已是新状态，无需二次拉取 */
  const retryImages = useCallback(() => {
    setImageRetrying(true);
    void headQuery
      .refetch()
      .then((result) => {
        const versionId = result.data?.note?.currentVersionId ?? null;
        if (versionId === null) return undefined;
        return recoverNoteImages({ role: "student", versionId }).catch(
          (err: unknown) => {
            console.warn("手动补图失败", err);
          },
        );
      })
      .finally(() => setImageRetrying(false));
  }, [headQuery]);

  const label = `${ariaPrefix}草稿纸`;

  // ---- 纸面（位置恒定：开合零重挂载，复审⑦；收起形态见下方样式注释） ----
  const paperReady = open || paperAlive;

  return (
    <div
      data-slot="note-layer"
      className={
        !showTrigger && !open ? "hidden" : "flex min-w-0 flex-col gap-2"
      }
    >
      <PaperPresentation
        fullscreen={fullscreen}
        label={`${label}全屏`}
        heading={label}
        contextLabel={options?.length ? "题目（含选项）" : "题干"}
        context={
          <>
            {stemMd ? <RichMarkdown source={stemMd} /> : label}
            {options && options.length > 0 && (
              <ol aria-label="参考选项" className="mt-2 flex flex-col gap-2">
                {options.map((option, index) => (
                  <li key={option} className="flex items-baseline gap-2">
                    <span className="shrink-0 font-medium">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <RichMarkdown source={option} className="min-w-0 flex-1" />
                  </li>
                ))}
              </ol>
            )}
          </>
        }
        onClose={closeFullscreen}
      >
        {paperError && (
          <p role="alert" className="text-sm text-destructive">
            {paperError}
          </p>
        )}
        {/* 收起形态：标记按钮（有笔迹只显示标记——纸面隐藏不占布局） */}
        {!open && showTrigger && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 gap-1.5"
              onClick={() => requestOpenChange(true)}
              aria-label={
                strokeCount > 0 ? `${label}（已有 ${strokeCount} 笔）` : label
              }
            >
              <NotebookPen aria-hidden className="size-4" />
              草稿纸
              {strokeCount > 0 && (
                <span className="text-muted-foreground">
                  · {strokeCount} 笔
                </span>
              )}
              <ChevronDown aria-hidden className="size-4" />
            </Button>
            {(view?.conflict != null ||
              view?.denied != null ||
              view?.local === "failed") && (
              <span
                role="status"
                className="flex items-center gap-1 text-xs text-amber-600"
              >
                <CircleAlert aria-hidden className="size-3.5" />
                草稿同步需处理，点开查看
              </span>
            )}
          </div>
        )}

        {/* 展开形态：标题行 + 精简工具条（方案 §4.3：常驻笔/橡皮/撤销/更多＋
          手指书写；44px 触控目标） */}
        {open && !fullscreen && (
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <NotebookPen aria-hidden className="size-4" />
              草稿纸
              {strokeCount > 0 && (
                <span className="font-normal text-muted-foreground">
                  {strokeCount} 笔
                </span>
              )}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                className="size-11 p-0"
                title="全屏草稿"
                aria-label={`${label}全屏`}
                onClick={() => {
                  editor.engineRef.current?.finish?.();
                  changeFullscreen(true);
                }}
              >
                <Maximize2 aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 gap-1 px-2.5"
                onClick={() => requestOpenChange(false)}
                aria-label={`收起${label}`}
              >
                <ChevronDown aria-hidden className="size-4" />
                收起
              </Button>
            </div>
          </div>
        )}
        {open && (
          <NoteToolbar
            compact={coordinator !== null}
            label={label}
            tool={editor.tool}
            onToolChange={editor.setTool}
            penColor={editor.penColor}
            onPenColorChange={editor.setPenColor}
            penSize={editor.penSize}
            onPenSizeChange={editor.setPenSize}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onUndo={() => editor.engineRef.current?.undo()}
            onRedo={() => editor.engineRef.current?.redo()}
            onClearRequest={() => setClearOpen(true)}
            clearLabel={phase === "correction" ? "清空订正草稿" : "清空草稿纸"}
            moreTitle="更多（重做/颜色/粗细/清空/布局）"
            menuExtras={(
              Object.keys(LAYOUT_LABEL) as NoteLayoutPreference[]
            ).map((p) => (
              <DropdownMenuItem
                key={p}
                aria-checked={layoutPref === p}
                onSelect={() => setNoteLayoutPreference(p)}
              >
                <Check
                  aria-hidden
                  className={layoutPref === p ? "visible" : "invisible"}
                />
                布局：{LAYOUT_LABEL[p]}
              </DropdownMenuItem>
            ))}
          />
        )}

        {/* 纸面（位置与宽度恒定；保活期后卸载；不在未恢复的纸面上起笔）。
          收起用 **visibility + 高度塌缩**而非 display:none（复审⑤）：宽度
          保持满幅——引擎的 ResizeObserver 不触发 0 宽报告，重开不再全量
          重放/闪烁。（jsdom 测试桩不模拟 0 宽报告——该差异不进单测口径，
          真实行为由 E2E/真机覆盖。） */}
        <div
          ref={editor.paperWrapRef}
          data-slot="note-paper"
          className="w-full"
          style={
            open
              ? undefined
              : { height: 0, visibility: "hidden", overflow: "hidden" }
          }
        >
          {paperReady ? (
            editor.localLoaded &&
            (!recovery || attemptMaterialsEditable(recovery)) ? (
              <InkPad
                engine="atrament"
                showToolbar={false}
                inputMode="session"
                label={label}
                engineRef={editor.engineRef}
                background={doc?.background ?? "grid"}
                paperHeight={editor.cssHeight}
                initial={inkDocOf(doc ?? EMPTY_NOTE_DOC)}
                onDocChange={editor.handleDocChange}
                onEngineRebuild={editor.onEngineRebuild}
                inputEnabled={open}
              />
            ) : (
              <div
                role="status"
                className="flex h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
              >
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                {recovery?.state === "failed"
                  ? "草稿恢复失败，请在顶部重试"
                  : "正在恢复草稿…"}
              </div>
            )
          ) : null}
        </div>

        {/* 四维状态区 + 冲突/被拒/补图面板（方案 §5.3：正交、可理解、可操作）。
          T6R.15：抽至共享 NoteStatusArea（CorrectionWorkspace 复用），本组件按
          草稿语境接线（label=草稿、图片维度随 phase：correction 无服务端
          图片语义——查看走本地确定性渲染） */}
        {open && (
          <NoteStatusArea
            view={view}
            localLoaded={editor.localLoaded}
            label={phase === "correction" ? "订正" : "草稿"}
            images={phase === "scratch"}
            resolveError={resolveError}
            onKeepLocal={keepLocal}
            onKeepCloud={keepCloud}
            onRetryDenied={retryDenied}
            onAdoptCloud={adoptCloud}
            {...(phase === "scratch"
              ? { imageRetrying, onRetryImages: retryImages }
              : {})}
          />
        )}

        {/* 清空二次确认（清空=空稿作为新正文版本保存——覆盖语义同 ink 通道） */}
        <Dialog open={clearOpen} onOpenChange={setClearOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {phase === "correction" ? "清空订正草稿？" : "清空草稿纸？"}
              </DialogTitle>
              <DialogDescription>
                将清除本题{phase === "correction" ? "订正草稿" : "草稿"}的全部
                笔迹，清空后可用「撤销」恢复；已同步到服务端的旧版本不受影响。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => setClearOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="h-11"
                onClick={() => {
                  editor.engineRef.current?.clear();
                  setClearOpen(false);
                }}
              >
                清空
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PaperPresentation>
    </div>
  );
}
