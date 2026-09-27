import { useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_MAX_BATCH_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES_PER_BATCH,
} from "@tutor/contract";
import {
  CircleAlert,
  FileUp,
  FolderUp,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiPromptPanel } from "@/features/content/AiPromptPanel";
import { useContentTree } from "@/features/content/content-queries";
import { useLibraryFolders } from "@/features/library/library-queries";
import { ApiError, createLibraryFolderApi } from "@/lib/api";
import { BatchImportPreview } from "./BatchImportPreview";
import { SingleImportPreview } from "./SingleImportPreview";

/**
 * /t/import 导入页（T1.11 建立；T2A.3 重构为单文件与批量共用）：
 * - 输入区三入口：粘贴 / 选择 .md 文件（多选）/ 选择文件夹（webkitdirectory，
 *   特性检测降级——不支持时只显示多选文件，D20）；
 * - 目标文件夹选择（默认未归类，可就地新建）+「按子目录自动建文件夹」（批量）+
 *   「同时加入课程」快捷项（D17：归属仍在资源库，只追加课程目录条目）；
 * - 1 个文件或粘贴 → 单文件预览（可编辑、动作清单、错误面板、确认导入）；
 * - ≥2 个文件 → 批量预览（文件表格 + 展开单文件预览 + 跨文件冲突 + 逐文件提交 +
 *   汇总报告，D20）；
 * - 前端预检规模上限（≤50 文件 / 单文件 ≤1MB / 合计 ≤10MB，与后端同口径），
 *   超限直接提示不发请求。
 */

/** 文件名缺省值（契约要求非空；用户可改） */
export const DEFAULT_FILENAME = "未命名.md";

/** 前端选中的待导入文件（.md；内容已读入内存） */
export interface PickedFile {
  /** 相对路径（文件夹选择时含子目录；多选时为文件名） */
  readonly path: string;
  /** 文件名（basename） */
  readonly name: string;
  readonly markdown: string;
  /** 原文 UTF-8 字节数（与后端 Buffer.byteLength 同口径） */
  readonly bytes: number;
}

/** 导入选项（单文件与批量共用；由输入区收集） */
export interface ImportOptions {
  /** 目标文件夹 id；null = 未归类 */
  readonly folderId: string | null;
  /** 同时加入课程（D17 快捷项）；undefined = 不加入 */
  readonly addToCourse: { courseId: string; visible: boolean } | undefined;
}

/** 读取 FileList 中的 .md 文件（忽略其他扩展名），返回 PickedFile 列表 */
export async function readPickedFiles(
  fileList: FileList,
): Promise<PickedFile[]> {
  const result: PickedFile[] = [];
  for (const file of Array.from(fileList)) {
    if (!/\.(md|markdown)$/i.test(file.name)) continue;
    const markdown = await file.text();
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    const path =
      relative !== undefined && relative.length > 0 ? relative : file.name;
    result.push({
      path,
      name: file.name,
      markdown,
      bytes: new TextEncoder().encode(markdown).length,
    });
  }
  return result;
}

/** 规模预检（D20；与后端 IMPORT_TOO_LARGE 同口径），超限返回中文提示 */
export function precheckBatchLimits(
  files: readonly PickedFile[],
): string | null {
  if (files.length > IMPORT_MAX_FILES_PER_BATCH) {
    return `单批最多导入 ${IMPORT_MAX_FILES_PER_BATCH} 个文件（当前 ${files.length} 个），请分批导入。`;
  }
  for (const file of files) {
    if (file.bytes > IMPORT_MAX_FILE_BYTES) {
      return `文件「${file.path}」超过单文件 1 MB 上限，请拆分后再导入。`;
    }
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > IMPORT_MAX_BATCH_BYTES) {
    return `单批 markdown 合计超过 10 MB 上限（当前约 ${Math.round(total / 1024 / 1024)} MB），请分批导入。`;
  }
  return null;
}

/** webkitdirectory 特性检测（D20：不支持的浏览器只显示多选文件入口） */
export const SUPPORTS_DIRECTORY_PICKER =
  typeof window !== "undefined" &&
  typeof HTMLInputElement !== "undefined" &&
  "webkitdirectory" in HTMLInputElement.prototype;

type Stage = "select" | "single" | "batch";

/** 单文件预览的输入（来自粘贴或恰好一个文件） */
interface SingleInput {
  readonly markdown: string;
  readonly filename: string;
  /** 相对路径；空 = 粘贴内容（无文件路径） */
  readonly path: string;
}

