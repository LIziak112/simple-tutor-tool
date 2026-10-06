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
 * - **渲染复用确定性骨架**（planAnalysisPages + renderNotePage：整逻辑宽
 *   1000 切片、离屏画布渲完即移除），绝不复用 NoteLayer 编辑状态机/IDB
 *   写通道——布局/视口变化只做等比缩放，不裁切笔迹；
 * - 四态互斥（方案 §5.3）：无稿族（无行=未采集／none／missing／
 *   legacy_unverified 各自文案）、正文待图（派生图 pending——不影响查看）、
 *   缺图（failed/missing → 重建）、读取错误（→ 重试）。读取失败绝不隐藏成
 *   无稿文案；
 * - object URL 生命周期：重开/重试/收起/卸载即 revoke，多次查看无堆积
 *   （「教师连续查看 5 题无多画布堆积」同源保证：renderNotePage 离屏画布
 *   在 finally 移除）。
 */

import type { NoteImageMeta } from "@tutor/contract";
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
  planAnalysisPages,
  type RenderedNotePage,
  renderNotePage,
} from "@/features/notes/render-note";
import {
  fetchStudentNoteDocumentApi,
  fetchStudentNoteEvidenceApi,
  fetchTeacherNoteDocumentApi,
  fetchTeacherNoteEvidenceApi,
} from "@/lib/api";
import { formatCnTime } from "@/lib/time";

/** 查看角色：学生看本人（服务端 requireUsableAttempt 把门）/ 教师域链授权 */
export type NoteOriginalRole = "student" | "teacher";

/** 面板阶段（单一判别联合：一次 set 完成迁移，无中间组合态） */
type OriginalPhase =
  /** 折叠态：只有入口按钮（点击前零请求） */
  | { kind: "closed" }
  | { kind: "loading" }
  /** 读取错误（证据行/正文/渲染失败）——不能隐藏成无稿 */
  | { kind: "error"; message: string }
  /** 无稿族：四态文案互斥（见组件头注释） */
  | { kind: "absent"; reason: AbsentReason }
  | {
      kind: "ready";
      /** 渲染页的 object URL（生命周期由组件管理） */
      urls: string[];
      /** 生效版本（证据行 versionId；补图挂它） */
      versionId: string;
      /** 证据行记录时间（交卷事务固定时刻） */
      recordedAt: string;
      /** 正文保存次序（工作头与证据版本一致时可得；否则 null 不显示） */
      noteRevision: number | null;
      /** 正文笔迹数（空稿不显示派生图状态——imagesAggregateOf 口径） */
      strokeCount: number;
      /** 派生图聚合状态（ready=无提示） */
      images: "ready" | "pending" | "failed";
    };

type AbsentReason = "not-collected" | "none" | "missing" | "legacy-unverified";

const ABSENT_TEXT: Record<AbsentReason, string> = {
  "not-collected":
    "本次交卷没有采集到草稿（旧版本客户端交卷，或交卷时未上传草稿）。",
  none: "本题交卷时没有草稿（交卷确认了空稿）。",
  missing:
    "草稿未保存完整：交卷时草稿未能固定为原稿（已按「草稿未保存完整」记录），不是没有草稿。",
  "legacy-unverified":
    "恢复后的版本：这份草稿来自系统升级后的恢复，未验证与交卷时完全一致，暂不能作为原稿查看。",
};

/**
 * 派生图聚合状态：空稿（0 笔）不提示（无笔迹可渲染，派生图无意义——与
 * NoteLayer 四维状态区同口径）；有笔迹时空槽位/在途均按「待图」口径
 * （正文待图 ≠ 原稿未保存）。
 */
function imagesAggregateOf(images: NoteImageMeta[], strokeCount: number) {
  if (strokeCount === 0) return "ready" as const;
  if (images.length === 0) return "pending" as const;
  if (images.some((img) => img.state === "failed" || img.state === "missing")) {
    return "failed" as const;
  }
  if (images.some((img) => img.state === "pending")) {
    return "pending" as const;
  }
  return "ready" as const;
}

