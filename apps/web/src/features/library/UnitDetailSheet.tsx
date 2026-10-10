import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LibraryUnitSummary, LibraryUsage } from "@tutor/contract";
import {
  Download,
  Info,
  Loader2,
  Package,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { UsageSection } from "@/features/library/UsageSection";
import { PublishConfirmDialog } from "@/features/shared/PublishConfirmDialog";
import {
  downloadExportMd,
  downloadTeachingPack,
  type UnitMetaUpdate,
  updateUnitMetaApi,
} from "@/lib/api";
import { libraryFoldersKey } from "./library-queries";

/**
 * 单元详情面板（T2A.2）：改标题 / 主题 / 文件夹 / 配套讲义（D8）、使用情况、
 * 导出、发布到共享（T2B.7，D16 快照副本）、删除。注明「重新导入同 id 单元会用
 * 文件内容覆盖标题与主题」。未保存改动关闭时确认（§4-5）。
 */

/** 面板需要的下拉选项数据 */
export interface UnitDetailOptions {
  /** 全部文件夹（移动用；「未归类」为固定项） */
  folders: { id: string; name: string }[];
  /** 全部未删除讲义（配套讲义选择用） */
  lectures: { id: string; title: string }[];
}

export function UnitDetailSheet({
  unit,
  options,
  usage,
  usagePending,
  usageError,
  onDelete,
  onClose,
}: {
  unit: LibraryUnitSummary;
  options: UnitDetailOptions;
  usage: LibraryUsage | undefined;
  usagePending: boolean;
  usageError: string | null;
  onDelete: (unit: LibraryUnitSummary) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(unit.title);
  const [topic, setTopic] = useState(unit.topic ?? "");
  const [folderId, setFolderId] = useState<string>(unit.folderId ?? "none");
  const [lectureId, setLectureId] = useState<string>(unit.lectureId ?? "none");
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // 面板打开期间切换了单元或外部数据刷新 → 重置表单
  useEffect(() => {
    setTitle(unit.title);
    setTopic(unit.topic ?? "");
    setFolderId(unit.folderId ?? "none");
    setLectureId(unit.lectureId ?? "none");
    setError(null);
    setSavedHint(null);
    setConfirmClose(false);
  }, [unit.title, unit.topic, unit.folderId, unit.lectureId]);

  const dirty =
    title.trim() !== unit.title ||
    (topic.trim() || null) !== unit.topic ||
    (folderId === "none" ? null : folderId) !== unit.folderId ||
    (lectureId === "none" ? null : lectureId) !== unit.lectureId;

  const saveMutation = useMutation({
    mutationFn: () => {
      const request: UnitMetaUpdate = {
        title: title.trim(),
        topic: topic.trim().length > 0 ? topic.trim() : null,
        folderId: folderId === "none" ? null : folderId,
        lectureId: lectureId === "none" ? null : lectureId,
      };
      return updateUnitMetaApi(unit.id, request);
    },
    onSuccess: async () => {
      setError(null);
      setSavedHint("已保存");
      await queryClient.invalidateQueries({
        queryKey: ["teacher", "library"],
      });
      await queryClient.invalidateQueries({ queryKey: libraryFoldersKey });
      await queryClient.invalidateQueries({ queryKey: ["teacher", "content"] });
    },
    onError: (err) => {
      setSavedHint(null);
      setError(err instanceof Error ? err.message : "保存失败，请稍后重试");
    },
  });

  const exportMutation = useMutation({
    mutationFn: () => downloadExportMd("unit", unit.id),
    onSuccess: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "导出失败，请稍后重试"),
  });

  // T7.8：导出教学包 ZIP（content.md + 能力清单快照 + 随行图片；声明引用失效时
  // 服务端 422，message 已含首条明细）
  const exportPackMutation = useMutation({
    mutationFn: () => downloadTeachingPack("unit", unit.id),
    onSuccess: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "导出失败，请稍后重试"),
  });

  function requestClose(): void {
    if (dirty && saveMutation.isPending === false) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }

  const canSave = title.trim().length > 0 && !saveMutation.isPending;

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : requestClose())}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Settings2 aria-hidden className="size-4 text-muted-foreground" />
            单元信息
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {unit.id}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) saveMutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="unit-title" className="text-sm font-medium">
                标题
              </label>
              <Input
                id="unit-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setSavedHint(null);
                }}
                className="min-h-11"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="unit-topic" className="text-sm font-medium">
                主题
              </label>
              <Input
                id="unit-topic"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value);
                  setSavedHint(null);
                }}
                placeholder="如：有理数加减混合（留空 = 无主题）"
                className="min-h-11"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="unit-folder" className="text-sm font-medium">
                文件夹
              </label>
              <select
                id="unit-folder"
                value={folderId}
                onChange={(e) => {
                  setFolderId(e.target.value);
                  setSavedHint(null);
                }}
                className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="none">未归类</option>
                {options.folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="unit-lecture" className="text-sm font-medium">
                配套讲义
              </label>
              <select
                id="unit-lecture"
                value={lectureId}
                onChange={(e) => {
                  setLectureId(e.target.value);
                  setSavedHint(null);
                }}
                className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="none">无</option>
                {options.lectures.map((lecture) => (
                  <option key={lecture.id} value={lecture.id}>
                    {lecture.title}
                  </option>
                ))}
              </select>
            </div>

            <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              重新导入同 id 单元时，会用文件内容覆盖这里的标题与主题。
            </p>

            {error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {savedHint !== null ? (
              <p
                role="status"
                className="text-sm text-emerald-600 dark:text-emerald-400"
              >
                {savedHint}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                className="min-h-11 px-5"
                disabled={!canSave}
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 aria-hidden className="animate-spin" />
                    保存中…
                  </>
                ) : (
                  <>
                    <Save aria-hidden />
                    保存
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 px-4"
                onClick={requestClose}
                disabled={saveMutation.isPending}
              >
                关闭
              </Button>
            </div>
          </form>

          <section aria-label="使用情况" className="space-y-2">
            <h3 className="text-sm font-semibold">使用情况</h3>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <UsageSection
                usage={usage}
                pending={usagePending}
                error={usageError}
              />
            </div>
          </section>

          {confirmClose ? (
            <div
              role="alertdialog"
              aria-labelledby="unit-close-confirm-title"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm"
            >
              <p
                id="unit-close-confirm-title"
                className="font-medium text-destructive"
              >
                有未保存的修改
              </p>
              <p className="mt-1 text-muted-foreground">
                关闭后本次修改将丢失。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11 px-4"
                  onClick={onClose}
                >
                  不保存，关闭
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  onClick={() => setConfirmClose(false)}
                  autoFocus
                >
                  继续编辑
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            disabled={exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            {exportMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                导出中…
              </>
            ) : (
              <>
                <Download aria-hidden />
                导出 Markdown
              </>
            )}
          </Button>
          {/* T7.8：导出教学包（ZIP：正文 + 能力清单快照 + 随行图片，可整包分享/再导入） */}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-4"
            disabled={exportPackMutation.isPending}
            onClick={() => exportPackMutation.mutate()}
          >
            {exportPackMutation.isPending ? (
              <>
                <Loader2 aria-hidden className="animate-spin" />
                导出中…
              </>
            ) : (
              <>
                <Package aria-hidden />
                导出教学包
              </>
            )}
          </Button>
          {/* T2B.7：发布到共享目录（D16 快照副本；确认弹层说明快照语义） */}
          <PublishConfirmDialog kind="unit" id={unit.id} title={unit.title} />
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(unit)}
          >
            <Trash2 aria-hidden />
            从资源库删除
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
