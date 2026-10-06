/**
 * 草稿原稿只读视图（T6R.11，方案 §6.5/§8）：学生结果页与教师作答详情/
 * 待批队列共用的「查看本次草稿原稿」入口。依据：docs/Phase6任务清单.md
 * T6R.11、docs/题目草稿功能方案.md §8（evidence 读端点与授权矩阵）。
 *
 * 硬性口径：
 * - **只按证据行定位原稿**：读 GET /attempts/:id/evidence/:qid（学生②/教师⑥
 *   宽松口径——软删题历史可读），frozen 才读 evidence.versionId 的版本文档；
 *   绝不按 qid 取最新工作稿替代本次原稿（工作稿头端点①严格口径也不调）；
 * - **只读**：不 PUT、不触碰 note/note_versions/submission_evidence 任何状态；
 *   唯一写动作是缺图时的补图恢复通道（recoverNoteImages——挂既定版本的
 *   派生图槽位，不改正文与提交引用）；
 * - **渲染复用确定性骨架**（renderNoteImages：整逻辑宽 1000 切片 + 入口级
 *   包围盒缓存 + 页间让出 + 离屏画布渲完即移除），绝不复用 NoteLayer 编辑
 *   状态机/IDB 写通道——布局/视口变化只做等比缩放，不裁切笔迹；
 * - 四态互斥（方案 §5.3）：无稿族文案见 note-original-phase 的 ABSENT_TEXT、
 *   正文待图（派生图 pending——不影响查看）、缺图（含「有正文无派生图行」
 *   的查看语境档位，→ 重建）、读取错误（→ 重试）。读取失败绝不隐藏成无稿；
 * - 判定与文案在纯函数层 note-original-phase.ts（互斥口径有独立单测），
 *   本组件只做 IO 与状态迁移；
 * - object URL 生命周期：landReady 单点维护（map 建 URL → urlsRef 赋值 →
 *   setPhase），重开/重试/收起/卸载即 revoke；epoch 代际守卫拦迟到结果。
 *   重展开缓存只存 {versionId, pages, strokeCount}（不常驻 NoteDoc，省每卡
 *   数 MB），重开仍拉证据头验证版本，同版本免下载免渲染。
 */

