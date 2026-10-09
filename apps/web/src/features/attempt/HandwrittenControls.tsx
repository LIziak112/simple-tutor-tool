import type { StudentAnswer } from "@tutor/contract";
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Maximize,
  PenLine,
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
import { useEnabledCapabilities } from "@/features/capability/enabled-capabilities";
import {
  emptyAtramentDoc,
  type InkChangeReason,
  type InkDoc,
  type InkEngine,
} from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad";
import { fetchAttemptInkApi, studentInkPngUrl } from "@/lib/api";
import { mergeInkDocs } from "./draft-merge";
import { draftStore } from "./draft-store";
import { FinalAnswerInput } from "./FinalAnswerInput";
import { InkFullscreenLayer } from "./InkFullscreenLayer";
import { useDraftSyncContext } from "./use-draft-sync";
import {
  type InkUploadController,
  isInkDocEmpty,
  useInkUpload,
} from "./use-ink-upload";

/**
 * 手写题作答控件（T2.8，架构 §5.4「两种作答区 + 最终答案输入」）：
 *
 * - **展开手写区**（默认收起，节省首屏）：展开后内嵌 InkPad（Atrament 页内形态）；
 *   进入答题页已有笔迹（服务端 GET 命中且非空，或 T2.9 本地草稿较新）时自动展开
 *   并 load 对应 InkDoc；
 * - **全屏作答**：Excalidraw 全屏层（题干固定顶部）；
 * - **引擎切换策略**（任务报告「待决问题」第 2 条的实现答案）：
 *   每题同一时刻只有一份「权威笔迹」（masterDoc），权威引擎 = 最后书写的引擎。
 *   · atrament → 全屏：若页内已有笔迹，先确认「全屏使用新画布，页内笔迹将被替代」；
 *   · 全屏书写后：页内画布让位为占位卡（笔迹缩略 + 继续全屏），
 *     提供「清空并改用页内手写」（二次确认，同步上传空文档清掉服务端笔迹）；
 *   · 两种引擎的数据不合并（矢量格式互不相容），同题切换 = 覆盖，均有确认弹层；
 * - **上传时机**：每笔结束本地暂存 + 2 秒防抖 PUT；退出全屏即刻上传（引擎还热）；
 *   交卷前由页面统一 flush（见 StudentAssignmentAttemptPage）。
 * - **草稿防丢（T2.9）**：每笔结束同步写 IndexedDB（draftStore.saveInk，网络无关）；
 *   挂载时「服务端笔迹 × 本地笔迹」合并（updatedAt 新者胜），本地较新或服务端
 *   拉取失败且有本地笔迹 → resync 补传；同步回调联动顶栏三态（DraftSyncContext）。
 */

/** 笔迹文档的当前笔画数（atrament=strokes；excalidraw=scene.elements，口径同 ink 表） */
function inkStrokeCount(doc: InkDoc): number {
  return doc.engine === "atrament"
    ? doc.data.strokes.length
    : doc.data.scene.elements.length;
}

export interface HandwrittenControlsProps {
  attemptId: string;
  questionId: string;
  /** 脱敏后的题干（全屏层顶部固定展示） */
  stemMd: string;
  answer: StudentAnswer | undefined;
  onAnswer: (answer: StudentAnswer, defer: boolean) => void;
  /** 交卷 flush 用：controller 注册/注销（mount 注册、unmount 注销） */
  registerController?:
    | ((questionId: string, controller: InkUploadController | null) => void)
    | undefined;
  /**
   * 一批手写笔画结束时回调（当前总笔画数，T2.10 ink_stroke_batch 埋点）。
   * 缺省不触发——不影响 T2.8 既有行为与组件测试。
   */
  onInkStroke?: ((strokes: number) => void) | undefined;
  /**
   * 一次笔迹编辑操作回调（T4.0b ink_edit_batch 埋点）：reason 为 erase/undo/
   * redo/clear 之一（stroke 不算编辑；load 是引擎间笔迹移交，消费方须排除在
   * inkEditCount 外，§5.0-C14——本回调不转发 stroke/load）。缺省不触发。
   */
  onInkEdit?:
    | ((reason: "erase" | "undo" | "redo" | "clear") => void)
    | undefined;
  /**
   * 全屏进出回调（T4.0b ink_fullscreen 埋点）：fullscreen state 每次翻转
   * 触发一次（on=进入全屏 true / 退出 false）。缺省不触发。
   */
  onInkFullscreen?: ((on: boolean) => void) | undefined;
}

