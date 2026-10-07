/**
 * 草稿/订正/补充稿的同步状态区（T6R.15 单3 从 NoteLayer 抽出）：本地正文
 * （saving/saved/failed）、服务端正文（dirty/uploading/synced；conflict/
 * denied 走面板）、派生图片（仅 scratch 语境——订正/补充稿行不在任何 head
 * 图片投影里，查看走本地确定性渲染，无服务端图片语义）、本机落盘失败提示。
 * NoteLayer（答题页草稿纸）、CorrectionPanel（订正编辑器）与
 * CorrectionSection 的「补充稿同步状态」块（闸门修复 F3）共用——名词经
 * label 参数化（「草稿」/「订正」/「补充稿」），图片维度经 images 开关。
 *
 * **完整面板栈**（NoteLayer 复审④，随迁）：各维度并列展示、按
 * denied > conflict > images > 本机失败提示的优先级排序——本机落盘失败
 * 不提前 return 遮蔽同步面板（两件事同时成立时都得能看见、能操作）。
 *
 * **空稿（0 笔）不显示任何图片提示**（复审⑨定案）：无笔迹可渲染，派生图
 * 是无意义空白——不生成也不提示，避免空稿常态噪音；有笔后按四维口径
 * 如实显示。
 */

import { Button } from "@/components/ui/button";
import type { NoteRecordView } from "@/features/notes/note-store";

export interface NoteStatusAreaProps {
  /** 本地记录聚合视图（use-note-editor.view；未建/未载入为 null） */
  view: NoteRecordView | null;
  /** 本地记录装载完成（区分「尚未加载」与「无记录」） */
  localLoaded: boolean;
  /** 名词（「草稿」/「订正」/「补充稿」）——拼进各面板标题与状态文案 */
  label: string;
  /**
   * 是否展示派生图片维度与补图重试：scratch（NoteLayer）true；correction
   * （CorrectionPanel）false——订正查看走本地确定性渲染，无服务端图片语义
   */
  images: boolean;
  /** 冲突裁决失败信息（保留本机/云端动作的中文报错） */
  resolveError: string | null;
  onKeepLocal: () => void;
  onKeepCloud: () => void;
  onRetryDenied: () => void;
  /** 图片重试进行中（images=true 时消费） */
  imageRetrying?: boolean;
  onRetryImages?: () => void;
}

export function NoteStatusArea({
  view,
  localLoaded,
  label,
  images,
  resolveError,
  onKeepLocal,
  onKeepCloud,
  onRetryDenied,
  imageRetrying = false,
  onRetryImages,
}: NoteStatusAreaProps) {
  if (view === null) {
    return localLoaded ? null : (
      <p role="status" className="text-xs text-muted-foreground">
        {label}状态加载中…
      </p>
    );
  }
  const parts: string[] = [];
  // 本地维度（IDB 事务）
  if (view.local === "saving") parts.push("本机保存中…");
  // 服务端维度（同步队列视角；conflict/denied 走面板，不与文案混排）
  if (view.server === "uploading") parts.push("同步中…");
  else if (view.server === "dirty") parts.push("等待同步");
  // 图片维度（仅正文已同步且有笔迹时提示——派生任务不阻塞作答与交卷）
  const strokeCount = view.doc?.ink.strokes.length ?? 0;
  const imagesInformative =
    images && view.server === "synced" && strokeCount > 0;
  if (imagesInformative && view.overview.images === "pending") {
    parts.push("图片待生成");
  }
  const imagesFailed =
    imagesInformative &&
    (view.overview.images === "failed" || view.overview.images === "missing");

  return (
    <div className="flex flex-col gap-1.5">
      {parts.length > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {parts.join(" · ")}
        </p>
      )}
      {view.denied !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2.5 text-xs"
        >
          <p className="font-medium">
            {view.denied.kind === "access"
              ? `${label}已停止同步`
              : `${label}内容被拒`}
          </p>
          <p className="break-words text-muted-foreground">
            {view.denied.reason}
            {view.denied.kind === "content"
              ? "。继续书写产生新内容后会自动重试上传。"
              : `。本机${label}已保留，若权限恢复可重试同步。`}
          </p>
          {view.denied.kind === "access" && (
            <Button
              type="button"
              variant="outline"
              className="h-11 self-start"
              onClick={onRetryDenied}
            >
              重试同步
            </Button>
          )}
        </div>
      )}
      {view.conflict !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900"
        >
          <p className="font-medium">{label}内容冲突</p>
          <p className="break-words">{view.conflict.reason}</p>
          <p className="text-amber-700">
            本机与服务端各保留了一份{label}，请选择保留哪一份（未被保留的一份仍
            可在导出材料中找回）。
          </p>
          {resolveError !== null && (
            <p className="text-destructive">{resolveError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onKeepLocal}
            >
              保留本机内容
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onKeepCloud}
            >
              保留服务端内容
            </Button>
          </div>
        </div>
      )}
      {view.local === "failed" && (
        <p role="alert" className="text-xs text-destructive">
          本机保存失败：{view.localError ?? "存储不可用"}。可继续书写（内容暂存
          内存）；请检查设备存储空间，空间恢复后新笔迹会重新落盘。
        </p>
      )}
      {imagesFailed && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span>{label}图片未生成完整（正文已保存，不影响作答与交卷）。</span>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={imageRetrying}
            onClick={onRetryImages}
          >
            {imageRetrying ? "生成中…" : "重新生成图片"}
          </Button>
        </div>
      )}
    </div>
  );
}