export function ImportPage() {
  const [stage, setStage] = useState<Stage>("select");
  const [pickedFiles, setPickedFiles] = useState<PickedFile[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [pastedName, setPastedName] = useState(DEFAULT_FILENAME);
  const [singleInput, setSingleInput] = useState<SingleInput | null>(null);

  // ---- 导入选项 ----
  const [folderSelection, setFolderSelection] = useState<string>("none");
  const [autoSubdir, setAutoSubdir] = useState(false);
  const [addToCourseOn, setAddToCourseOn] = useState(false);
  const [courseSelection, setCourseSelection] = useState<string>("");
  const [courseVisible, setCourseVisible] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createFolderError, setCreateFolderError] = useState<string | null>(
    null,
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [precheckError, setPrecheckError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const folders = useLibraryFolders();
  const contentTree = useContentTree();
  const queryClient = useQueryClient();
  // 课程选项：内容树里的课程列表（「同时加入课程」下拉用；三态由下拉本身兜底）
  const courseOptions = (contentTree.data?.courses ?? []).map((course) => ({
    id: course.id,
    title: course.title,
  }));

  const options: ImportOptions = {
    folderId: folderSelection === "none" ? null : (folderSelection as string),
    addToCourse:
      addToCourseOn && courseSelection !== ""
        ? { courseId: courseSelection, visible: courseVisible }
        : undefined,
  };

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    if (list === null || list.length === 0) return;
    setPrecheckError(null);
    setPickedFiles(await readPickedFiles(list));
    // 允许再次选择同一批文件（change 依赖 value 变化）
    event.target.value = "";
  }

  function handlePreviewClick(): void {
    setPrecheckError(null);
    if (pickedFiles.length > 0) {
      const error = precheckBatchLimits(pickedFiles);
      if (error !== null) {
        setPrecheckError(error);
        return;
      }
      if (pickedFiles.length === 1) {
        const file = pickedFiles[0];
        if (file === undefined) return;
        setSingleInput({
          markdown: file.markdown,
          filename: file.name,
          path: file.path,
        });
        setStage("single");
      } else {
        setStage("batch");
      }
      return;
    }
    if (pastedText.trim().length > 0) {
      setSingleInput({
        markdown: pastedText,
        filename: pastedName,
        path: "",
      });
      setStage("single");
    }
  }

  async function handleCreateFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (name.length === 0) return;
    setCreatingFolder(true);
    setCreateFolderError(null);
    try {
      const folder = await createLibraryFolderApi({ name });
      setFolderSelection(folder.id);
      setCreateOpen(false);
      setNewFolderName("");
      void queryClient.invalidateQueries({
        queryKey: ["teacher", "library", "folders"],
      });
    } catch (err) {
      setCreateFolderError(
        err instanceof ApiError ? err.message : "新建文件夹失败，请稍后重试",
      );
    } finally {
      setCreatingFolder(false);
    }
  }

  const filenameMissing =
    pickedFiles.length === 0 &&
    pastedText.trim().length > 0 &&
    pastedName.trim().length === 0;
  const canPreview =
    (pickedFiles.length > 0 || pastedText.trim().length > 0) &&
    !filenameMissing &&
    !(addToCourseOn && courseSelection === "");

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-4 md:px-6 md:py-6">
      {/* 面包屑 + 标题 */}
      <nav aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <Link
          to="/t/library"
          className="rounded px-1 py-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          资源库
        </Link>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        <span aria-current="page" className="font-medium">
          导入内容
        </span>
      </nav>

      {stage === "select" ? (
        <div className="mt-4 max-w-3xl">
          <h1 className="text-lg font-semibold">导入内容</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            内容统一导入资源库（支持 v2 DSL 与旧版 v1
            格式）；可选多个文件或整个文件夹批量导入，预览无误后确认。
          </p>

          {/* AI 出题助手（T1.13）：复制「规范+样例+模板」提示词给 AI，产出可导入文档 */}
          <div className="mt-4">
            <AiPromptPanel />
          </div>

          <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
            {/* 三入口：粘贴 / 选文件 / 选文件夹 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">选择内容</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".md,.markdown,text/markdown"
                  onChange={handleFiles}
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp aria-hidden />
                  选择 .md 文件
                </Button>
                {SUPPORTS_DIRECTORY_PICKER ? (
                  <>
                    <input
                      ref={dirInputRef}
                      type="file"
                      multiple
                      // webkitdirectory 是非标准属性，React 不识别 → 用 ref 设置
                      onChange={handleFiles}
                      className="hidden"
                      tabIndex={-1}
                      aria-hidden
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 px-4"
                      onClick={() => {
                        const input = dirInputRef.current;
                        if (input !== null) {
                          input.setAttribute("webkitdirectory", "");
                          input.setAttribute("directory", "");
                          input.click();
                        }
                      }}
                    >
                      <FolderUp aria-hidden />
                      选择文件夹
                    </Button>
                  </>
                ) : null}
                {pickedFiles.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    已选择 {pickedFiles.length} 个 .md 文件
                    <button
                      type="button"
                      className="ml-2 rounded px-1 text-destructive underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      onClick={() => setPickedFiles([])}
                    >
                      清除
                    </button>
                  </span>
                ) : null}
              </div>

              <textarea
                id="import-markdown"
                aria-label="文档内容"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                spellCheck={false}
                placeholder={
                  "或在此粘贴 Markdown 原文…\n\nv2 文档以 frontmatter 开头：\n---\nkind: practice\nunit: 练习四\n---"
                }
                className="min-h-48 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-[13px] leading-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex w-64 flex-col gap-1.5">
                  <label
                    htmlFor="import-filename"
                    className="text-sm font-medium"
                  >
                    文件名（粘贴内容用）
                  </label>
                  <Input
                    id="import-filename"
                    value={pastedName}
                    onChange={(e) => setPastedName(e.target.value)}
                    placeholder="练习四.md"
                    className="min-h-11"
                  />
                </div>
              </div>
            </div>

            {/* 导入选项 */}
            <div className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="import-folder" className="text-sm font-medium">
                  目标文件夹
                </label>
                <select
                  id="import-folder"
                  value={folderSelection}
                  onChange={(e) => setFolderSelection(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="none">未归类</option>
                  {folders.data?.folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 w-fit px-2 text-sm text-muted-foreground"
                  onClick={() => {
                    setCreateFolderError(null);
                    setCreateOpen(true);
                  }}
                >
                  + 就地新建文件夹
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                {pickedFiles.length >= 2 ? (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoSubdir}
                      onChange={(e) => setAutoSubdir(e.target.checked)}
                      className="size-5 accent-primary"
                    />
                    按子目录自动建文件夹
                  </label>
                ) : (
                  <p className="min-h-11 text-xs leading-relaxed text-muted-foreground">
                    选择 2
                    个以上文件批量导入时，可按文件所在子目录自动建文件夹。
                  </p>
                )}
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={addToCourseOn}
                    onChange={(e) => setAddToCourseOn(e.target.checked)}
                    className="size-5 accent-primary"
                  />
                  同时加入课程（追加到目录末尾）
                </label>
                {addToCourseOn ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="选择课程"
                      value={courseSelection}
                      onChange={(e) => setCourseSelection(e.target.value)}
                      className="min-h-11 flex-1 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">选择课程…</option>
                      {courseOptions.map((course) => (
                        <option key={course.id} value={course.id}>
                          {course.title}
                        </option>
                      ))}
                    </select>
                    <label className="flex min-h-11 items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={courseVisible}
                        onChange={(e) => setCourseVisible(e.target.checked)}
                        className="size-5 accent-primary"
                      />
                      对学生可见
                    </label>
                  </div>
                ) : null}
              </div>
            </div>

            {precheckError !== null ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {precheckError}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-3">
              <Button
                type="button"
                className="min-h-11 px-5"
                disabled={!canPreview}
                onClick={handlePreviewClick}
              >
                <Upload aria-hidden />
                预览
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              上限：单批 ≤{IMPORT_MAX_FILES_PER_BATCH} 个文件、单文件 ≤1
              MB、合计 ≤10 MB。
            </p>
          </div>

          {/* 就地新建文件夹弹层 */}
          {createOpen ? (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-folder-heading"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            >
              <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-4 shadow-lg">
                <div className="flex items-center justify-between gap-3">
                  <h3
                    id="create-folder-heading"
                    className="flex items-center gap-2 text-sm font-semibold"
                  >
                    <FolderUp
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />
                    新建文件夹
                  </h3>
                  <button
                    type="button"
                    aria-label="关闭弹层"
                    onClick={() => setCreateOpen(false)}
                    className="flex size-8 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  新建后自动选为目标文件夹；同名文件夹已存在时会提示。
                </p>
                <Input
                  aria-label="文件夹名"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="如：第一章 有理数"
                  className="mt-3 min-h-11"
                />
                {createFolderError !== null ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {createFolderError}
                  </p>
                ) : null}
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 px-4"
                    onClick={() => setCreateOpen(false)}
                    disabled={creatingFolder}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11 px-4"
                    disabled={
                      creatingFolder || newFolderName.trim().length === 0
                    }
                    onClick={() => void handleCreateFolder()}
                  >
                    {creatingFolder ? (
                      <>
                        <Loader2 aria-hidden className="animate-spin" />
                        创建中…
                      </>
                    ) : (
                      "创建"
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : stage === "single" && singleInput !== null ? (
        <SingleImportPreview
          input={singleInput}
          options={options}
          onBack={() => {
            setStage("select");
            setSingleInput(null);
          }}
        />
      ) : (
        <BatchImportPreview
          files={pickedFiles}
          options={options}
          autoSubdir={autoSubdir}
          onBack={() => {
            setStage("select");
            setPickedFiles([]);
          }}
        />
      )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default ImportPage;
