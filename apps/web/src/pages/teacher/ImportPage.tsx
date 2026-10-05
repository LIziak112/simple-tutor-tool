import { useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_MAX_BATCH_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES_PER_BATCH,
} from "@tutor/contract";
import {
  CheckCircle2,
  CircleAlert,
  ClipboardPaste,
  FileUp,
  FolderUp,
  Images,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AiPromptPanel } from "@/features/content/AiPromptPanel";
import { useContentTree } from "@/features/content/content-queries";
import { useLibraryFolders } from "@/features/library/library-queries";
import { ApiError, createLibraryFolderApi } from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { BatchImportPreview } from "./BatchImportPreview";
import { extractImageRefs, rewriteImageSrcs } from "./companion-media";
import { filesFromDataTransfer } from "./dropped-files";
import { SingleImportPreview } from "./SingleImportPreview";
import { useCompanionImages } from "./use-companion-images";

/**
 * /t/import 导入页（T1.11 建立；T2A.3 单文件与批量共用；内容模型方案 §5 重构；
 * 媒体管线第四单起随行图片与 md 同选同传）：
 * - 选择页 = 一张统一待导入清单：三入口都往同一份 PickedFile[] 加条目——
 *   「选择 md / 图片文件」（多选追加，md 进清单、图片进随行候选）/「选择文件夹」
 *   （webkitdirectory，特性检测降级 D20）/「粘贴内容」（textarea + 文件名）/
 *   拖拽文件或文件夹到清单卡（webkitGetAsEntry 递归，桌面；iPad 多选兜底）；
 *   同 path 重复 → 原位替换（保持最新），每次选择给一行反馈；
 * - 随行图片（useCompanionImages）：解析所选 md 的 ::image src 与所选图片配对
 *   （companion-media 纯函数），**只上传被引用到的图片**（3 并发、单张失败不
 *   阻断），上传成功即用返回路径改写清单条目里的 src（幂等），预览/提交用的
 *   都是改写后文本；未被引用的所选文件不上传、不读内容；上传期间「预览」
 *   暂不可点，避免拿半改写的文本进预览；
 * - 清单只看名不看内容（正文检查交给预览态）：文件名 / 相对路径（文件夹选择时）/
 *   大小 / 移除；文件与粘贴条目都可就地改名（改名只换 basename，目录前缀保留）；
 * - 规模预检实时化：清单一变立即跑 precheckBatchLimits，超限红字显示在清单区，
 *   不必等点预览（≤50 文件 / 单文件 ≤1MB / 合计 ≤10MB，与后端同口径）；
 * - 导入选项：目标文件夹（默认未归类，可就地新建）+「按子目录自动建文件夹」（≥2 条时）+
 *   「同时加入课程」快捷项（D17：归属仍在资源库，只追加课程目录条目）；
 * - 预览路由：1 条 → 单文件预览（可编辑、动作清单、错误面板、确认导入，粘贴与文件
 *   条目一视同仁）；≥2 条 → 批量预览（文件表格 + 展开单文件预览 + 跨文件冲突 +
 *   逐文件提交 + 汇总报告，D20）；两种预览都展示随行图片汇总卡（md ×N、
 *   自动上传图片 ×N 成功/失败分列、未配对引用的处理方式）。
 */

/** 文件名缺省值（契约要求非空；用户可改） */
export const DEFAULT_FILENAME = "未命名.md";

/** 前端选中的待导入文件（.md；内容已读入内存） */
export interface PickedFile {
  /** 清单内稳定标识（条目 key 与改名/移除定位；path 会随改名变化，不能当 key） */
  readonly id: string;
  /** 相对路径（文件夹选择时含子目录；多选与粘贴为文件名；清单内唯一 = 条目身份） */
  readonly path: string;
  /** 文件名（basename；粘贴条目可就地改名，改名同步 path） */
  readonly name: string;
  readonly markdown: string;
  /**
   * 原文 ::image src 快照（加入清单那一刻提取）：随行图片配对/改写始终以它
   * 为准——markdown 里的 src 被改写成服务器路径后原引用名就不在正文里了，
   * 用正文实时提取会让配对与上传统计在改写后「失忆」。
   */
  readonly imageRefs: readonly string[];
  /** 原文 UTF-8 字节数（与后端 Buffer.byteLength 同口径） */
  readonly bytes: number;
  /** 来源：文件/文件夹选择，或粘贴（粘贴条目文件名可编辑；单文件预览不携带 sourcePath） */
  readonly source: "file" | "paste";
}

