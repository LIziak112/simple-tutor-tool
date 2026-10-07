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
 *   编辑器 CorrectionPanel 共用），冲突/被拒动作接线抽至 useNoteSyncActions
 *   （闸门修复 F4；CorrectionPanel/CorrectionSection 补充稿块共用），本组件
 *   保留答题页形态编排（自动展开/保活/布局 preference/答题页 head 接线/
 *   补图重试）。
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
import { InkPad } from "@/features/ink/InkPad";
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

/**
 * 收起后的引擎保活时长（复审⑦暂定 45s，区间 30-60s）：收起题卡高频发生在
 * 「先做选项再回草稿」的往返里，立即卸载会让重开整段重建（引擎实例 + 笔迹
 * 重放）。超时（确无回写意图）才真正卸载释放画布内存。
 */
export const NOTE_ENGINE_KEEPALIVE_MS = 45_000;

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
}

export function NoteLayer({
  attemptId,
  questionId,
  open,
  onOpenChange,
  ariaPrefix = "本题",
}: NoteLayerProps) {
  const session = useNoteSessionRef();
  const editor = useNoteEditor({
    session,
    attemptId,
    questionId,
    phase: "scratch",
    active: open,
  });
  const { view } = editor;
  const headQuery = useNoteHead(attemptId, questionId);
  const layoutPref = useNoteLayoutPreference();

  const doc = view?.doc ?? null;
  const strokeCount = doc?.ink.strokes.length ?? 0;

  // 有笔迹自动展开一次（本地恢复或服务端播种到达后）；**手动收起即置位**
  // （复审⑧）：收起后到达的播种不再把题卡顶开——展开只由用户再次决定
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current || strokeCount === 0) return;
    autoExpandedRef.current = true;
    onOpenChange(true);
  }, [strokeCount, onOpenChange]);
  const requestOpenChange = useCallback(
    (next: boolean) => {
      if (!next) autoExpandedRef.current = true;
      onOpenChange(next);
    },
    [onOpenChange],
  );

  // ---- 收起保活（复审⑦）：展开即清计时；收起计时到点才卸载纸面 ----
  const [paperAlive, setPaperAlive] = useState(false);
  useEffect(() => {
    if (open) {
      setPaperAlive(true);
      return;
    }
    // 计时器闭包化（复审⑮）：卸载/重开由 effect 清理自动撤销，无共享 ref
    const timer = setTimeout(
      () => setPaperAlive(false),
      NOTE_ENGINE_KEEPALIVE_MS,
    );
    return () => clearTimeout(timer);
  }, [open]);

  // ---- 冲突裁决 / 被拒重试（共享 hook useNoteSyncActions，scope 定在
  // scratch；图片维度逻辑留本组件）/ 补图重试 ----
  const { resolveError, keepLocal, keepCloud, retryDenied } =
    useNoteSyncActions(session, {
      attemptId,
      questionId,
      phase: "scratch",
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
    <div data-slot="note-layer" className="flex min-w-0 flex-col gap-2">
      {/* 收起形态：标记按钮（有笔迹只显示标记——纸面隐藏不占布局） */}
      {!open && (
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
              <span className="text-muted-foreground">· {strokeCount} 笔</span>
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
      {open && (
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
      )}
      {open && (
        <NoteToolbar
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
          clearLabel="清空草稿纸"
          menuExtras={(Object.keys(LAYOUT_LABEL) as NoteLayoutPreference[]).map(
            (p) => (
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
            ),
          )}
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
          editor.localLoaded ? (
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
            />
          ) : (
            <div
              role="status"
              className="flex h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在打开草稿…
            </div>
          )
        ) : null}
      </div>

      {/* 四维状态区 + 冲突/被拒/补图面板（方案 §5.3：正交、可理解、可操作）。
          T6R.15：抽至共享 NoteStatusArea（CorrectionPanel 复用），本组件按
          草稿语境接线（label=草稿、图片维度开） */}
      {open && (
        <NoteStatusArea
          view={view}
          localLoaded={editor.localLoaded}
          label="草稿"
          images
          resolveError={resolveError}
          onKeepLocal={keepLocal}
          onKeepCloud={keepCloud}
          onRetryDenied={retryDenied}
          imageRetrying={imageRetrying}
          onRetryImages={retryImages}
        />
      )}

      {/* 清空二次确认（清空=空稿作为新正文版本保存——覆盖语义同 ink 通道） */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空草稿纸？</DialogTitle>
            <DialogDescription>
              将清除本题草稿的全部笔迹，清空后可用「撤销」恢复；已同步到服务端
              的旧版本不受影响。
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
    </div>
  );
}
