/**
 * 标注编辑工作区（T6R.20）：底图 img ＋ 笔迹画布同一 scale=displayWidth/baseWidth
 * 变换（方案 §10「底图和笔迹同坐标等比缩放」）。
 *
 * 挂载 gate（「没有可靠底图不能落墨」的前端闸门）：base 非 ready 不挂画布，
 * 由父层（AnnotationLayer）只显示状态/禁用原因；本组件只在 base ready 时
 * 渲染。笔迹引擎=annotation-surface（标注专用画布，引擎件全复用 ink engine）。
 * 工具条复用 NoteToolbar（笔/橡皮/撤销/更多——触控 ≥44px）。同步状态区
 * 精简为标注语境（本地落盘/同步/冲突/被拒）。
 */
import type { AnnotationBaseRef } from "@tutor/contract";
import { CircleAlert, LoaderCircle, PenLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index.ts";
import type { InkChangeReason } from "@/features/ink/engine/surface";
import {
  getSessionInputPreference,
  useSessionInputPreference,
} from "@/features/ink/input-preference";
import { NoteToolbar } from "@/features/notes/NoteToolbar";
import { studentAnnotationBasePngUrl } from "@/lib/api";
import {
  getAnnotationRecord,
  settleAnnotationPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "./annotation-surface";
import {
  resolveAnnotationConflictKeepLocalAndUpload,
  retryAnnotationUpload,
} from "./annotation-sync";
import {
  useAnnotationRecord,
  useAnnotationSessionRef,
} from "./use-annotation-record";

/**
 * 工作台实际消费的最小底图结构（不携带服务器身份字段——续画场景由本机
 * PNG 组装，禁止为 localBase 合成假 AnnotationBaseRef）。
 */
export interface AnnotationWorkspaceBase {
  pixelWidth: number;
  pixelHeight: number;
  downloadUrl: string;
}

/** 契约底图引用 → 工作台底图（ready 且像素宽高非空才可用）。downloadUrl 缺失时按 attemptId 直构学生直出路由（与服务端同源单源）。 */
export function annotationWorkspaceBaseOf(
  ref: AnnotationBaseRef,
  attemptId: string,
): AnnotationWorkspaceBase | null {
  if (
    ref.state !== "ready" ||
    ref.pixelWidth === null ||
    ref.pixelHeight === null
  ) {
    return null;
  }
  return {
    pixelWidth: ref.pixelWidth,
    pixelHeight: ref.pixelHeight,
    downloadUrl:
      ref.downloadUrl ?? studentAnnotationBasePngUrl(attemptId, ref.baseId),
  };
}

export interface AnnotationWorkspaceProps {
  attemptId: string;
  questionId: string;
  phase: "scratch" | "correction";
  /** 底图（像素宽高＝坐标域；downloadUrl 为底图 img src） */
  base: AnnotationWorkspaceBase;
  /** 无障碍标签前缀（拼「标注」） */
  ariaPrefix?: string;
}

export function AnnotationWorkspace({
  attemptId,
  questionId,
  phase,
  base,
  ariaPrefix = "本题",
}: AnnotationWorkspaceProps) {
  const session = useAnnotationSessionRef();
  const inputPreference = useSessionInputPreference();
  const record = useAnnotationRecord(attemptId, questionId, phase);
  const label = `${ariaPrefix}题干标注`;

  const surfaceRef = useRef<AnnotationSurface | null>(null);
  const coordinator = useAttemptEditor(null);
  useEffect(() => {
    if (phase !== "scratch") return;
    return coordinator?.register(questionId, async () => {
      surfaceRef.current?.finish();
      await settleAnnotationPersistence();
      if (session) {
        const saved = await getAnnotationRecord(session, {
          attemptId,
          questionId,
          phase,
        });
        if (saved?.local === "failed")
          throw new Error(saved.localError ?? "原标画本机保存失败");
      }
    });
  }, [coordinator?.register, session, attemptId, questionId, phase]);
  const surfaceHostRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [penColor, setPenColor] = useState<InkPenColor>("red");
  const [penSize, setPenSize] = useState<InkPenSize>("medium");
  const [historyTick, setHistoryTick] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);

  const baseWidth = base.pixelWidth;
  const baseHeight = base.pixelHeight;

  // 记录未载入（null）时显示加载态；docVersion 用于自写自载守卫
  const doc = record?.doc ?? null;
  const loadedDocVersion = useRef<number | null>(null);
  /** record 活引用（挂载 effect 只依赖「doc 就绪」布尔，不随每笔重挂引擎） */
  const recordRef = useRef(record);
  recordRef.current = record;
  const docReady = doc !== null;

  // 引擎挂载（base ready 后一次；localLoaded 后才挂——不在未恢复的纸面上起笔）。
  // 初始工具不在此设置：下方工具同步 effect 同轮提交后即刻下发
  useEffect(() => {
    const host = surfaceHostRef.current;
    if (host === null || session === null || !docReady) return;
    const initialDoc = recordRef.current?.doc;
    if (initialDoc == null) return;
    const surface = createAnnotationSurface({
      baseWidth,
      baseHeight,
      inputMode: getSessionInputPreference(),
    });
    surfaceRef.current = surface;
    surface.mount(host, initialDoc);
    loadedDocVersion.current = recordRef.current?.docVersion ?? null;
    surface.onChange((nextDoc, reason: InkChangeReason) => {
      if (reason === "load") return; // 载入恢复不算编辑（同 note 口径）
      loadedDocVersion.current = writeAnnotationDoc(
        session,
        { attemptId, questionId, phase },
        nextDoc,
      );
      setHistoryTick((t) => t + 1);
    });
    return () => {
      surface.destroy();
      surfaceRef.current = null;
      loadedDocVersion.current = null;
    };
  }, [session, attemptId, questionId, phase, baseWidth, baseHeight, docReady]);

  // 工具变化 → setTool（不重建引擎）
  useEffect(() => {
    if (!docReady) return;
    surfaceRef.current?.setInputMode(inputPreference);
    surfaceRef.current?.setTool(
      tool === "pen"
        ? { type: "pen", color: penColor, size: penSize }
        : { type: "eraser" },
    );
  }, [tool, penColor, penSize, inputPreference, docReady]);

  // 外部换稿守卫（自写自载）：docVersion 推进而非本引擎产物 → load 重放
  useEffect(() => {
    if (record === null || doc === null) return;
    const seen = loadedDocVersion.current;
    if (seen !== null && record.docVersion > seen) {
      surfaceRef.current?.load(doc);
    }
    loadedDocVersion.current = record.docVersion;
  }, [record, doc]);

  const canUndo = surfaceRef.current?.canUndo() ?? false;
  const canRedo = surfaceRef.current?.canRedo() ?? false;
  // historyTick 只为让撤销可用性重渲染（surface 是外部命令式对象）
  void historyTick;

  const strokeCount = doc?.strokes.length ?? 0;
  const server = record?.server ?? "synced";

  return (
    <div data-slot="annotation-workspace" className="flex flex-col gap-2">
      <NoteToolbar
        label={label}
        tool={tool}
        onToolChange={setTool}
        penColor={penColor}
        onPenColorChange={setPenColor}
        penSize={penSize}
        onPenSizeChange={setPenSize}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => surfaceRef.current?.undo()}
        onRedo={() => surfaceRef.current?.redo()}
        onClearRequest={() => setClearOpen(true)}
        clearLabel="清空标注"
        moreTitle="更多（重做/颜色/粗细/清空）"
      />

      {/* 底图 + 笔迹画布：同一盒（img 定尺寸，画布铺满其上——同 scale 变换） */}
      <div
        data-slot="annotation-base-wrap"
        className="relative w-full overflow-hidden rounded-lg border border-sky-200 bg-white outline outline-1 outline-sky-200"
      >
        <img
          src={base.downloadUrl}
          alt={`${label}底图`}
          className="block w-full select-none"
          draggable={false}
        />
        <div ref={surfaceHostRef} className="absolute inset-0" />
      </div>

      {/* 精简状态区（标注语境：同步/冲突/被拒） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <PenLine aria-hidden className="size-3.5" />
          {strokeCount > 0 ? `${strokeCount} 笔标注` : "在题干上圈画"}
        </span>
        {record?.local === "failed" && (
          <span className="flex items-center gap-1 text-amber-600">
            <CircleAlert aria-hidden className="size-3.5" />
            本机保存失败：{record.localError ?? "存储异常"}
          </span>
        )}
        {record !== null && server === "uploading" && (
          <span className="flex items-center gap-1">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            正在同步标注…
          </span>
        )}
        {record !== null && server === "dirty" && (
          <span>标注待同步（网络恢复后自动上传）</span>
        )}
        {record !== null && server === "denied" && (
          <span className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-400">
            <span>标注同步被拒：{record.denied?.reason ?? "请稍后重试"}</span>
            {record.denied?.kind === "access" && session !== null && (
              <Button
                variant="outline"
                className="h-9 px-2.5 text-xs"
                onClick={() =>
                  void retryAnnotationUpload(session, {
                    attemptId,
                    questionId,
                    phase,
                  })
                }
              >
                重试同步
              </Button>
            )}
          </span>
        )}
        {record !== null && server === "conflict" && (
          <span className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-400">
            <span>标注同步冲突：{record.conflict?.reason ?? "需要裁决"}</span>
            {session !== null && (
              <Button
                variant="outline"
                className="h-9 px-2.5 text-xs"
                onClick={() =>
                  void resolveAnnotationConflictKeepLocalAndUpload(session, {
                    attemptId,
                    questionId,
                    phase,
                  })
                }
              >
                以本机为准并重传
              </Button>
            )}
          </span>
        )}
      </div>

      {/* 清空二次确认（清空=空稿作为新版本上传——覆盖语义同草稿） */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空标注？</DialogTitle>
            <DialogDescription>
              将清除本题标注的全部笔迹，清空后可用「撤销」恢复；已同步到服务端的
              旧版本不受影响。
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
                surfaceRef.current?.clear();
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