/** 导入选项（单文件与批量共用；由输入区收集） */
export interface ImportOptions {
  /** 目标文件夹 id；null = 未归类 */
  readonly folderId: string | null;
  /** 同时加入课程（D17 快捷项）；undefined = 不加入 */
  readonly addToCourse: { courseId: string; visible: boolean } | undefined;
}

/** 预览/确认步骤展示的随行图片汇总（无图片参与时为 null，卡片自行为空不渲染） */
export interface ImportMediaSummary {
  /** 本批将导入的 md 份数 */
  readonly mdCount: number;
  /** 识别并自动上传的图片张数（多 md 引用同一张已去重） */
  readonly imageCount: number;
  readonly uploadedCount: number;
  /** 失败明细（文件名 + 原因，逐张列出） */
  readonly failed: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
  /** 保持原样的引用处数（未配对 + 同名冲突 + 配对但上传失败） */
  readonly unresolvedCount: number;
}

/** 读取所选文件的结果：入清单条目 + 随行图片候选 + 被忽略的文件与中文原因 */
export interface ReadPickedResult {
  readonly entries: readonly PickedFile[];
  /** 图片文件（png/jpg/webp/gif；是否上传由随行配对决定，这里不读内容） */
  readonly images: readonly File[];
  readonly skipped: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
}

/** 图片扩展名白名单（与服务端魔数检测的格式清单同口径，大小写不敏感） */
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif)$/i;

/**
 * 读取所选文件中的 .md（进清单）与图片（进随行候选），其余扩展名忽略并给原因。
 * 入参是 File 数组而非 FileList：调用方须先快照（置空 input.value 会清空
 * input.files 所指的同一 FileList 对象，活引用事后读恒为空，见 handleFiles）。
 * 2026-10 审核修复：非 .md 与读取失败不再静默吞掉——曾经「选 4 个只进 3 个」
 * 毫无提示，用户无从知道差在哪个文件；现在清单位置给一行反馈说明忽略原因。
 * 图片文件此时不读内容（未引用的零读取），是否上传由 useCompanionImages
 * 按 md 引用配对决定。
 */
export async function readPickedFiles(
  files: readonly File[],
): Promise<ReadPickedResult> {
  const entries: PickedFile[] = [];
  const images: File[] = [];
  const skipped: ReadPickedResult["skipped"][number][] = [];
  for (const file of files) {
    if (/\.(md|markdown)$/i.test(file.name)) {
      try {
        const markdown = await file.text();
        const relative = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        const path =
          relative !== undefined && relative.length > 0 ? relative : file.name;
        entries.push({
          id: randomUuid(),
          path,
          name: file.name,
          markdown,
          imageRefs: extractImageRefs([markdown]),
          bytes: new TextEncoder().encode(markdown).length,
          source: "file",
        });
      } catch {
        // 单个文件读取失败（被其他程序独占锁定等）不影响其余文件进清单
        skipped.push({
          name: file.name,
          reason: "读取失败（可能被其他程序占用）",
        });
      }
      continue;
    }
    if (IMAGE_FILE_PATTERN.test(file.name)) {
      images.push(file);
      continue;
    }
    skipped.push({ name: file.name, reason: "非 .md 或图片文件" });
  }
  return { entries, images, skipped };
}

/** 条目改名后的 path：文件夹选择的条目带子目录前缀（「按子目录自动建文件夹」
 * 的依据），改名只换 basename、保留目录；根级条目 path 即文件名。 */
