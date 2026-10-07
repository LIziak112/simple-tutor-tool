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
 * - T6R.15（D）：「按 versionId 取正文→确定性渲染→展开」核心抽至
 *   use-note-version-view（与 NoteVersionView 共用）——重展开缓存、epoch
 *   守卫、object URL 生命周期随核搬家，本组件保留证据行定位/无稿判定/
 *   就绪元信息/缺图重建的编排。
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
import {
  ABSENT_TEXT,
  type AbsentReason,
  type NoteOriginalReadyMeta,
  refreshImagesAggregate,
  resolveAbsentReason,
  resolveReadyMeta,
} from "@/features/notes/note-original-phase";
import type { NoteRole } from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";
import { formatCnTime } from "@/lib/time";
import { useNoteVersionBody } from "./use-note-version-view";

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
  /** 正文渲染核（T6R.15 抽共享）：按 versionId 取正文→渲染→URL 落地 */
  const body = useNoteVersionBody(viewer);
  const { openBody, closeBody, resetBody } = body;
  /** 证据行段的加载代际：卸载/重试/收起后迟到的 head 结果不再落地 */
  const epochRef = useRef(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  // 卸载回收：正文核（URL/缓存/在途 epoch）由 useNoteVersionBody 自理；本
  // 组件只拦自己证据行段的迟到结果（phase 随组件卸载消亡）
  useEffect(() => {
    return () => {
      epochRef.current += 1;
    };
  }, []);

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
    resetBody();
    setRebuildError(null);
    setRebuilding(false);
    setPhase({ kind: "closed" });
  }, [attemptId, questionId, viewer, resetBody]);

  const load = useCallback(async () => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
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
      // 防御点——就绪元信息层不再重复）
      const versionId = head.evidence?.versionId ?? null;
      if (versionId === null) {
        setPhase({ kind: "error", message: "证据行缺少版本引用（数据异常）" });
        return;
      }
      // 正文段（含缓存命中/epoch 守卫/URL 生命周期）在共享核；stale 返回
      // null（期间被 close/reset 超越），失败抛错进本组件错误态
      const ready = await openBody(versionId);
      if (ready === null) return;
      if (epoch !== epochRef.current) return;
      const meta = resolveReadyMeta(head, ready.strokeCount);
      if (meta === null) return; // 契约外形态已在上方 versionId 防御点排除——理论不可达
      setPhase({ kind: "ready", urls: ready.urls, ...meta });
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "网络异常",
      });
    }
  }, [attemptId, questionId, viewer, openBody]);

  const close = useCallback(() => {
    epochRef.current += 1; // 在途加载作废（缓存保留供重展开）
    closeBody();
    setPhase({ kind: "closed" });
  }, [closeBody]);

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