export function NoteOriginalView({
  viewer,
  attemptId,
  questionId,
  ariaPrefix = "本题",
  roundLabel = null,
}: {
  viewer: NoteOriginalRole;
  attemptId: string;
  questionId: string;
  /** 无障碍标签前缀（如「第 3 题」），拼入按钮与图片 alt */
  ariaPrefix?: string;
  /** 轮次标注（如「第 2 次课程练习」）；null 不显示 */
  roundLabel?: string | null;
}) {
  const [phase, setPhase] = useState<OriginalPhase>({ kind: "closed" });
  const [rebuilding, setRebuilding] = useState(false);
  /** 加载代际：卸载/重试/收起后迟到的异步结果不再落地 */
  const epochRef = useRef(0);
  /** 在役 object URL（替换/收起/卸载时成批 revoke） */
  const urlsRef = useRef<string[]>([]);

  const revokeUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  // 卸载回收（仅此一处 useEffect 清理；重开/收起在状态迁移点同步回收）
  useEffect(
    () => () => {
      epochRef.current += 1; // 迟到结果作废
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    },
    [],
  );

  const load = useCallback(async () => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    revokeUrls();
    setPhase({ kind: "loading" });
    try {
      const head =
        viewer === "student"
          ? await fetchStudentNoteEvidenceApi(attemptId, questionId)
          : await fetchTeacherNoteEvidenceApi(attemptId, questionId);
      if (epoch !== epochRef.current) return;
      const evidence = head.evidence;
      if (evidence === null) {
        setPhase({ kind: "absent", reason: "not-collected" });
        return;
      }
      if (evidence.state === "none") {
        setPhase({ kind: "absent", reason: "none" });
        return;
      }
      if (evidence.state === "missing") {
        setPhase({ kind: "absent", reason: "missing" });
        return;
      }
      if (evidence.state === "legacy_unverified") {
        setPhase({ kind: "absent", reason: "legacy-unverified" });
        return;
      }
      // frozen：读证据行指定的版本（不是工作头——交卷后原稿以证据行为准）
      const versionId = evidence.versionId;
      if (versionId === null) {
        // 契约 superRefine 保证 frozen 恒带 versionId；防御分支按损坏处理
        setPhase({
          kind: "error",
          message: "证据行缺少版本引用（数据异常）",
        });
        return;
      }
      const raw =
        viewer === "student"
          ? await fetchStudentNoteDocumentApi(versionId)
          : await fetchTeacherNoteDocumentApi(versionId);
      if (epoch !== epochRef.current) return;
      const doc = parseNoteDocOrThrow(raw, "草稿原稿正文", "，无法查看");
      // 确定性渲染（渲染骨架：整逻辑宽切片 + 离屏画布渲完即移除）；
      // 每页 await——页间自然让出主线程，长稿多页不阻塞交互
      const rendered: RenderedNotePage[] = [];
      for (const plan of planAnalysisPages(doc)) {
        rendered.push(await renderNotePage(doc, plan));
      }
      if (epoch !== epochRef.current) return;
      const urls = rendered.map((page) => URL.createObjectURL(page.blob));
      urlsRef.current = urls;
      setPhase({
        kind: "ready",
        urls,
        versionId,
        recordedAt: evidence.recordedAt,
        noteRevision:
          head.note !== null && head.note.currentVersionId === versionId
            ? head.note.revision
            : null,
        strokeCount: doc.ink.strokes.length,
        images: imagesAggregateOf(head.images, doc.ink.strokes.length),
      });
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "网络异常",
      });
    }
  }, [attemptId, questionId, viewer, revokeUrls]);

  const close = useCallback(() => {
    epochRef.current += 1; // 在途加载作废
    revokeUrls();
    setPhase({ kind: "closed" });
  }, [revokeUrls]);

  /** 缺图重建：补图只挂既定版本（不重渲染正文——原稿确定性不变），成功后
   * 仅刷新证据行的派生图状态。epoch 守卫：重建期间收起/重开会 bump 代际，
   * 迟到的状态刷新不得复活已被回收的 URL */
  const rebuild = useCallback(async () => {
    if (phase.kind !== "ready") return;
    const epochAtStart = epochRef.current;
    setRebuilding(true);
    try {
      await recoverNoteImages({ role: viewer, versionId: phase.versionId });
      const head =
        viewer === "student"
          ? await fetchStudentNoteEvidenceApi(attemptId, questionId)
          : await fetchTeacherNoteEvidenceApi(attemptId, questionId);
      if (epochAtStart !== epochRef.current) return;
      if (phase.kind !== "ready") return;
      setPhase({
        ...phase,
        images:
          head.evidence?.state === "frozen" &&
          head.evidence.versionId === phase.versionId
            ? imagesAggregateOf(head.images, phase.strokeCount)
            : phase.images,
      });
    } catch (err) {
      console.warn("重建分析图片失败（可再点重试）", err);
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
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            >
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
          )}
        </>
      )}
    </div>
  );
}