export function renamedPath(path: string, name: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? `${path.slice(0, slash + 1)}${name}` : name;
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

/** 同 path 重复 → 原位替换（保持最新内容），否则追加（方案 §5：清单以 path 为身份） */
function upsertByPath(
  list: readonly PickedFile[],
  entry: PickedFile,
): PickedFile[] {
  const index = list.findIndex((file) => file.path === entry.path);
  if (index === -1) return [...list, entry];
  return list.map((file, i) => (i === index ? entry : file));
}

/** 粘贴条目的默认文件名序列：未命名.md → 未命名-2.md → …（避开清单已有 path，
 * 连续多次粘贴互不覆盖；显式输入已有名仍走「同 path 替换」更新旧条目） */
function nextPasteFilename(list: readonly PickedFile[]): string {
  const taken = new Set(list.map((file) => file.path));
  if (!taken.has(DEFAULT_FILENAME)) return DEFAULT_FILENAME;
  for (let n = 2; ; n += 1) {
    const candidate = `未命名-${n}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 字节数 → 「x.x KB」短文案（四舍五入到 0.1 KB，下限 0.1） */
function formatSizeKb(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`;
}

type Stage = "select" | "single" | "batch";

/** 单文件预览的输入（来自清单中恰好一条：文件条目或粘贴条目） */
interface SingleInput {
  readonly markdown: string;
  readonly filename: string;
  /** 相对路径；空 = 粘贴条目（无文件路径，D21 提示词口径） */
  readonly path: string;
}

export function ImportPage() {
  const [stage, setStage] = useState<Stage>("select");
  const [pickedFiles, setPickedFiles] = useState<PickedFile[]>([]);
  // 粘贴输入区（展开式小面板）：内容与文件名只在「加入清单」那一刻转成清单条目
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [pastedName, setPastedName] = useState(DEFAULT_FILENAME);
  const [singleInput, setSingleInput] = useState<SingleInput | null>(null);
  // 最近一次文件选择的反馈（加入/更新同名/忽略及原因；再选择或清空时刷新）
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  // 拖拽悬停高亮（桌面拖文件/文件夹到清单卡；iPad 拖拽不可靠由多选兜底）
  const [dragOver, setDragOver] = useState(false);

  // 随行图片：配对 + 只传被引用图片 + src 改写映射（见 use-companion-images）
  const companion = useCompanionImages(pickedFiles);

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

  // 规模预检实时化（方案 §5）：清单一变立即重算，超限红字直接显示在清单区
  const precheckError = useMemo(
    () => precheckBatchLimits(pickedFiles),
    [pickedFiles],
  );

  // 上传成功 → 用服务端路径改写清单条目里的 src（幂等：文本已不含原 src 时
  // 逐字节不变、不触发重渲染循环）；进入预览/提交的 md 始终是改写后文本
  const rewriteMap = companion.rewriteMap;
  useEffect(() => {
    if (rewriteMap.size === 0) return;
    setPickedFiles((prev) => {
      let changed = false;
      const next = prev.map((file) => {
        const markdown = rewriteImageSrcs(file.markdown, rewriteMap);
        if (markdown === file.markdown) return file;
        changed = true;
        return {
          ...file,
          markdown,
          bytes: new TextEncoder().encode(markdown).length,
        };
      });
      return changed ? next : prev;
    });
  }, [rewriteMap]);

  /**
   * 统一入口：把一批所选文件（多选 input / 文件夹 input / 拖拽展开结果）收进
   * 清单与随行图片候选，并给一行反馈。md 同 path 替换保持最新、图片同 path
   * 替换并重置上传状态（重传幂等，服务端内容寻址去重）。
   */
  async function ingestFiles(picked: readonly File[]): Promise<void> {
    if (picked.length === 0) return;
    const {
      entries: incoming,
      images,
      skipped,
    } = await readPickedFiles(picked);
    if (incoming.length === 0 && images.length === 0 && skipped.length === 0) {
      return;
    }
    // 与清单既有条目同 path = 同一份内容 → 原位替换；计数进反馈行让「更新了
    // 哪些同名文件」可见（用户改完本地文件重选时能确认拿到的是新内容）
    const existingPaths = new Set(pickedFiles.map((file) => file.path));
    const replacedCount = incoming.filter((file) =>
      existingPaths.has(file.path),
    ).length;
    if (incoming.length > 0) {
      setPickedFiles((prev) => incoming.reduce(upsertByPath, prev));
    }
    if (images.length > 0) {
      companion.registerImages(images);
    }
    const parts: string[] = [];
    if (incoming.length > 0) {
      parts.push(
        replacedCount > 0
          ? `加入 ${incoming.length - replacedCount} 条，更新同名 ${replacedCount} 条（已用所选文件的内容）`
          : `已加入 ${incoming.length} 条`,
      );
    }
    if (images.length > 0) {
      parts.push(`收到图片 ${images.length} 个（只上传文档引用到的）`);
    }
    if (skipped.length > 0) {
      parts.push(
        `忽略 ${skipped.length} 个：${skipped
          .map((item) => `${item.name}（${item.reason}）`)
          .join("、")}`,
      );
    }
    setPickNotice(parts.join("；"));
  }

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    // 先把 FileList 快照成数组：真实浏览器里 input.value = "" 会同步清空
    // input.files 所指的同一个 FileList 对象，之后再读 length 恒为 0（jsdom 模拟
    // 不出该语义，曾致真实浏览器选完文件清单不进条目——e2e/import-select 回归）
    const picked = Array.from(event.target.files ?? []);
    // 允许再次选择同一批文件（change 依赖 value 变化）
    event.target.value = "";
    await ingestFiles(picked);
  }

  /** 拖拽文件 / 文件夹到清单卡（webkitGetAsEntry 递归展开，桌面浏览器） */
  async function handleDrop(event: React.DragEvent<HTMLElement>) {
    // 阻止浏览器默认打开文件；dragover 的 preventDefault 是允许 drop 的前提
    event.preventDefault();
    setDragOver(false);
    await ingestFiles(await filesFromDataTransfer(event.dataTransfer));
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    setDragOver(true);
  }

  /** 悬停离开：只有真正离开清单卡（不含移入子元素）才撤高亮，避免子元素间闪动 */
  function handleDragLeave(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) {
      return;
    }
    setDragOver(false);
  }

  function togglePaste(): void {
    if (!pasteOpen) {
      // 展开时给一个不与清单冲突的默认名，连续粘贴互不覆盖
      setPastedName(nextPasteFilename(pickedFiles));
    }
    setPasteOpen(!pasteOpen);
  }

  /** 粘贴内容 → 清单条目（加入后清空 textarea；文件名留作下一条默认值） */
  function handleAddPasted(): void {
    if (pastedText.trim().length === 0) return;
    const name =
      pastedName.trim().length > 0 ? pastedName.trim() : DEFAULT_FILENAME;
    const entry: PickedFile = {
      id: randomUuid(),
      path: name,
      name,
      markdown: pastedText,
      imageRefs: extractImageRefs([pastedText]),
      bytes: new TextEncoder().encode(pastedText).length,
      source: "paste",
    };
    const next = upsertByPath(pickedFiles, entry);
    setPickedFiles(next);
    setPastedText("");
    setPastedName(nextPasteFilename(next));
  }

  /** 条目就地改名（文件与粘贴条目都可改；改名同步 path——目录前缀保留） */
  function handleRename(id: string, name: string): void {
    setPickedFiles((prev) => {
      const current = prev.find((file) => file.id === id);
      if (current === undefined) return prev;
      const renamed: PickedFile = {
        ...current,
        name,
        path: renamedPath(current.path, name),
      };
      return prev
        .filter((file) => file.id === id || file.path !== renamed.path)
        .map((file) => (file.id === id ? renamed : file));
    });
  }

  function handleRemove(id: string): void {
    setPickedFiles((prev) => prev.filter((file) => file.id !== id));
  }

  function handlePreviewClick(): void {
    // 清单空 / 有未命名条目（按钮已禁用）或超限（红字已显示）时不进入预览；
    // 关联图片仍在自动上传时按钮同样禁用——避免拿半改写的文本进预览
    if (pickedFiles.length === 0 || precheckError !== null) return;
    if (pickedFiles.length === 1) {
      const file = pickedFiles[0];
      if (file === undefined) return;
      setSingleInput({
        markdown: file.markdown,
        filename: file.name,
        // 粘贴条目与文件条目一视同仁走单文件预览；粘贴无 sourcePath
        path: file.source === "file" ? file.path : "",
      });
      setStage("single");
    } else {
      setStage("batch");
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

  const hasBlankName = pickedFiles.some(
    (file) => file.name.trim().length === 0,
  );
  // 上传进行中不可预览（图片区有逐张状态与汇总，传完自动恢复可点）
  const canPreview =
    pickedFiles.length > 0 &&
    !hasBlankName &&
    !(addToCourseOn && courseSelection === "") &&
    companion.uploadingCount === 0;

  // 预览/确认步骤展示的随行图片清单（选择区选过图片才有；无实质内容时卡片不渲染）
  const mediaSummary = useMemo<ImportMediaSummary | null>(() => {
    if (companion.images.length === 0) return null;
    const failed = companion.images
      .filter((image) => companion.uploads[image.path]?.phase === "failed")
      .map((image) => ({
        name: image.name,
        reason: companion.uploads[image.path]?.error ?? "上传失败，请稍后重试",
      }));
    // 保持原样的引用处数：未配对 + 同名冲突 + 配对但上传失败（每个 src 预览时逐条核对）
    const failedSrcCount = [...companion.pairing.pairs.values()].filter(
      (path) => companion.uploads[path]?.phase === "failed",
    ).length;
    return {
      mdCount: pickedFiles.length,
      imageCount: companion.pairedPaths.size,
      uploadedCount: companion.uploadedCount,
      failed,
      unresolvedCount:
        companion.pairing.unmatched.length +
        companion.pairing.conflicts.length +
        failedSrcCount,
    };
  }, [companion, pickedFiles.length]);

  // 上传整体进度文案（进度条语义：已完成 = 成功 + 失败）
  const uploadTotal = companion.pairedPaths.size;
  const uploadDone = companion.uploadedCount + companion.failedCount;

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
        <div className="mx-auto mt-4 max-w-3xl">
          <h1 className="text-lg font-semibold">导入内容</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择 .md 与图片文件、整个文件夹或粘贴内容，加入同一份待导入清单；
            文档引用到的图片会自动上传并替换为服务器路径，预览无误后确认。
          </p>

          {/* AI 出题助手（T1.13）：复制「规范+样例+模板」提示词给 AI，产出可导入文档 */}
          <div className="mt-4">
            <AiPromptPanel />
          </div>

          <section
            // 拖拽投放区 = 整张清单卡（桌面拖文件/文件夹；见 handleDrop）。
            // 语义化 section + aria-label：键盘用户走上方三按钮入口，拖拽是
            // 桌面增强，不承担键盘可达性
            aria-label="待导入清单（可把 md 与图片拖入此处）"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={(event) => void handleDrop(event)}
            className={`mt-4 flex flex-col gap-4 rounded-xl border border-dashed p-4 transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            {/* 统一待导入清单：三入口同源（方案 §5） */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">待导入清单</span>
                {pickedFiles.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    共 {pickedFiles.length} 条
                    <button
                      type="button"
                      className="ml-2 rounded px-1 text-destructive underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      onClick={() => {
                        setPickedFiles([]);
                        companion.clear();
                        setPickNotice(null);
                      }}
                    >
                      清空清单
                    </button>
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".md,.markdown,text/markdown,image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                  onChange={(event) => void handleFiles(event)}
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
                  选择 md / 图片文件
                </Button>
                {SUPPORTS_DIRECTORY_PICKER ? (
                  <>
                    <input
                      ref={dirInputRef}
                      type="file"
                      multiple
                      // webkitdirectory 是非标准属性，React 不识别 → 用 ref 设置
                      onChange={(event) => void handleFiles(event)}
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
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 px-4"
                  aria-expanded={pasteOpen}
                  aria-controls="import-paste-area"
                  onClick={togglePaste}
                >
                  <ClipboardPaste aria-hidden />
                  粘贴内容
                </Button>
              </div>

              {/* 常驻提示：随行图片口径（可把 md 与图片/整个文件夹一起选择或拖入本卡片；
                  只上传被引用到的图片并替换引用，其余所选文件不上传） */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                可把 .md
                与其引用的图片（或整个文件夹）一起选择、拖入本区域：系统只会自动上传文档引用到的图片，并把引用替换为服务器路径；其余所选文件不会被上传。
              </p>

              {/* 最近一次选择的反馈：加入了什么 / 更新了哪些同名条目 / 忽略了
                  哪些文件及原因（审核修复：此前静默跳过，用户无从对账） */}
              {pickNotice !== null ? (
                <p
                  role="status"
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {pickNotice}
                </p>
              ) : null}

              {/* 粘贴输入区（展开式小面板；加入后清空，可连续粘贴多条） */}
              {pasteOpen ? (
                <div
                  id="import-paste-area"
                  className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3"
                >
                  <textarea
                    id="import-markdown"
                    aria-label="文档内容"
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    spellCheck={false}
                    placeholder={
                      "粘贴 Markdown 原文…\n\nv2 文档以 frontmatter 开头：\n---\nkind: practice\nunit: 练习四\nlecture: 第4讲 有理数   # 配套讲义名，可选\n---"
                    }
                    className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-[13px] leading-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 px-4"
                      disabled={pastedText.trim().length === 0}
                      onClick={handleAddPasted}
                    >
                      <Plus aria-hidden />
                      加入清单
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* 清单：只看名不看内容（正文检查交给预览态） */}
              {pickedFiles.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  清单为空：选择 md /
                  图片文件、整个文件夹，或用「粘贴内容」把文字加入清单。
                </p>
              ) : (
                <ul
                  aria-label="待导入清单"
                  className="flex flex-col divide-y divide-border rounded-lg border border-border"
                >
                  {pickedFiles.map((file) => (
                    <li
                      key={file.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5"
                    >
                      {/* 文件与粘贴条目都可就地改名（改名同步 path，目录前缀保留；
                          审核修复：此前文件条目只读，选错名只能回磁盘改文件重选） */}
                      <Input
                        aria-label={`重命名 ${file.path}`}
                        value={file.name}
                        onChange={(e) => handleRename(file.id, e.target.value)}
                        className="min-h-11 w-56"
                      />
                      {file.path !== file.name ? (
                        /* 文件夹选择时显示相对路径（含子目录前缀） */
                        <span
                          className="min-w-0 max-w-64 truncate text-xs text-muted-foreground"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                      ) : null}
                      {file.source === "paste" ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          粘贴
                        </span>
                      ) : null}
                      <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
                        {formatSizeKb(file.bytes)}
                      </span>
                      <button
                        type="button"
                        aria-label={`移除 ${file.path}`}
                        onClick={() => handleRemove(file.id)}
                        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <X aria-hidden className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* 随行图片：只列被引用到的（逐张上传结果），未引用只计数提示；
                  同名冲突不配对不改写（避免传错图），失败可整组重试 */}
              {companion.images.length > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Images aria-hidden className="size-4 shrink-0" />
                      关联图片
                    </span>
                    <span
                      className="text-xs text-muted-foreground"
                      // 上传中给进度（预览按钮同时禁用），传完给汇总
                    >
                      {companion.uploadingCount > 0
                        ? `自动上传中…（已完成 ${uploadDone} / 共 ${uploadTotal} 张）`
                        : `将上传 ${uploadTotal} 张 · 成功 ${companion.uploadedCount} · 失败 ${companion.failedCount}`}
                    </span>
                  </div>
                  <ul
                    aria-label="关联图片上传结果"
                    className="flex flex-col divide-y divide-border"
                  >
                    {companion.images
                      .filter((image) => companion.pairedPaths.has(image.path))
                      .map((image) => {
                        const state = companion.uploads[image.path];
                        return (
                          <li
                            key={image.path}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs"
                          >
                            <span
                              className="min-w-0 max-w-72 truncate font-mono"
                              title={image.path}
                            >
                              {image.path}
                            </span>
                            {state === undefined ||
                            state.phase === "uploading" ? (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <Loader2
                                  aria-hidden
                                  className="size-3.5 animate-spin"
                                />
                                上传中…
                              </span>
                            ) : state.phase === "uploaded" ? (
                              <span className="flex min-w-0 items-center gap-1 text-emerald-700 dark:text-emerald-300">
                                <CheckCircle2
                                  aria-hidden
                                  className="size-3.5 shrink-0"
                                />
                                <span
                                  className="truncate font-mono"
                                  title={state.serverSrc ?? ""}
                                >{`→ ${state.serverSrc ?? ""}`}</span>
                              </span>
                            ) : (
                              <span className="flex min-w-0 items-center gap-1 font-medium text-destructive">
                                <CircleAlert
                                  aria-hidden
                                  className="size-3.5 shrink-0"
                                />
                                {state.error}
                              </span>
                            )}
                          </li>
                        );
                      })}
                  </ul>
                  {companion.pairing.conflicts.length > 0 ? (
                    <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                      {companion.pairing.conflicts.map((conflict) => (
                        <p key={conflict.src}>
                          同名冲突：所选文件里有多个「{conflict.name}
                          」，无法确定「{conflict.src}
                          」对应哪一张，该引用未改写、未上传（不冒传错图的险）。请只保留一份同名文件后重新选择。
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {companion.failedCount > 0 &&
                  companion.uploadingCount === 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-fit px-3 text-xs"
                      onClick={companion.retryFailed}
                    >
                      <RefreshCw aria-hidden />
                      重试失败图片（{companion.failedCount} 张）
                    </Button>
                  ) : null}
                  {companion.unreferencedCount > 0 ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      另有 {companion.unreferencedCount}{" "}
                      个所选图片未被任何文档引用，不会上传。
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* 规模预检实时提示（超限不发预览请求） */}
              {precheckError !== null ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {precheckError}
                </p>
              ) : null}
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
                    清单达到 2 条批量导入时，可按文件所在子目录自动建文件夹。
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

            <div className="flex flex-col items-end gap-1.5">
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
              {/* 上传进行中说明预览为何不可点（传完自动恢复） */}
              {companion.uploadingCount > 0 ? (
                <p
                  role="status"
                  className="text-xs text-muted-foreground"
                >{`正在自动上传关联图片（${uploadDone}/${uploadTotal}），完成后可预览。`}</p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              上限：单批 ≤{IMPORT_MAX_FILES_PER_BATCH} 个文件、单文件 ≤1
              MB、合计 ≤10 MB。
            </p>
          </section>

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
                    // 触控目标 ≥44px（size-11，T4.7 与全局 dialog.tsx 同处理：
                    // -mr-1.5 外扩补偿保持图标中心原位，仅扩热区不改视觉位）
                    className="-mr-1.5 flex size-11 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
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
          mediaSummary={mediaSummary}
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
          mediaSummary={mediaSummary}
          onBack={() => {
            setStage("select");
            setPickedFiles([]);
            companion.clear();
          }}
        />
      )}
    </section>
  );
}

// 供 App.tsx 路由级懒加载
export default ImportPage;
