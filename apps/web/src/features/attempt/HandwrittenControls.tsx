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
import type { InkDoc, InkEngine } from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad";
import { fetchAttemptInkApi, studentInkPngUrl } from "@/lib/api";
import { FinalAnswerInput } from "./FinalAnswerInput";
import { InkFullscreenLayer } from "./InkFullscreenLayer";
import {
  type InkUploadController,
  isInkDocEmpty,
  useInkUpload,
} from "./use-ink-upload";

/**
 * 手写题作答控件（T2.8，架构 §5.4「两种作答区 + 最终答案输入」）：
 *
 * - **展开手写区**（默认收起，节省首屏）：展开后内嵌 InkPad（Atrament 页内形态）；
 *   进入答题页已有笔迹（服务端 GET 命中且非空）时自动展开并 load 服务端 InkDoc；
 * - **全屏作答**：Excalidraw 全屏层（题干固定顶部）；
 * - **引擎切换策略**（任务报告「待决问题」第 2 条的实现答案）：
 *   每题同一时刻只有一份「权威笔迹」（masterDoc），权威引擎 = 最后书写的引擎。
 *   · atrament → 全屏：若页内已有笔迹，先确认「全屏使用新画布，页内笔迹将被替代」；
 *   · 全屏书写后：页内画布让位为占位卡（笔迹缩略 + 继续全屏），
 *     提供「清空并改用页内手写」（二次确认，同步上传空文档清掉服务端笔迹）；
 *   · 两种引擎的数据不合并（矢量格式互不相容），同题切换 = 覆盖，均有确认弹层；
 * - **上传时机**：每笔结束本地暂存 + 2 秒防抖 PUT；退出全屏即刻上传（引擎还热）；
 *   交卷前由页面统一 flush（见 StudentAssignmentAttemptPage）。
 */

/** 空的 atrament 文档（「清空并改用页内手写」与无笔迹初始态共用） */
function emptyAtramentDoc(): InkDoc {
  return {
    engine: "atrament",
    version: 1,
    data: { width: 1000, strokes: [] },
    updatedAt: Date.now(),
  };
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
}

export function HandwrittenControls({
  attemptId,
  questionId,
  stemMd,
  answer,
  onAnswer,
  registerController,
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

  /** 页内引擎与全屏引擎的 ref（上传导 PNG 时取当前激活的那个） */
  const pageEngineRef = useRef<InkEngine | null>(null);
  const fullscreenEngineRef = useRef<InkEngine | null>(null);

  // 上传状态机：engineGetter 取「当前激活引擎」（全屏开着用全屏引擎）
  const engineGetter = useCallback(
    () => (fullscreen ? fullscreenEngineRef.current : pageEngineRef.current),
    [fullscreen],
  );
  const {
    onDocChange: onDocChangeUpload,
    controller,
    saveFailed,
    clearFailure,
  } = useInkUpload(attemptId, questionId, engineGetter);

  // controller 注册（页面交卷 flush 收集）
  useEffect(() => {
    registerController?.(questionId, controller);
    return () => registerController?.(questionId, null);
  }, [questionId, controller, registerController]);

  // 笔迹变化：更新权威文档 + 进上传防抖
  const handleDocChange = useCallback(
    (doc: InkDoc) => {
      setMasterDoc(doc);
      onDocChangeUpload(doc);
    },
    [onDocChangeUpload],
  );

  // 挂载时拉服务端笔迹：有笔迹（非空）自动展开
  useEffect(() => {
    let alive = true;
    setMasterDoc(undefined);
    setExpanded(false);
    void (async () => {
      try {
        const doc = await fetchAttemptInkApi(attemptId, questionId);
        if (!alive) return;
        setMasterDoc(doc);
        if (doc !== null && !isInkDocEmpty(doc)) setExpanded(true);
      } catch {
        // 加载失败不阻塞答题：按无笔迹处理（题卡内仍可展开手写），
        // 写下的新笔迹照常走防抖上传
        if (alive) setMasterDoc(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attemptId, questionId]);

  const finalAnswer = answer?.kind === "final" ? answer.finalAnswer : "";

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
    void controller.flush();
    setFullscreen(false);
  };

  /** 确认「清空并改用页内手写」：权威切回空 atrament 并立即上传覆盖服务端 */
  const confirmResetToPage = () => {
    const empty = emptyAtramentDoc();
    setMasterDoc(empty);
    handleDocChange(empty);
    setConfirmReset(false);
    setExpanded(true);
  };

  /** 权威引擎是否 excalidraw（页内画布让位占位卡） */
  const masterIsExcalidraw =
    masterDoc !== null &&
    masterDoc !== undefined &&
    masterDoc.engine === "excalidraw";

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