export function HandwrittenControls({
  attemptId,
  questionId,
  stemMd,
  answer,
  onAnswer,
  registerController,
  onInkStroke,
  onInkEdit,
  onInkFullscreen,
}: HandwrittenControlsProps) {
  /** 权威笔迹：undefined=服务端加载中；null=无笔迹；有值=当前文档 */
  const [masterDoc, setMasterDoc] = useState<InkDoc | null | undefined>(
    undefined,
  );
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** 从 atrament（有笔迹）切全屏的确认弹层 */
  const [confirmFullscreen, setConfirmFullscreen] = useState(false);
  /** 从 excalidraw 清空回页内手写的确认弹层 */
  const [confirmReset, setConfirmReset] = useState(false);
  /**
   * T7.7 手写辅助开关：关闭时隐藏「展开手写区/全屏作答」入口、不自动展开、
   * 已有笔迹只读查看（PNG）；最终答案输入始终保留（正式作答不受影响）。
   * 挂载期的笔迹合并/补传照常执行——开关不清数据不改提交规则。
   */
  const { ink: inkEnabled } = useEnabledCapabilities();

  /** 页内引擎与全屏引擎的 ref（上传导 PNG 时取当前激活的那个） */
  const pageEngineRef = useRef<InkEngine | null>(null);
  const fullscreenEngineRef = useRef<InkEngine | null>(null);
  /** 草稿同步联动（T2.9；题卡单测无 Provider 时为 null，各回调空值保护） */
  const draftSync = useDraftSyncContext();
  /** 联动对象存 ref：状态对象每次渲染都是新引用，挂载合并 effect 与
   *  handleDocChange 不因引用变化重建/重跑 */
  const draftSyncRef = useRef(draftSync);
  draftSyncRef.current = draftSync;

  // 上传状态机：engineGetter 取「当前激活引擎」（全屏开着用全屏引擎）
  const engineGetter = useCallback(
    () => (fullscreen ? fullscreenEngineRef.current : pageEngineRef.current),
    [fullscreen],
  );
  const {
    onDocChange: onDocChangeUpload,
    controller: uploadController,
    saveFailed,
    clearFailure,
  } = useInkUpload(attemptId, questionId, engineGetter, {
    onSynced: (doc) => {
      void draftStore.markInkSynced(attemptId, questionId, doc);
      draftSyncRef.current?.noteInkSynced();
    },
    onFailed: () => draftSyncRef.current?.noteSyncFailed(),
    onDenied: () => draftSyncRef.current?.noteDenied(),
  });
  /** 上传 controller 存 ref（controller 对象每次渲染都是新引用） */
  const controllerRef = useRef(uploadController);
  controllerRef.current = uploadController;

  // controller 注册（页面交卷 flush 收集）
  useEffect(() => {
    registerController?.(questionId, uploadController);
    return () => registerController?.(questionId, null);
  }, [questionId, uploadController, registerController]);

  // 笔迹变化：更新权威文档 + 写本地草稿仓（T2.9，网络无关）+ 进上传防抖
  // + T2.10/T4.0b 埋点（ink_stroke_batch 每笔/每批结束；ink_edit_batch 的
  // erase/undo/redo/clear 分型经 ref 取最新回调；load 不转发——引擎间移交
  // 不是编辑，§5.0-C14）
  const onInkStrokeRef = useRef(onInkStroke);
  onInkStrokeRef.current = onInkStroke;
  const onInkEditRef = useRef(onInkEdit);
  onInkEditRef.current = onInkEdit;
  const handleDocChange = useCallback(
    (doc: InkDoc, reason: InkChangeReason) => {
      setMasterDoc(doc);
      draftStore.saveInk(attemptId, questionId, doc);
      draftSyncRef.current?.noteLocalWrite();
      onDocChangeUpload(doc);
      if (
        reason === "erase" ||
        reason === "undo" ||
        reason === "redo" ||
        reason === "clear"
      ) {
        onInkEditRef.current?.(reason);
      } else {
        // stroke/load 维持旧笔画计数回调（ink_stroke_batch 语义不变；
        // 作答链路无 engine.load 调用，load 只在开发页/回放出现）
        onInkStrokeRef.current?.(inkStrokeCount(doc));
      }
    },
    [attemptId, questionId, onDocChangeUpload],
  );

  // 挂载时合并「服务端笔迹 × 本地草稿笔迹」（T2.9）：updatedAt 新者胜；
  // 本地较新（或服务端拉取失败但有本地）→ resync 补传；服务端胜 → 落本地并记指纹
  useEffect(() => {
    let alive = true;
    setMasterDoc(undefined);
    setExpanded(false);
    void (async () => {
      // 本地草稿与（可能失败的）服务端拉取并行；失败不阻塞答题
      const [localInk, fetched] = await Promise.all([
        draftStore
          .loadDraft(attemptId)
          .then((record) => record?.inks[questionId] ?? null)
          .catch(() => null),
        fetchAttemptInkApi(attemptId, questionId).then(
          (doc: InkDoc | null) => doc,
          (): undefined => undefined,
        ),
      ]);
      if (!alive) return;
      if (fetched === undefined) {
        // 服务端拉取失败（多为断网）：有本地笔迹则用本地并补传；无则按无笔迹处理
        if (localInk !== null) {
          setMasterDoc(localInk);
          if (inkEnabled && !isInkDocEmpty(localInk)) setExpanded(true);
          draftSyncRef.current?.noteLocalWrite();
          controllerRef.current.resync(localInk);
        } else {
          setMasterDoc(null);
        }
        return;
      }
      const merged = mergeInkDocs(localInk, fetched);
      if (merged.doc === null) {
        setMasterDoc(null);
        return;
      }
      setMasterDoc(merged.doc);
      if (inkEnabled && !isInkDocEmpty(merged.doc)) setExpanded(true);
      if (merged.source === "server") {
        // 服务端较新：内容落本地仓并记指纹（视为已同步）
        draftStore.saveInk(attemptId, questionId, merged.doc);
        void draftStore.markInkSynced(attemptId, questionId, merged.doc);
      } else if (merged.differs) {
        // 本地较新且内容不同：补传服务端
        draftSyncRef.current?.noteLocalWrite();
        controllerRef.current.resync(merged.doc);
      }
    })();
    return () => {
      alive = false;
    };
    // controller/draftSync 经 ref 取最新；只随题目标识与开关重跑（开关实际只随页面挂载而定）
  }, [attemptId, questionId, inkEnabled]);

  const finalAnswer = answer?.kind === "final" ? answer.finalAnswer : "";

  // T4.0b ink_fullscreen：挂现成 fullscreen state 的翻转处（§5.0-C14）——
  // 初始 false 不报（挂载即进入答题页不是全屏动作），此后每次进出各报一次
  const onInkFullscreenRef = useRef(onInkFullscreen);
  onInkFullscreenRef.current = onInkFullscreen;
  const fullscreenInitializedRef = useRef(false);
  useEffect(() => {
    if (!fullscreenInitializedRef.current) {
      fullscreenInitializedRef.current = true;
      return;
    }
    onInkFullscreenRef.current?.(fullscreen);
  }, [fullscreen]);

  /** 打开全屏：页内有笔迹（atrament）先确认覆盖；excalidraw 权威直接续写 */
  const openFullscreen = () => {
    if (
      masterDoc !== null &&
      masterDoc !== undefined &&
      masterDoc.engine === "atrament" &&
      !isInkDocEmpty(masterDoc)
    ) {
      setConfirmFullscreen(true);
      return;
    }
    setFullscreen(true);
  };

  /** 退出全屏：即刻触发一次上传（引擎实例还热），再卸载全屏层 */
  const closeFullscreen = () => {
    void uploadController.flush();
    setFullscreen(false);
  };

  /** 确认「清空并改用页内手写」：权威切回空 atrament 并立即上传覆盖服务端 */
  const confirmResetToPage = () => {
    const empty = emptyAtramentDoc();
    setMasterDoc(empty);
    handleDocChange(empty, "clear");
    setConfirmReset(false);
    setExpanded(true);
  };

  /** 权威引擎是否 excalidraw（页内画布让位占位卡） */
  const masterIsExcalidraw =
    masterDoc !== null &&
    masterDoc !== undefined &&
    masterDoc.engine === "excalidraw";

  // T7.7 ink 关闭：单一早退分支收敛全部回退渲染——无书写入口、已有笔迹只读
  // 查看、最终答案照常。挂载期合并/补传效果在上方照常执行（开关不清数据）；
  // expanded 状态无渲染消费者，effect 内的 setExpanded 无 UI 影响。
  if (!inkEnabled) {
    return (
      <div className="flex flex-col gap-3">
        {saveFailed && (
          <p className="text-xs text-destructive" role="status">
            笔迹保存失败（可能网络不稳），将继续自动重试，交卷前会再上传一次
          </p>
        )}
        {masterDoc !== undefined &&
          masterDoc !== null &&
          !isInkDocEmpty(masterDoc) && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm text-muted-foreground">
                老师未开启手写辅助，本题已有笔迹仅供查看。
              </p>
              <img
                src={studentInkPngUrl(attemptId, questionId)}
                alt="本题已有笔迹"
                loading="lazy"
                className="w-full rounded-md border border-border bg-white"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            </div>
          )}
        <FinalAnswerInput
          value={finalAnswer}
          onChange={(value) =>
            onAnswer({ kind: "final", finalAnswer: value }, true)
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 操作行：展开/收起 + 全屏 + 上传状态提示 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((prev) => !prev);
            clearFailure();
          }}
        >
          {expanded ? (
            <>
              <ChevronUp aria-hidden className="size-4" />
              收起手写区
            </>
          ) : (
            <>
              <ChevronDown aria-hidden className="size-4" />
              展开手写区
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={openFullscreen}
        >
          <Maximize aria-hidden className="size-4" />
          全屏作答
        </Button>
        {saveFailed && (
          <p className="text-xs text-destructive" role="status">
            笔迹保存失败（可能网络不稳），将继续自动重试，交卷前会再上传一次
          </p>
        )}
      </div>

      {/* 手写区（展开时）：atrament 页内画布 / excalidraw 占位卡 / 加载态 */}
      {expanded && (
        <>
          {masterDoc === undefined && (
            <p
              aria-live="polite"
              className="flex min-h-24 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在载入笔迹…
            </p>
          )}
          {masterDoc !== undefined && !masterIsExcalidraw && (
            <InkPad
              engine="atrament"
              initial={masterDoc ?? undefined}
              label="手写答题区"
              onDocChange={handleDocChange}
              engineRef={pageEngineRef}
            />
          )}{" "}
          {masterIsExcalidraw && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <PenLine aria-hidden className="size-4" />
                本题笔迹在全屏模式下创建（
                {masterDoc?.engine === "excalidraw"
                  ? `${masterDoc.data.scene.elements.length} 笔`
                  : ""}
                ），点上方「全屏作答」继续编辑
              </p>
              {/* 学生本人笔迹 PNG 直出（无笔迹/加载失败时隐藏） */}
              <img
                src={studentInkPngUrl(attemptId, questionId)}
                alt="本题笔迹预览"
                loading="lazy"
                className="w-full rounded-md border border-border bg-white"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-fit text-destructive"
                onClick={() => setConfirmReset(true)}
              >
                清空笔迹，改用页内手写
              </Button>
            </div>
          )}
        </>
      )}

      {/* 最终答案（普通输入 / 数学键盘，T2.6 输入框保留 + MathLive 切换） */}
      <FinalAnswerInput
        value={finalAnswer}
        onChange={(value) =>
          onAnswer({ kind: "final", finalAnswer: value }, true)
        }
      />

      {/* 全屏作答层（excalidraw；初始笔迹只在权威也是 excalidraw 时传入） */}
      {fullscreen && (
        <InkFullscreenLayer
          stemMd={stemMd}
          initial={masterIsExcalidraw ? (masterDoc ?? undefined) : undefined}
          onDocChange={handleDocChange}
          onClose={closeFullscreen}
          engineRef={fullscreenEngineRef}
        />
      )}

      {/* 引擎切换确认：页内 → 全屏（覆盖页内笔迹） */}
      <Dialog open={confirmFullscreen} onOpenChange={setConfirmFullscreen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>进入全屏作答？</DialogTitle>
            <DialogDescription>
              全屏模式使用另一套画布（适合长过程、画图）。进入后本题将以全屏笔迹为准，
              当前页内笔迹会被替代且无法找回。确定进入吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setConfirmFullscreen(false)}
            >
              留在页内
            </Button>
            <Button
              type="button"
              className="h-11"
              onClick={() => {
                setConfirmFullscreen(false);
                setFullscreen(true);
              }}
            >
              进入全屏
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 引擎切换确认：全屏 → 清空回页内 */}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空笔迹，改用页内手写？</DialogTitle>
            <DialogDescription>
              将删除本题的全屏笔迹（服务端同步清空），之后在页内答题区重新书写。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setConfirmReset(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              onClick={confirmResetToPage}
            >
              清空并改用页内
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