import {
  CircleAlert,
  LoaderCircle,
  NotebookPen,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { recoverNoteImages } from "@/features/notes/image-sync";
import { parseNoteDocOrThrow } from "@/features/notes/note-fixtures";
import {
  ABSENT_TEXT,
  type AbsentReason,
  type NoteOriginalReadyMeta,
  refreshImagesAggregate,
  resolveAbsentReason,
  resolveReadyMeta,
} from "@/features/notes/note-original-phase";
import {
  type RenderedNotePage,
  renderNoteImages,
} from "@/features/notes/render-note";
import type { NoteRole } from "@/lib/api";
import {
  fetchNoteDocumentApi,
  fetchNoteEvidenceApi,
} from "@/lib/note-endpoints";
import { formatCnTime } from "@/lib/time";

/** 面板阶段（单一判别联合：一次 set 完成迁移，无中间组合态） */
type OriginalPhase =
  /** 折叠态：只有入口按钮（点击前零请求） */
  | { kind: "closed" }
  | { kind: "loading" }
  /** 读取错误（证据行/正文/渲染失败）——不能隐藏成无稿 */
  | { kind: "error"; message: string }
  /** 无稿族：四态文案互斥（见 note-original-phase 的 ABSENT_TEXT） */
  | { kind: "absent"; reason: AbsentReason }
  | ({ kind: "ready"; urls: string[] } & NoteOriginalReadyMeta);

/** 重展开缓存：收起不清（blob 仍在内存），重开同版本免下载免渲染 */
interface OriginalCache {
  versionId: string;
  pages: RenderedNotePage[];
  strokeCount: number;
}

export function NoteOriginalView({
  viewer,
  attemptId,
  questionId,
  ariaPrefix = "本题",
  roundLabel = null,
}: {
  /** 查看角色（api 层 NoteRole：学生本人 / 教师域链授权） */
  viewer: NoteRole;
  attemptId: string;
  questionId: string;
  /** 无障碍标签前缀（如「第 3 题」），拼入按钮与图片 alt */
  ariaPrefix?: string;
  /** 轮次标注（attemptRoundLabel 产物）；null 不显示 */
  roundLabel?: string | null;
}) {
  const [phase, setPhase] = useState<OriginalPhase>({ kind: "closed" });
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  /** 加载代际：卸载/重试/收起后迟到的异步结果不再落地 */
  const epochRef = useRef(0);
  /** 在役 object URL（替换/收起/卸载时成批 revoke） */
  const urlsRef = useRef<string[]>([]);
  /** 最近一次就绪的渲染页与笔迹数（重展开缓存；卸载清空） */
  const cacheRef = useRef<OriginalCache | null>(null);

  const revokeUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  /** 就绪落地单点：URL 不变量（创建→登记→setPhase）只此一处维护 */
  const landReady = useCallback(
    (meta: NoteOriginalReadyMeta, pages: RenderedNotePage[]) => {
      const urls = pages.map((page) => URL.createObjectURL(page.blob));
      urlsRef.current = urls;
      setPhase({ kind: "ready", urls, ...meta });
    },
    [],
  );

  // 卸载回收：URL revoke 走同一原语；epoch 自增拦在途结果；缓存随组件释放
  useEffect(
    () => () => {
      epochRef.current += 1;
      cacheRef.current = null;
      revokeUrls();
    },
    [revokeUrls],
  );

  // 定位变化守卫（当前挂载全键控不可达，防御未来原位导航复用实例）：
  // attemptId/questionId/viewer 变化即回到折叠态并弃缓存（旧定位的渲染页
  // 与 URL 不能带入新题）
  const scopeRef = useRef({ attemptId, questionId, viewer });
  useEffect(() => {
    const prev = scopeRef.current;
    if (
      prev.attemptId === attemptId &&
      prev.questionId === questionId &&
      prev.viewer === viewer
    ) {
      return;
    }
    scopeRef.current = { attemptId, questionId, viewer };
    epochRef.current += 1;
    cacheRef.current = null;
    revokeUrls();
    setRebuildError(null);
    setRebuilding(false);
    setPhase({ kind: "closed" });
  }, [attemptId, questionId, viewer, revokeUrls]);

  const load = useCallback(async () => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    revokeUrls();
    setPhase({ kind: "loading" });
    try {
      // 证据头恒拉（便宜且验证版本归属）；无稿判定在纯函数层
      const head = await fetchNoteEvidenceApi(viewer, attemptId, questionId);
      if (epoch !== epochRef.current) return;
      const absent = resolveAbsentReason(head.evidence);
      if (absent !== null) {
        setPhase({ kind: "absent", reason: absent });
        return;
      }
      // frozen：契约 superRefine 保证 versionId 非空；空属数据异常（唯一
      // 防御点——landReady 内不再重复）
      const versionId = head.evidence?.versionId ?? null;
      if (versionId === null) {
        setPhase({ kind: "error", message: "证据行缺少版本引用（数据异常）" });
        return;
      }
      const cached = cacheRef.current;
      if (cached !== null && cached.versionId === versionId) {
        // 缓存命中：同版本免下载免渲染（blob 在缓存内未回收，URL 重建）
        const meta = resolveReadyMeta(head, cached.strokeCount);
        if (meta !== null) landReady(meta, cached.pages);
        return;
      }
      const raw = await fetchNoteDocumentApi(viewer, versionId);
      if (epoch !== epochRef.current) return;
      const doc = parseNoteDocOrThrow(raw, "草稿原稿正文", "，无法查看");
      // 确定性渲染走渲染骨架共用入口（renderNoteImages：入口级包围盒缓存 +
      // 页间显式 yieldToMain + 离屏画布渲完即移除）。取舍（复审裁决）：load 是
      // 单个 await，中途收起不中断渲染——有界浪费（离屏渲完即弃、epoch 守卫
      // 保证 URL 不落地，无泄漏），不加 abort 机制
      const pages = await renderNoteImages(doc, "analysis");
      if (epoch !== epochRef.current) return;
      cacheRef.current = {
        versionId,
        pages,
        strokeCount: doc.ink.strokes.length,
      };
      const meta = resolveReadyMeta(head, doc.ink.strokes.length);
      if (meta === null) return; // 契约外形态已在上方 versionId 防御点排除——理论不可达
      landReady(meta, pages);
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "网络异常",
      });
    }
  }, [attemptId, questionId, viewer, revokeUrls, landReady]);

  const close = useCallback(() => {
    epochRef.current += 1; // 在途加载作废（缓存保留供重展开）
    revokeUrls();
    setPhase({ kind: "closed" });
  }, [revokeUrls]);

  /**
   * 缺图重建：recoverNoteImages 自拉正文→渲染→上传，只挂既定版本（不改
   * 正文与提交引用；槽位幂等 upsert）。收起/卸载后上传继续执行是**设计
   * 行为**——补图是恢复通道不是编辑，幂等 upsert 重入安全，UI 落地由函数式
   * phase 判据拦截（不复活已回收 URL）。守卫不用代际比较：重建期间收起
   * 重开（同版本）后，迟到的档位刷新仍应生效——函数式判据
   * （ready 且 versionId 一致）既拦越权落地又不丢合法刷新。
   */
  const rebuild = useCallback(async () => {
    if (phase.kind !== "ready") return;
    const { versionId, strokeCount } = phase;
    setRebuilding(true);
    setRebuildError(null);
    try {
      await recoverNoteImages({ role: viewer, versionId });
      const head = await fetchNoteEvidenceApi(viewer, attemptId, questionId);
      setPhase((prev) => {
        if (prev.kind !== "ready" || prev.versionId !== versionId) return prev;
        const refreshed = refreshImagesAggregate(head, versionId, strokeCount);
        return refreshed === null ? prev : { ...prev, images: refreshed };
      });
    } catch (err) {
      console.warn("重建分析图片失败", err);
      setRebuildError("重建失败，请重试");
    } finally {
      setRebuilding(false);
    }
  }, [attemptId, phase, questionId, viewer]);

  const label = `${ariaPrefix}草稿原稿`;

  // ---- 折叠态：入口按钮（零请求；点击才拉证据行） ----
  if (phase.kind === "closed") {
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-fit"
        aria-label={`${ariaPrefix}查看草稿原稿`}
        onClick={() => void load()}
      >
        <NotebookPen aria-hidden className="size-4" />
        查看草稿原稿
      </Button>
    );
  }

  // ---- 展开态：面板 ----
  return (
    <div
      data-slot="note-original-view"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <NotebookPen aria-hidden className="size-4" />
          草稿原稿
        </p>
        {roundLabel !== null && (
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            {roundLabel}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          className="ml-auto h-11 px-2.5"
          aria-label={`收起${label}`}
          onClick={close}
        >
          收起
        </Button>
      </div>

      {phase.kind === "loading" && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          正在读取草稿原稿…
        </p>
      )}

      {phase.kind === "error" && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"
        >
          <p className="flex items-center gap-1.5">
            <CircleAlert
              aria-hidden
              className="size-4 shrink-0 text-destructive"
            />
            草稿原稿读取失败：{phase.message}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void load()}
          >
            <RotateCcw aria-hidden className="size-4" />
            重试
          </Button>
        </div>
      )}

      {phase.kind === "absent" && (
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
          {ABSENT_TEXT[phase.reason]}
        </p>
      )}

      {phase.kind === "ready" && (
        <>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>交卷时固定于 {formatCnTime(phase.recordedAt)}</span>
            {phase.noteRevision !== null && (
              <span>正文第 {phase.noteRevision} 次保存</span>
            )}
          </p>
          <div className="flex flex-col gap-2">
            {phase.urls.map((url, index) => (
              <img
                key={url}
                src={url}
                alt={`${label} 第 ${index + 1} 页`}
                className="w-full rounded-lg border border-border bg-white"
              />
            ))}
          </div>
          {phase.images === "pending" && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
              AI 分析图片待生成（不影响查看原稿）
            </p>
          )}
          {phase.images === "failed" && (
            <div
              role="status"
              className="flex flex-col items-start gap-1.5 text-xs text-muted-foreground"
            >
              <div className="flex flex-wrap items-center gap-2">
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                <span>AI 分析图片缺失（原稿查看不受影响）。</span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={rebuilding}
                  onClick={() => void rebuild()}
                >
                  {rebuilding ? "重建中…" : "重建分析图片"}
                </Button>
              </div>
              {rebuildError !== null && (
                <p role="alert" className="text-destructive">
                  {rebuildError}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
