import type { CourseDetailData, LibraryUnitSummary } from "@tutor/contract";
import {
  BookOpen,
  CheckSquare,
  Dumbbell,
  Loader2,
  Search,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useLibraryFolders, useLibraryLectures, useLibraryUnits } from "@/features/library/library-queries";
import { useAddCourseItems } from "@/features/courses/course-queries";
import { ApiError } from "@/lib/api";

/**
 * 「从资源库添加」侧边抽屉（T2A.4，§4-3/§4-9）：
 * - 讲义 / 单元两个页签；文件夹筛选 + 搜索（前端即时过滤）+ 多选；
 * - 已在本课程的资源置灰并标注（D6「选择器中标记已在本课程」）；
 * - 选中讲义有配套单元时提示并默认勾选「一并添加配套练习（N 个）」（D8）；
 * - 「添加后对学生可见」开关默认开（D6）；
 * - 提交后展示新增 / 跳过清单（批量口径，D6）。
 * 文案与代码标识符遵循 §1.1 术语表。
 */

/** 本课程已引用的资源键（kind:refId） */
export function refIdKeysOf(detail: CourseDetailData): Set<string> {
  const keys = new Set<string>();
  for (const item of detail.items) {
    if (item.refId !== null) keys.add(`${item.kind}:${item.refId}`);
  }
  return keys;
}

