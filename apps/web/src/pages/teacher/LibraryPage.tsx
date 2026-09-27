import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  LibraryLectureSummary,
  LibraryUnitSummary,
} from "@tutor/contract";
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Download,
  FileStack,
  FolderInput,
  PencilLine,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  LectureEditSheet,
  QuestionEditSheet,
} from "@/features/content/ContentEditSheet";
import {
  contentTreeKey,
  useContentTree,
} from "@/features/content/content-queries";
import { DeleteConfirmDialog } from "@/features/content/DeleteConfirmDialog";
import {
  type FolderSelection,
  FolderSidebar,
} from "@/features/library/FolderSidebar";
import {
  libraryFoldersKey,
  useLibraryFolders,
  useLibraryLectures,
  useLibraryUnits,
  useResourceUsage,
} from "@/features/library/library-queries";
import {
  ResourceDeleteDialog,
  type ResourceDeleteTarget,
} from "@/features/library/ResourceDeleteDialog";
import {
  type UnitDetailOptions,
  UnitDetailSheet,
} from "@/features/library/UnitDetailSheet";
import { UnitQuestionTable } from "@/features/library/UnitQuestionTable";
import {
  batchLibraryApi,
  deleteLectureApi,
  deleteQuestionApi,
  deleteUnitApi,
  downloadExportMd,
  purgeLectureApi,
  purgeUnitApi,
  restoreLectureApi,
  restoreUnitApi,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/time";

/**
 * /t/library 资源库页面（T2A.2）：页签（讲义库 / 题库 / 回收站）+ 左侧文件夹栏 +
 * 列表多选批量操作 + 搜索（前端即时过滤）+ 单元展开题目摘要（编辑抽屉 / 软删 /
 * 单元内拖拽排序复用）+ 单元详情面板（改标题/topic/文件夹/配套讲义、使用情况、
 * 导出、删除）。删除确认弹层列出使用情况（D3）；删除类 toast 带「撤销」（§4-6）。
 */

type TabKey = "lectures" | "units" | "recycle";

const TABS: { key: TabKey; label: string; icon: typeof BookOpen }[] = [
  { key: "lectures", label: "讲义库", icon: BookOpen },
  { key: "units", label: "题库", icon: FileStack },
  { key: "recycle", label: "回收站", icon: Trash2 },
];

/** 撤销窗口（§4-6：删除类 toast 的「撤销」5 秒内可点） */
const UNDO_WINDOW_MS = 5000;

/** 导入成功提示条的自动收起延时 */
const BANNER_AUTO_DISMISS_MS = 6000;

/** location.state 的已知形态（导入成功跳转携带） */
interface LibraryLocationState {
  importSuccess?: string;
}

/** 待撤销的删除（toast 附带恢复动作） */
interface UndoableAction {
  message: string;
  undo: () => Promise<void>;
}

/** 批量目标选择弹层 */
interface BatchMoveTarget {
  kind: "lecture" | "unit";
  ids: string[];
}

interface BatchCourseTarget {
  kind: "lecture" | "unit";
  ids: string[];
}

export function LibraryPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const importSuccess = (location.state as LibraryLocationState | null)
    ?.importSuccess;
  const [bannerVisible, setBannerVisible] = useState(
    importSuccess !== undefined,
  );
  const [tab, setTab] = useState<TabKey>("units");
  const [folder, setFolder] = useState<FolderSelection>(undefined);
  const [search, setSearch] = useState("");
  // 多选（分 kind 独立；全选当前筛选结果，§4-2）
  const [selectedLectures, setSelectedLectures] = useState<Set<string>>(
    new Set(),
  );
  const [selectedUnits, setSelectedUnits] = useState<Set<string>>(new Set());
  // 弹层与抽屉
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(
    null,
  );
  const [editingLectureId, setEditingLectureId] = useState<string | null>(null);
  const [detailUnitId, setDetailUnitId] = useState<string | null>(null);
  const [deletingQuestion, setDeletingQuestion] = useState<{
    id: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<ResourceDeleteTarget | null>(null);
  const [purging, setPurging] = useState<ResourceDeleteTarget | null>(null);
  const [batchMove, setBatchMove] = useState<BatchMoveTarget | null>(null);
  const [batchCourse, setBatchCourse] = useState<BatchCourseTarget | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<UndoableAction | null>(null);

  const isRecycle = tab === "recycle";
  const listParams = useMemo(
    () => ({
      folderId: folder === undefined ? undefined : folder,
      deleted: isRecycle === false ? undefined : true,
    }),
    [folder, isRecycle],
  );

  const foldersQuery = useLibraryFolders();
  const lecturesQuery = useLibraryLectures(listParams);
  const unitsQuery = useLibraryUnits(listParams);

  // 前端即时过滤（§4-3：标题 / 单元 id / topic / 考点）
  const keyword = search.trim().toLowerCase();
  const lectures = (lecturesQuery.data?.lectures ?? []).filter((l) =>
    keyword.length === 0 ? true : l.title.toLowerCase().includes(keyword),
  );
  const units = (unitsQuery.data?.units ?? []).filter((u) =>
    keyword.length === 0
      ? true
      : u.title.toLowerCase().includes(keyword) ||
        u.id.toLowerCase().includes(keyword) ||
        (u.topic?.toLowerCase().includes(keyword) ?? false) ||
        u.knowledge.some((name) => name.toLowerCase().includes(keyword)),
  );

  // 「未归类」与「全部」的计数（文件夹栏虚拟项）
  const allLectures = useLibraryLectures({ deleted: false });
  const allUnits = useLibraryUnits({ deleted: false });
  const uncategorized = {
    lectures: (allLectures.data?.lectures ?? []).filter(
      (l) => l.folderId === null,
    ).length,
    units: (allUnits.data?.units ?? []).filter((u) => u.folderId === null)
      .length,
  };
  const totalCount = {
    lectures: allLectures.data?.lectures.length ?? 0,
    units: allUnits.data?.units.length ?? 0,
  };

  const detailUnit = units.find((u) => u.id === detailUnitId) ?? null;
  const detailUsage = useResourceUsage(
    "unit",
    detailUnitId !== null ? detailUnitId : null,
  );
  const deleteUsage = useResourceUsage(
    deleting?.kind ?? "unit",
    deleting !== null ? deleting.id : null,
  );
  const purgeUsage = useResourceUsage(
    purging?.kind ?? "unit",
    purging !== null ? purging.id : null,
  );

  const invalidateAll = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
    await queryClient.invalidateQueries({ queryKey: libraryFoldersKey });
    await queryClient.invalidateQueries({ queryKey: contentTreeKey });
  };

  /** 删除类 toast：带撤销（§4-6） */
  function showUndoable(message: string, undo: () => Promise<unknown>): void {
    const undoAction = async (): Promise<void> => {
      await undo();
    };
    setUndoable({ message, undo: undoAction });
    setTimeout(() => {
      setUndoable((current) => (current?.undo === undoAction ? null : current));
    }, UNDO_WINDOW_MS);
  }

  const mutationOptions = {
    onError: (err: unknown) => {
      setActionError(
        err instanceof Error ? err.message : "操作失败，请稍后重试",
      );
    },
  };

  // ---------- 单项删除 / 恢复 / 彻底删除 ----------

  const softDeleteMutation = useMutation({
    mutationFn: (target: ResourceDeleteTarget) =>
      target.kind === "unit"
        ? deleteUnitApi(target.id)
        : deleteLectureApi(target.id),
    onSuccess: async (_data, target) => {
      setDeleting(null);
      await invalidateAll();
      showUndoable(
        `已删除${target.kind === "unit" ? "单元" : "讲义"}「${target.name}」（可在回收站恢复）`,
        () =>
          target.kind === "unit"
            ? restoreUnitApi(target.id)
            : restoreLectureApi(target.id),
      );
    },
    ...mutationOptions,
  });

  const restoreMutation = useMutation({
    mutationFn: (target: ResourceDeleteTarget) =>
      target.kind === "unit"
        ? restoreUnitApi(target.id)
        : restoreLectureApi(target.id),
    onSuccess: async () => {
      await invalidateAll();
    },
    ...mutationOptions,
  });

  const purgeMutation = useMutation({
    mutationFn: (target: ResourceDeleteTarget) =>
      target.kind === "unit"
        ? purgeUnitApi(target.id)
        : purgeLectureApi(target.id),
    onSuccess: async () => {
      setPurging(null);
      await invalidateAll();
    },
    onError: (err) => {
      setPurging(null);
      setActionError(
        err instanceof Error ? err.message : "彻底删除失败，请稍后重试",
      );
    },
  });

  const questionDeleteMutation = useMutation({
    mutationFn: (id: string) => deleteQuestionApi(id),
    onSuccess: async () => {
      setDeletingQuestion(null);
      await invalidateAll();
    },
    ...mutationOptions,
  });

  // ---------- 批量操作 ----------

  const batchMutation = useMutation({
    // 只透传请求体（TanStack Query v5 会额外传 context 作为第二参数）
    mutationFn: (request: Parameters<typeof batchLibraryApi>[0]) =>
      batchLibraryApi(request),
    onSuccess: async (data) => {
      setBatchMove(null);
      setBatchCourse(null);
      const failed = data.results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionError(
          `${failed.length} 项操作失败：${failed[0]?.message ?? "请稍后重试"}`,
        );
      }
      await invalidateAll();
    },
    ...mutationOptions,
  });

  function toggleSelect(
    set: Set<string>,
    setter: (next: Set<string>) => void,
    id: string,
  ): void {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  function selectAllLectures(): void {
    setSelectedLectures(
      selectedLectures.size === lectures.length
        ? new Set()
        : new Set(lectures.map((l) => l.id)),
    );
  }

  function selectAllUnits(): void {
    setSelectedUnits(
      selectedUnits.size === units.length
        ? new Set()
        : new Set(units.map((u) => u.id)),
    );
  }

  const folderOptions: UnitDetailOptions = {
    folders: (foldersQuery.data?.folders ?? []).map((f) => ({
      id: f.id,
      name: f.name,
    })),
    lectures: (allLectures.data?.lectures ?? []).map((l) => ({
      id: l.id,
      title: l.title,
    })),
  };

  // 导入成功提示条 6 秒后自动收起
  useEffect(() => {
    if (importSuccess === undefined) return;
    const timer = setTimeout(
      () => setBannerVisible(false),
      BANNER_AUTO_DISMISS_MS,
    );
    return () => clearTimeout(timer);
  }, [importSuccess]);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">资源库</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            讲义库与题库：导入的内容都在这里，按文件夹组织，供课程与作业引用
          </p>
        </div>
        <Button asChild className="min-h-11 px-4">
          <Link to="/t/import">
            <Upload aria-hidden />
            导入内容
          </Link>
        </Button>
      </header>

      {/* 导入成功提示条（ImportPage 跳转携带，6 秒自动收起） */}
      {bannerVisible && importSuccess !== undefined ? (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span className="min-w-0 flex-1 break-all">{importSuccess}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              setBannerVisible(false);
              navigate(location.pathname, { replace: true, state: null });
            }}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-emerald-500/10 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      ) : null}

      {/* 页签（讲义库 / 题库 / 回收站） */}
      <div
        role="tablist"
        aria-label="资源库分区"
        className="mt-4 flex flex-wrap gap-1"
      >
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setSelectedLectures(new Set());
              setSelectedUnits(new Set());
            }}
            className={`flex min-h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 ${
              tab === key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {/* 操作提示条（错误 / 删除类 toast + 撤销） */}
      {actionError !== null ? (
        <p
          role="alert"
          className="mt-4 flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-all">{actionError}</span>
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
            className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-destructive/10"
          >
            <X aria-hidden className="size-4" />
          </button>
        </p>
      ) : null}
      {undoable !== null ? (
        <p
          role="status"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <span className="min-w-0 flex-1 break-all">{undoable.message}</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-9 px-3"
            onClick={() => {
              const action = undoable;
              setUndoable(null);
              void action
                .undo()
                .then(invalidateAll)
                .catch(() => {
                  setActionError("撤销失败，可在回收站中手动恢复");
                });
            }}
          >
            <RotateCcw aria-hidden />
            撤销
          </Button>
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-5 md:flex-row">
        {/* 左侧文件夹栏（回收站页签不显示：回收站不按文件夹组织） */}
        {!isRecycle ? (
          <FolderSidebar
            folders={foldersQuery.data?.folders ?? []}
            pending={foldersQuery.isPending}
            error={
              foldersQuery.isError
                ? foldersQuery.error instanceof Error
                  ? foldersQuery.error.message
                  : "网络异常，请稍后重试"
                : null
            }
            selected={folder}
            onSelect={setFolder}
            onRetry={() => void foldersQuery.refetch()}
            uncategorizedCount={uncategorized}
            totalCount={totalCount}
            onActionError={setActionError}
          />
        ) : null}

        <div className="min-w-0 flex-1">
          {/* 搜索框（前端即时过滤） */}
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题 / 单元 id / 主题 / 考点"
              aria-label="搜索资源库"
              className="min-h-11 pl-9"
            />
          </div>

          {isRecycle ? (
            <RecycleView
              lecturesPending={lecturesQuery.isPending}
              unitsPending={unitsQuery.isPending}
              lecturesError={
                lecturesQuery.isError
                  ? lecturesQuery.error instanceof Error
                    ? lecturesQuery.error.message
                    : "网络异常"
                  : null
              }
              unitsError={
                unitsQuery.isError
                  ? unitsQuery.error instanceof Error
                    ? unitsQuery.error.message
                    : "网络异常"
                  : null
              }
              lectures={lectures}
              units={units}
              onRetry={() => {
                void lecturesQuery.refetch();
                void unitsQuery.refetch();
              }}
              onRestore={(target) => restoreMutation.mutate(target)}
              onPurge={(target) => setPurging(target)}
            />
          ) : tab === "lectures" ? (
            <LectureListView
              pending={lecturesQuery.isPending}
              error={
                lecturesQuery.isError
                  ? lecturesQuery.error instanceof Error
                    ? lecturesQuery.error.message
                    : "网络异常"
                  : null
              }
              lectures={lectures}
              selected={selectedLectures}
              onSelectAll={selectAllLectures}
              onToggle={(id) =>
                toggleSelect(selectedLectures, setSelectedLectures, id)
              }
              onRetry={() => void lecturesQuery.refetch()}
              onEdit={(id) => setEditingLectureId(id)}
              onExport={(id) =>
                downloadExportMd("lecture", id).catch((err: unknown) =>
                  setActionError(
                    err instanceof Error ? err.message : "导出失败，请稍后重试",
                  ),
                )
              }
              onDelete={(lecture) =>
                setDeleting({
                  kind: "lecture",
                  id: lecture.id,
                  name: lecture.title,
                })
              }
              onBatchMove={() =>
                setBatchMove({ kind: "lecture", ids: [...selectedLectures] })
              }
              onBatchDelete={() =>
                batchMutation.mutate({
                  action: "delete",
                  kind: "lecture",
                  ids: [...selectedLectures],
                })
              }
              onBatchCourse={() =>
                setBatchCourse({ kind: "lecture", ids: [...selectedLectures] })
              }
            />
          ) : (
            <UnitListView
              pending={unitsQuery.isPending}
              error={
                unitsQuery.isError
                  ? unitsQuery.error instanceof Error
                    ? unitsQuery.error.message
                    : "网络异常"
                  : null
              }
              units={units}
              selected={selectedUnits}
              onSelectAll={selectAllUnits}
              onToggle={(id) =>
                toggleSelect(selectedUnits, setSelectedUnits, id)
              }
              onRetry={() => void unitsQuery.refetch()}
              onOpenDetail={(id) => setDetailUnitId(id)}
              onExport={(id) =>
                downloadExportMd("unit", id).catch((err: unknown) =>
                  setActionError(
                    err instanceof Error ? err.message : "导出失败，请稍后重试",
                  ),
                )
              }
              onDelete={(unit) =>
                setDeleting({ kind: "unit", id: unit.id, name: unit.title })
              }
              onEditQuestion={setEditingQuestionId}
              onDeleteQuestion={(id) => setDeletingQuestion({ id })}
              onBatchMove={() =>
                setBatchMove({ kind: "unit", ids: [...selectedUnits] })
              }
              onBatchDelete={() =>
                batchMutation.mutate({
                  action: "delete",
                  kind: "unit",
                  ids: [...selectedUnits],
                })
              }
              onBatchCourse={() =>
                setBatchCourse({ kind: "unit", ids: [...selectedUnits] })
              }
            />
          )}
        </div>
      </div>

      {/* ---------- 弹层与抽屉（同一时刻至多一个主要弹层） ---------- */}
      {editingQuestionId !== null ? (
        <QuestionEditSheet
          questionId={editingQuestionId}
          onClose={() => setEditingQuestionId(null)}
        />
      ) : null}
      {editingLectureId !== null ? (
        <LectureEditSheet
          lectureId={editingLectureId}
          onClose={() => setEditingLectureId(null)}
        />
      ) : null}
      {detailUnit !== null ? (
        <UnitDetailSheet
          unit={detailUnit}
          options={folderOptions}
          usage={detailUsage.data}
          usagePending={detailUsage.isPending}
          usageError={
            detailUsage.isError
              ? detailUsage.error instanceof Error
                ? detailUsage.error.message
                : "使用情况加载失败"
              : null
          }
          onDelete={(unit) => {
            setDetailUnitId(null);
            setDeleting({ kind: "unit", id: unit.id, name: unit.title });
          }}
          onClose={() => setDetailUnitId(null)}
        />
      ) : null}
      {deleting !== null ? (
        <ResourceDeleteDialog
          target={deleting}
          mode="soft"
          usage={deleteUsage.data}
          usagePending={deleteUsage.isPending}
          usageError={
            deleteUsage.isError
              ? deleteUsage.error instanceof Error
                ? deleteUsage.error.message
                : "使用情况加载失败"
              : null
          }
          pending={softDeleteMutation.isPending}
          error={
            softDeleteMutation.isError
              ? softDeleteMutation.error instanceof Error
                ? softDeleteMutation.error.message
                : "删除失败，请稍后重试"
              : null
          }
          onConfirm={() => softDeleteMutation.mutate(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
      {purging !== null ? (
        <ResourceDeleteDialog
          target={purging}
          mode="purge"
          usage={purgeUsage.data}
          usagePending={purgeUsage.isPending}
          usageError={
            purgeUsage.isError
              ? purgeUsage.error instanceof Error
                ? purgeUsage.error.message
                : "使用情况加载失败"
              : null
          }
          pending={purgeMutation.isPending}
          error={
            purgeMutation.isError
              ? purgeMutation.error instanceof Error
                ? purgeMutation.error.message
                : "彻底删除失败，请稍后重试"
              : null
          }
          onConfirm={() => purgeMutation.mutate(purging)}
          onCancel={() => setPurging(null)}
        />
      ) : null}
      {deletingQuestion !== null ? (
        <DeleteConfirmDialog
          title="删除题目"
          targetName={deletingQuestion.id}
          description="删除后该题不再出现在单元中。题目为软删除：历史作答与统计保留，重新导入包含该题的文档即可恢复。"
          pending={questionDeleteMutation.isPending}
          onConfirm={() => questionDeleteMutation.mutate(deletingQuestion.id)}
          onCancel={() => setDeletingQuestion(null)}
        />
      ) : null}
      {batchMove !== null ? (
        <BatchMoveDialog
          folders={folderOptions.folders}
          pending={batchMutation.isPending}
          onCancel={() => setBatchMove(null)}
          onConfirm={(folderId) =>
            batchMutation.mutate({
              action: "move",
              kind: batchMove.kind,
              ids: batchMove.ids,
              folderId,
            })
          }
        />
      ) : null}
      {batchCourse !== null ? (
        <BatchCourseDialog
          kind={batchCourse.kind}
          ids={batchCourse.ids}
          pending={batchMutation.isPending}
          onCancel={() => setBatchCourse(null)}
          onConfirm={(courseId, visible) =>
            batchMutation.mutate({
              action: "addToCourse",
              kind: batchCourse.kind,
              ids: batchCourse.ids,
              courseId,
              visible,
            })
          }
        />
      ) : null}
    </section>
  );
}

// ---------- 讲义库列表 ----------

function LectureListView({
  pending,
  error,
  lectures,
  selected,
  onSelectAll,
  onToggle,
  onRetry,
  onEdit,
  onExport,
  onDelete,
  onBatchMove,
  onBatchDelete,
  onBatchCourse,
}: {
  pending: boolean;
  error: string | null;
  lectures: LibraryLectureSummary[];
  selected: Set<string>;
  onSelectAll: () => void;
  onToggle: (id: string) => void;
  onRetry: () => void;
  onEdit: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (lecture: LibraryLectureSummary) => void;
  onBatchMove: () => void;
  onBatchDelete: () => void;
  onBatchCourse: () => void;
}) {
  if (pending) return <ListSkeleton label="正在加载讲义…" />;
  if (error !== null) return <ListError message={error} onRetry={onRetry} />;
  if (lectures.length === 0) return <LibraryEmpty />;
  const allSelected = selected.size === lectures.length;
  return (
    <div className="mt-3">
      <BatchBar
        count={selected.size}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              disabled={selected.size === 0}
              onClick={onBatchMove}
            >
              <FolderInput aria-hidden />
              移动到文件夹…
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              disabled={selected.size === 0}
              onClick={onBatchCourse}
            >
              <ClipboardList aria-hidden />
              加入课程…
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={selected.size === 0}
              onClick={onBatchDelete}
            >
              <Trash2 aria-hidden />
              删除
            </Button>
          </>
        }
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onSelectAll}
            aria-label="全选当前筛选结果"
            className="size-5 accent-primary"
          />
          全选（{lectures.length}）
        </label>
      </BatchBar>
      <ul className="space-y-1.5">
        {lectures.map((lecture) => (
          <li
            key={lecture.id}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5"
          >
            <input
              type="checkbox"
              checked={selected.has(lecture.id)}
              onChange={() => onToggle(lecture.id)}
              aria-label={`选择讲义 ${lecture.title}`}
              className="size-5 shrink-0 accent-primary"
            />
            <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
              {lecture.title}
            </p>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              被 {lecture.courseCount} 个课程引用 ·{" "}
              {formatRelativeTime(lecture.updatedAt)}
            </span>
            <Button
              type="button"
              variant="ghost"
              className="size-11 shrink-0"
              aria-label={`编辑讲义 ${lecture.title}`}
              onClick={() => onEdit(lecture.id)}
            >
              <PencilLine aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11 shrink-0"
              aria-label={`导出讲义 ${lecture.title}`}
              onClick={() => onExport(lecture.id)}
            >
              <Download aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="size-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`删除讲义 ${lecture.title}`}
              onClick={() => onDelete(lecture)}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 题库列表 ----------

function UnitListView({
  pending,
  error,
  units,
  selected,
  onSelectAll,
  onToggle,
  onRetry,
  onOpenDetail,
  onExport,
  onDelete,
  onEditQuestion,
  onDeleteQuestion,
  onBatchMove,
  onBatchDelete,
  onBatchCourse,
}: {
  pending: boolean;
  error: string | null;
  units: LibraryUnitSummary[];
  selected: Set<string>;
  onSelectAll: () => void;
  onToggle: (id: string) => void;
  onRetry: () => void;
  onOpenDetail: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (unit: LibraryUnitSummary) => void;
  onEditQuestion: (id: string) => void;
  onDeleteQuestion: (id: string) => void;
  onBatchMove: () => void;
  onBatchDelete: () => void;
  onBatchCourse: () => void;
}) {
  if (pending) return <ListSkeleton label="正在加载练习单元…" />;
  if (error !== null) return <ListError message={error} onRetry={onRetry} />;
  if (units.length === 0) return <LibraryEmpty />;
  const allSelected = selected.size === units.length;
  return (
    <div className="mt-3">
      <BatchBar
        count={selected.size}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              disabled={selected.size === 0}
              onClick={onBatchMove}
            >
              <FolderInput aria-hidden />
              移动到文件夹…
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4"
              disabled={selected.size === 0}
              onClick={onBatchCourse}
            >
              <ClipboardList aria-hidden />
              加入课程…
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={selected.size === 0}
              onClick={onBatchDelete}
            >
              <Trash2 aria-hidden />
              删除
            </Button>
          </>
        }
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onSelectAll}
            aria-label="全选当前筛选结果"
            className="size-5 accent-primary"
          />
          全选（{units.length}）
        </label>
      </BatchBar>
      <ul className="space-y-1.5">
        {units.map((unit) => (
          <li
            key={unit.id}
            className="rounded-lg border border-border bg-card px-2 py-1.5"
          >
            <div className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={selected.has(unit.id)}
                onChange={() => onToggle(unit.id)}
                aria-label={`选择单元 ${unit.title}`}
                className="size-5 shrink-0 accent-primary"
              />
              <details className="group min-w-0 flex-1">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {unit.title}
                  </span>
                  {unit.topic !== null ? (
                    <span className="hidden max-w-40 truncate rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary sm:inline-block">
                      {unit.topic}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {unit.questionCount} 题 · 被 {unit.courseCount} 个课程引用 ·{" "}
                    {unit.assignmentCount} 个作业使用
                  </span>
                </summary>
                <div className="border-t border-border px-2 py-2">
                  {unit.knowledge.length > 0 ? (
                    <p className="mb-2 flex flex-wrap gap-1">
                      {unit.knowledge.map((name) => (
                        <span
                          key={name}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {name}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <UnitQuestionTable
                    unit={unit}
                    actions={{
                      onEditQuestion,
                      onDeleteQuestion,
                    }}
                  />
                </div>
              </details>
              <Button
                type="button"
                variant="ghost"
                className="size-11 shrink-0"
                aria-label={`单元信息 ${unit.title}`}
                onClick={() => onOpenDetail(unit.id)}
              >
                <Settings2 aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="size-11 shrink-0"
                aria-label={`导出单元 ${unit.title}`}
                onClick={() => onExport(unit.id)}
              >
                <Download aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="size-11 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`删除单元 ${unit.title}`}
                onClick={() => onDelete(unit)}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 回收站 ----------

function RecycleView({
  lecturesPending,
  unitsPending,
  lecturesError,
  unitsError,
  lectures,
  units,
  onRetry,
  onRestore,
  onPurge,
}: {
  lecturesPending: boolean;
  unitsPending: boolean;
  lecturesError: string | null;
  unitsError: string | null;
  lectures: LibraryLectureSummary[];
  units: LibraryUnitSummary[];
  onRetry: () => void;
  onRestore: (target: ResourceDeleteTarget) => void;
  onPurge: (target: ResourceDeleteTarget) => void;
}) {
  if (lecturesPending || unitsPending)
    return <ListSkeleton label="正在加载回收站…" />;
  if (lecturesError !== null || unitsError !== null) {
    return (
      <ListError
        message={lecturesError ?? (unitsError as string)}
        onRetry={onRetry}
      />
    );
  }
  if (lectures.length === 0 && units.length === 0) {
    return (
      <div className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
        <Trash2 aria-hidden className="size-10 text-muted-foreground" />
        <p className="text-sm font-medium">回收站是空的</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          删除的讲义与练习单元会进入回收站，可随时恢复或彻底删除。
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-5">
      {units.length > 0 ? (
        <section aria-label="已删除的练习单元">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            练习单元（{units.length}）
          </h2>
          <ul className="mt-1.5 space-y-1.5">
            {units.map((unit) => (
              <RecycleRow
                key={unit.id}
                name={unit.title}
                meta={`${unit.questionCount} 题 · 删除于 ${formatRelativeTime(unit.deletedAt ?? "")}`}
                onRestore={() =>
                  onRestore({ kind: "unit", id: unit.id, name: unit.title })
                }
                onPurge={() =>
                  onPurge({ kind: "unit", id: unit.id, name: unit.title })
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      {lectures.length > 0 ? (
        <section aria-label="已删除的讲义">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            讲义（{lectures.length}）
          </h2>
          <ul className="mt-1.5 space-y-1.5">
            {lectures.map((lecture) => (
              <RecycleRow
                key={lecture.id}
                name={lecture.title}
                meta={`删除于 ${formatRelativeTime(lecture.deletedAt ?? "")}`}
                onRestore={() =>
                  onRestore({
                    kind: "lecture",
                    id: lecture.id,
                    name: lecture.title,
                  })
                }
                onPurge={() =>
                  onPurge({
                    kind: "lecture",
                    id: lecture.id,
                    name: lecture.title,
                  })
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** 回收站行：名称 + 元信息 + 恢复 + 彻底删除 */
function RecycleRow({
  name,
  meta,
  onRestore,
  onPurge,
}: {
  name: string;
  meta: string;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <li className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 opacity-80">
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {meta}
      </span>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0 px-3"
        onClick={onRestore}
      >
        <RotateCcw aria-hidden />
        恢复
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 shrink-0 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
        title="彻底删除（仅当没有作答记录与作业引用时可用）"
        onClick={onPurge}
      >
        <Trash2 aria-hidden />
        彻底删除…
      </Button>
    </li>
  );
}

// ---------- 批量操作栏 / 弹层 ----------

/** 列表工具栏：左侧全选，选中 > 0 时展开批量操作（§4-2） */
function BatchBar({
  count,
  actions,
  children,
}: {
  count: number;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border pb-2">
      {children}
      {count > 0 ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">已选 {count} 项</span>
          {actions}
        </span>
      ) : null}
    </div>
  );
}

/** 批量移动到文件夹弹层（null = 未归类） */
function BatchMoveDialog({
  folders,
  pending,
  onCancel,
  onConfirm,
}: {
  folders: { id: string; name: string }[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (folderId: string | null) => void;
}) {
  const [folderId, setFolderId] = useState<string>("none");
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput aria-hidden className="size-4 text-muted-foreground" />
            移动到文件夹
          </DialogTitle>
          <DialogDescription>
            选中的资源将移动到目标文件夹（移入「未归类」= 不属于任何文件夹）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="batch-move-folder" className="text-sm font-medium">
            目标文件夹
          </label>
          <select
            id="batch-move-folder"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="none">未归类</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-5"
            onClick={onCancel}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 px-5"
            disabled={pending}
            onClick={() => onConfirm(folderId === "none" ? null : folderId)}
          >
            {pending ? "移动中…" : "移动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 批量加入课程弹层（courseId + 可见开关；重复跳过） */
function BatchCourseDialog({
  kind,
  ids,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: "lecture" | "unit";
  ids: string[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (courseId: string, visible: boolean) => void;
}) {
  const coursesQuery = useContentTree();
  const [courseId, setCourseId] = useState("");
  const [visible, setVisible] = useState(true);
  const courses = coursesQuery.data?.courses ?? [];
  const effectiveCourseId = courseId || courses[0]?.id || "";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList
              aria-hidden
              className="size-4 text-muted-foreground"
            />
            加入课程
          </DialogTitle>
          <DialogDescription>
            选中的{kind === "unit" ? "单元" : "讲义"}将追加到课程目录末尾；
            已在本课程中的会自动跳过。
          </DialogDescription>
        </DialogHeader>
        {coursesQuery.isPending ? (
          <p className="text-sm text-muted-foreground">正在加载课程…</p>
        ) : coursesQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            课程加载失败，请关闭后重试
          </p>
        ) : courses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有课程。请先在课程页创建。
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="batch-course" className="text-sm font-medium">
                目标课程
              </label>
              <select
                id="batch-course"
                value={effectiveCourseId}
                onChange={(e) => setCourseId(e.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => setVisible(e.target.checked)}
                className="size-5 accent-primary"
              />
              添加后对学生可见
            </label>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 px-5"
            onClick={onCancel}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 px-5"
            disabled={pending || effectiveCourseId.length === 0}
            onClick={() => onConfirm(effectiveCourseId, visible)}
          >
            {pending ? "添加中…" : `加入（${ids.length} 项）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 三态 ----------

function ListSkeleton({ label }: { label: string }) {
  return (
    <div aria-live="polite" className="mt-3 space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
      ))}
      <p className="text-center text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function ListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <CircleAlert aria-hidden className="size-8 text-destructive" />
      <p className="text-sm font-medium text-destructive">加载失败</p>
      <p className="max-w-sm text-xs break-all text-muted-foreground">
        {message}
      </p>
      <Button variant="outline" className="min-h-11 px-6" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function LibraryEmpty() {
  return (
    <div className="mt-3 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <FileStack aria-hidden className="size-10 text-muted-foreground" />
      <p className="text-sm font-medium">这里还没有内容</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        把练习或讲义的 Markdown 文档导入资源库，就能布置作业、组织课程。
      </p>
      <Button asChild className="mt-2 min-h-11 px-5">
        <Link to="/t/import">
          <Plus aria-hidden />
          去导入第一份文档
        </Link>
      </Button>
    </div>
  );
}

// 供 App.tsx 路由级懒加载
export default LibraryPage;
