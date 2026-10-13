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
import { PaperPresentation } from "@/features/ink/PaperPresentation";
import { useRetainedPaper } from "@/features/ink/use-retained-paper";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { fetchAttemptInkApi, studentInkPngUrl } from "@/lib/api";
import { useAttemptEditor } from "./AttemptEditorContext";
import { digestOf, mergeInkDocs } from "./draft-merge";
import { draftStore, getDraftPersistenceState } from "./draft-store";
import { FinalAnswerInput } from "./FinalAnswerInput";
import { useDraftSyncContext } from "./use-draft-sync";
import {
  type InkUploadController,
  isInkDocEmpty,
  useInkUpload,
} from "./use-ink-upload";

/**
 * 正式手写作答控制器：页内与全屏保持同一 Atrament 画布及撤销历史，
 * 历史 Excalidraw 场景继续可读可编辑，不自动转换或替换已有笔迹。
 * 每笔结束保存本机稿，2 秒防抖上传固定矢量及其派生 PNG；交卷 flush
 * 等待在途上传并追平最新稿，图片生成不依赖活画布。
 * 恢复先确认云端修订号，读取失败只展示本机稿并提供重试；跨设备修订
 * 冲突须显式裁决，不依赖设备时钟。收起保活到期且落盘成功才释放纸面。
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
  onInkPresenceChange?:
    | ((questionId: string, present: boolean) => void)
    | undefined;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  showExpandTrigger?: boolean;
  ariaPrefix?: string;
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
  onInkPresenceChange,
  expanded: controlledExpanded,
  onExpandedChange,
  showExpandTrigger = true,
  ariaPrefix = "本题",
}: HandwrittenControlsProps) {
  /** 权威笔迹：undefined=服务端加载中；null=无笔迹；有值=当前文档 */
  const [masterDoc, setMasterDoc] = useState<InkDoc | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (masterDoc !== undefined)
      onInkPresenceChange?.(
        questionId,
        masterDoc !== null && !isInkDocEmpty(masterDoc),
      );
  }, [masterDoc, questionId, onInkPresenceChange]);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const externallyControlled = controlledExpanded !== undefined;
  const setExpanded = useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(expanded) : next;
      if (controlledExpanded === undefined) setInternalExpanded(value);
      onExpandedChange?.(value);
    },
    [expanded, controlledExpanded, onExpandedChange],
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [legacyOpened, setLegacyOpened] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreRetry, setRestoreRetry] = useState(0);
  const [conflict, setConflict] = useState(false);
  const conflictChoice = useRef<"local" | "server" | null>(null);
  const baseRevision = useRef(0);
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
  /** 草稿同步联动（T2.9；题卡单测无 Provider 时为 null，各回调空值保护） */
  const draftSync = useDraftSyncContext();
  /** 联动对象存 ref：状态对象每次渲染都是新引用，挂载合并 effect 与
   *  handleDocChange 不因引用变化重建/重跑 */
  const draftSyncRef = useRef(draftSync);
  draftSyncRef.current = draftSync;

  // 上传状态机始终取同一纸面引擎，全屏只切换外框。
  const engineGetter = useCallback(() => pageEngineRef.current, []);
  const coordinator = useAttemptEditor(null);
  const finish = useCallback(async () => {
    engineGetter()?.finish?.();
    await draftStore.flush(attemptId);
    if (getDraftPersistenceState(attemptId) === "failed")
      throw new Error("手写作答本机保存失败，请保持页面打开并重试");
  }, [engineGetter, attemptId]);
  const paperAlive = useRetainedPaper(expanded || fullscreen, finish);
  useEffect(
    () => coordinator?.register(questionId, finish, "answerInk"),
    [coordinator?.register, questionId, finish],
  );
  const {
    onDocChange: onDocChangeUpload,
    controller: uploadController,
    saveFailed,
    clearFailure,
  } = useInkUpload(attemptId, questionId, {
    onSynced: (doc) => {
      baseRevision.current = doc.serverRevision ?? baseRevision.current + 1;
      void draftStore.markInkSynced(attemptId, questionId, doc);
      draftSyncRef.current?.noteInkSynced();
    },
    onFailed: () => draftSyncRef.current?.noteSyncFailed(),
    onDenied: () => draftSyncRef.current?.noteDenied(),
    onConflict: () => setConflict(true),
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
      if (reason === "load") return;
      doc = { ...doc, serverRevision: baseRevision.current };
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
        // 仅新书写计入笔画批次；load 已在入口排除，恢复不计成编辑。
        onInkStrokeRef.current?.(inkStrokeCount(doc));
      }
    },
    [attemptId, questionId, onDocChangeUpload],
  );

  // 恢复基线与本机稿：修订一致才可补传；云端已前进则保留两份并要求裁决。
  // biome-ignore lint/correctness/useExhaustiveDependencies(restoreRetry): 用户重试触发重新读取，不参与请求参数
  useEffect(() => {
    let alive = true;
    setMasterDoc(undefined);
    setRestoreFailed(false);
    setInternalExpanded(false);
    void (async () => {
      // 本地草稿与（可能失败的）服务端拉取并行；失败不阻塞答题
      const [initialLocalInk, fetched] = await Promise.all([
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
      let localInk = initialLocalInk;
      if (fetched !== undefined && localInk === null) {
        localInk =
          (await draftStore.recoverLegacyDraft(attemptId))?.inks[questionId] ??
          null;
        if (!alive) return;
      }
      if (fetched === undefined) {
        controllerRef.current.pause?.();
        // 云端读取失败时只回显本机稿，暂停编辑与上传，等待重试确认基线。
        if (localInk !== null) {
          setMasterDoc(localInk);
          if (inkEnabled && !externallyControlled && !isInkDocEmpty(localInk))
            setInternalExpanded(true);
          setRestoreFailed(true);
        } else {
          // 读取失败不代表云端无稿，保持画布未就绪，避免新稿覆盖原稿。
          setRestoreFailed(true);
        }
        return;
      }
      baseRevision.current = fetched?.serverRevision ?? (fetched ? 1 : 0);
      controllerRef.current.setBaseRevision?.(baseRevision.current);
      const choice = conflictChoice.current;
      conflictChoice.current = null;
      const sameBody =
        localInk &&
        fetched &&
        localInk.engine === fetched.engine &&
        digestOf(localInk.data) === digestOf(fetched.data);
      const needsChoice =
        localInk &&
        fetched?.serverRevision !== undefined &&
        !sameBody &&
        localInk.serverRevision !== fetched.serverRevision;
      if (needsChoice && choice === null) {
        controllerRef.current.pause?.();
        setMasterDoc(localInk);
        setConflict(true);
        return;
      }
      setConflict(false);
      if (choice === "local" && localInk) {
        const next = { ...localInk, serverRevision: baseRevision.current };
        setMasterDoc(next);
        draftStore.saveInk(attemptId, questionId, next);
        controllerRef.current.resync(next);
        return;
      }
      if (
        choice === "server" ||
        sameBody ||
        (fetched?.serverRevision !== undefined && !localInk)
      ) {
        setMasterDoc(fetched);
        if (fetched) {
          draftStore.saveInk(attemptId, questionId, fetched);
          await draftStore.markInkSynced(attemptId, questionId, fetched);
        }
        return;
      }
      if (
        localInk &&
        fetched?.serverRevision !== undefined &&
        localInk.serverRevision === fetched.serverRevision
      ) {
        setMasterDoc(localInk);
        controllerRef.current.resync(localInk);
        return;
      }
      const merged = mergeInkDocs(localInk, fetched);
      if (merged.doc === null) {
        setMasterDoc(null);
        return;
      }
      setMasterDoc(merged.doc);
      if (inkEnabled && !externallyControlled && !isInkDocEmpty(merged.doc))
        setInternalExpanded(true);
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
  }, [attemptId, questionId, inkEnabled, externallyControlled, restoreRetry]);

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

  /** 全屏只扩外框，不更换引擎或清空正文。 */
  const openFullscreen = () => {
    pageEngineRef.current?.finish?.();
    setExpanded(true);
    setLegacyOpened(true);
    setPaperError(null);
    setFullscreen(true);
  };

  /** 退出全屏先保存本机稿，再启动固定文档上传并切回页内外框。 */
  const closeFullscreen = async () => {
    try {
      await finish();
      void uploadController.flush();
      setFullscreen(false);
    } catch (cause) {
      setPaperError(
        cause instanceof Error ? cause.message : "本机手写保存失败，请重试",
      );
    }
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

  const recoveryStatus = (
    <>
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>云端笔迹已变化，本机稿已保留。请选择保留哪一份。</span>
          {(["local", "server"] as const).map((choice) => (
            <Button
              key={choice}
              type="button"
              variant="outline"
              onClick={() => {
                conflictChoice.current = choice;
                setRestoreRetry((value) => value + 1);
              }}
            >
              {choice === "local" ? "保留本机稿" : "使用云端稿"}
            </Button>
          ))}
        </div>
      )}
      {restoreFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>笔迹读取失败，请重试后继续手写；最终答案仍可填写。</span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRestoreRetry((value) => value + 1)}
          >
            重试读取笔迹
          </Button>
        </div>
      )}
    </>
  );

  // T7.7 ink 关闭：单一早退分支收敛全部回退渲染——无书写入口、已有笔迹只读
  // 查看、最终答案照常。挂载期合并/补传效果在上方照常执行（开关不清数据）；
  // expanded 状态无渲染消费者，effect 内的 setExpanded 无 UI 影响。
  if (!inkEnabled) {
    return (
      <div className="flex flex-col gap-3">
        {recoveryStatus}
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
        {showExpandTrigger && (
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
        )}
        {(showExpandTrigger || expanded) && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={openFullscreen}
          >
            <Maximize aria-hidden className="size-4" />
            全屏作答
          </Button>
        )}
        {saveFailed && (
          <p className="text-xs text-destructive" role="status">
            笔迹保存失败（可能网络不稳），将继续自动重试，交卷前会再上传一次
          </p>
        )}
      </div>

      {recoveryStatus}

      {/* 手写区（展开时）：atrament 页内画布 / excalidraw 占位卡 / 加载态 */}
      {paperAlive && (
        <div hidden={!expanded && !fullscreen}>
          <PaperPresentation
            fullscreen={fullscreen}
            label="全屏作答"
            heading={`${ariaPrefix}手写作答`}
            context={<RichMarkdown source={stemMd} />}
            onClose={closeFullscreen}
          >
            {paperError && (
              <p role="alert" className="text-sm text-destructive">
                {paperError}
              </p>
            )}
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
                inputEnabled={
                  (expanded || fullscreen) && !restoreFailed && !conflict
                }
                compactToolbar
                inputMode="session"
              />
            )}{" "}
            {masterIsExcalidraw && (
              <>
                {legacyOpened && (
                  <div hidden={!fullscreen}>
                    <InkPad
                      engine="excalidraw"
                      initial={masterDoc ?? undefined}
                      label="历史手写作答区"
                      onDocChange={handleDocChange}
                      engineRef={pageEngineRef}
                      inputEnabled={fullscreen && !restoreFailed && !conflict}
                      initialHeight={600}
                    />
                  </div>
                )}
                <div
                  hidden={fullscreen}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3"
                >
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
              </>
            )}
          </PaperPresentation>
        </div>
      )}

      {/* 最终答案（普通输入 / 数学键盘，T2.6 输入框保留 + MathLive 切换） */}
      <FinalAnswerInput
        value={finalAnswer}
        onChange={(value) =>
          onAnswer({ kind: "final", finalAnswer: value }, true)
        }
      />

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