export function AddFromLibrarySheet({
  courseId,
  existingKeys,
  onClose,
}: {
  courseId: string;
  existingKeys: Set<string>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"lectures" | "units">("lectures");
  const [folderId, setFolderId] = useState<string | "all">("all");
  const [query, setQuery] = useState("");
  /** 选中的资源 id（按当前页签） */
  const [selectedLectureIds, setSelectedLectureIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(
    new Set(),
  );
  const [visible, setVisible] = useState(true);
  const [withCompanions, setWithCompanions] = useState(true);
  const [result, setResult] = useState<string | null>(null);

  const foldersQuery = useLibraryFolders();
  const lecturesQuery = useLibraryLectures({});
  const unitsQuery = useLibraryUnits({});
  const addMutation = useAddCourseItems(courseId);

  const lectures = lecturesQuery.data?.lectures ?? [];
  const units = useMemo(
    () => unitsQuery.data?.units ?? [],
    [unitsQuery.data?.units],
  );

  const q = query.trim().toLowerCase();
  const filteredLectures = lectures
    .filter(
      (row) =>
        folderId === "all" ||
        (folderId === "none" ? row.folderId === null : row.folderId === folderId),
    )
    .filter((row) => q.length === 0 || row.title.toLowerCase().includes(q));
  const filteredUnits = units
    .filter(
      (row) =>
        folderId === "all" ||
        (folderId === "none" ? row.folderId === null : row.folderId === folderId),
    )
    .filter(
      (row) =>
        q.length === 0 ||
        row.title.toLowerCase().includes(q) ||
        row.id.toLowerCase().includes(q) ||
        (row.topic?.toLowerCase().includes(q) ?? false),
    );

  /** D8：选中讲义的配套单元（未软删、不在课程、未被手动选中的部分） */
  const companionUnits: LibraryUnitSummary[] = useMemo(() => {
    if (selectedLectureIds.size === 0) return [];
    return units.filter(
      (unit) =>
        unit.lectureId !== null &&
        selectedLectureIds.has(unit.lectureId) &&
        !existingKeys.has(`unit:${unit.id}`) &&
        !selectedUnitIds.has(unit.id),
    );
  }, [units, selectedLectureIds, existingKeys, selectedUnitIds]);

  const totalToAdd =
    selectedLectureIds.size +
    selectedUnitIds.size +
    (withCompanions ? companionUnits.length : 0);

  function toggleLecture(id: string) {
    setSelectedLectureIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleUnit(id: string) {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit() {
    const items: { kind: "lecture" | "unit"; refId: string }[] = [
      ...[...selectedLectureIds].map((refId) => ({
        kind: "lecture" as const,
        refId,
      })),
      ...[...selectedUnitIds].map((refId) => ({ kind: "unit" as const, refId })),
    ];
    if (items.length === 0) return;
    addMutation.mutate(
      {
        items,
        visible,
        ...(tab === "lectures" || selectedLectureIds.size > 0
          ? { withCompanionUnits: withCompanions }
          : {}),
      },
      {
        onSuccess: (data) => {
          const parts = [`已添加 ${data.added.length} 项`];
          if (data.skipped.length > 0) {
            const names = data.skipped
              .slice(0, 5)
              .map((item) => item.title ?? item.refId ?? "未命名")
              .join("、");
            parts.push(
              `跳过 ${data.skipped.length} 项（${names}${data.skipped.length > 5 ? " 等" : ""}）`,
            );
          }
          setResult(parts.join("；"));
          setSelectedLectureIds(new Set());
          setSelectedUnitIds(new Set());
        },
      },
    );
  }

  const errorMessage =
    addMutation.isError && addMutation.error instanceof ApiError
      ? addMutation.error.message
      : addMutation.isError
        ? "添加失败，请稍后重试"
        : null;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-[min(90vw,40rem)]">
        <SheetHeader>
          <SheetTitle>从资源库添加</SheetTitle>
          <SheetDescription>
            选择讲义或练习单元追加到课程目录末尾；资源仍归资源库，编辑即时生效。
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3">
          {/* 页签 */}
          <div role="tablist" aria-label="资源类型" className="flex gap-2">
            <Button
              role="tab"
              aria-selected={tab === "lectures"}
              variant={tab === "lectures" ? "secondary" : "outline"}
              className="min-h-11"
              onClick={() => setTab("lectures")}
            >
              <BookOpen aria-hidden />
              讲义
            </Button>
            <Button
              role="tab"
              aria-selected={tab === "units"}
              variant={tab === "units" ? "secondary" : "outline"}
              className="min-h-11"
              onClick={() => setTab("units")}
            >
              <Dumbbell aria-hidden />
              练习单元
            </Button>
          </div>

          {/* 文件夹筛选 + 搜索 */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="add-folder-filter">
              文件夹筛选
            </label>
            <select
              id="add-folder-filter"
              className="min-h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
            >
              <option value="all">全部文件夹</option>
              <option value="none">未归类</option>
              {(foldersQuery.data?.folders ?? []).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <div className="relative flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <label className="sr-only" htmlFor="add-search">
                搜索资源
              </label>
              <Input
                id="add-search"
                className="min-h-11 pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  tab === "lectures" ? "搜索讲义标题" : "搜索单元标题 / id / 主题"
                }
              />
            </div>
          </div>

          {/* 资源列表 */}
          {tab === "lectures" ? (
            <ResourceList
              count={filteredLectures.length}
              pending={lecturesQuery.isPending}
              error={
                lecturesQuery.isError
                  ? lecturesQuery.error instanceof Error
                    ? lecturesQuery.error.message
                    : "加载失败"
                  : null
              }
              emptyText="资源库还没有讲义，或没有符合筛选的结果。可先到「导入」添加内容。"
            >
              {filteredLectures.map((lecture) => {
                const inCourse = existingKeys.has(`lecture:${lecture.id}`);
                return (
                  <ResourceRow
                    key={lecture.id}
                    title={lecture.title}
                    meta={`被 ${courseCountLabel(lecture.courseCount)}引用`}
                    disabled={inCourse}
                    badge={inCourse ? "已在本课程" : null}
                    checked={selectedLectureIds.has(lecture.id)}
                    onToggle={() => toggleLecture(lecture.id)}
                  />
                );
              })}
            </ResourceList>
          ) : (
            <ResourceList
              count={filteredUnits.length}
              pending={unitsQuery.isPending}
              error={
                unitsQuery.isError
                  ? unitsQuery.error instanceof Error
                    ? unitsQuery.error.message
                    : "加载失败"
                  : null
              }
              emptyText="资源库还没有练习单元，或没有符合筛选的结果。可先到「导入」添加内容。"
            >
              {filteredUnits.map((unit) => {
                const inCourse = existingKeys.has(`unit:${unit.id}`);
                return (
                  <ResourceRow
                    key={unit.id}
                    title={unit.title}
                    meta={`${unit.questionCount} 题${unit.lectureTitle ? ` · 配套《${unit.lectureTitle}》` : ""}`}
                    disabled={inCourse}
                    badge={inCourse ? "已在本课程" : null}
                    checked={selectedUnitIds.has(unit.id)}
                    onToggle={() => toggleUnit(unit.id)}
                  />
                );
              })}
            </ResourceList>
          )}

          {/* D8 配套练习提示 */}
          {tab === "lectures" && companionUnits.length > 0 && (
            <label className="flex min-h-11 items-center gap-2 rounded-lg bg-muted/60 px-3 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-[var(--color-primary)]"
                checked={withCompanions}
                onChange={(e) => setWithCompanions(e.target.checked)}
              />
              一并添加配套练习（{companionUnits.length} 个：
              {companionUnits
                .slice(0, 3)
                .map((unit) => unit.title)
                .join("、")}
              {companionUnits.length > 3 ? " 等" : ""}
              ）
            </label>
          )}

          {/* 可见开关（D6） */}
          <label className="flex min-h-11 items-center gap-2 rounded-lg bg-muted/60 px-3 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-primary)]"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
              添加后对学生可见（{visible ? "立即可见" : "先隐藏，稍后手动开放"}）
          </label>

          {result && (
            <p aria-live="polite" className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
              {result}
            </p>
          )}
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border p-4">
          <p className="text-sm text-muted-foreground">
            {totalToAdd > 0 ? `将添加 ${totalToAdd} 项到目录末尾` : "在上方选择资源"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-11" onClick={onClose}>
              完成
            </Button>
            <Button
              className="min-h-11 px-4"
              disabled={addMutation.isPending || totalToAdd === 0}
              onClick={handleSubmit}
            >
              {addMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在添加…
                </>
              ) : (
                `添加${totalToAdd > 0 ? ` ${totalToAdd} 项` : ""}`
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** 引用次数文案（避免「被 1 个课程引用」的语病） */
function courseCountLabel(count: number): string {
  return count > 0 ? `${count} 个课程` : "0 个课程";
}

function ResourceList({
  count,
  pending,
  error,
  emptyText,
  children,
}: {
  count: number;
  pending: boolean;
  error: string | null;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (pending) {
    return (
      <div role="status" aria-label="正在加载资源" className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />
        ))}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div role="alert" className="rounded-lg border border-border p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (count === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }
  return <ul className="flex min-h-0 flex-col gap-2">{children}</ul>;
}

function ResourceRow({
  title,
  meta,
  disabled,
  badge,
  checked,
  onToggle,
}: {
  title: string;
  meta: string;
  disabled: boolean;
  badge: string | null;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
          disabled
            ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground"
            : checked
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:bg-muted/50"
        }`}
      >
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-[var(--color-primary)]"
          disabled={disabled}
          checked={checked}
          onChange={onToggle}
        />
        {checked ? (
          <CheckSquare aria-hidden className="size-4 shrink-0 text-primary" />
        ) : (
          <Square aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {meta}
          </span>
        </span>
        {badge && (
          <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs">
            {badge}
          </span>
        )}
      </label>
    </li>
  );
}
