import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postTeacherMediaApi } from "@/lib/api";
import type { PickedFile } from "./ImportPage";
import {
  MEDIA_UPLOAD_CONCURRENCY,
  pairImageRefs,
  type ImagePairing,
} from "./companion-media";

/**
 * 导入随行图片的编排 hook（配对/上传/改写映射，全部前端完成、服务端零改动）：
 * - registerImages：选择文件时把图片候选收进清单（同 path 原位替换并重置该文件
 *   的上传状态——重新选择的文件内容可能已变，重传由服务端内容寻址天然幂等）；
 * - 配对以清单条目的 imageRefs 快照（加入那一刻提取的 ::image src）取并集，
 *   不受 src 改写影响；粘贴后补选图片、补选后重选 md 都能对上；
 * - 只对「被任一 md 引用到的文件」调 POST /api/teacher/media，并发上限
 *   MEDIA_UPLOAD_CONCURRENCY（3），单张失败不阻断其余、失败引用不改写；
 * - rewriteMap：已上传文件的 src → 服务端真实路径，由 ImportPage 落到清单条目
 *   的 markdown 上（幂等：改写后文本不含原 src，重复应用无变化）。
 */

/** 所选图片文件（File 仅在被引用需要上传时才交给接口层；未引用的零读取） */
export interface CompanionImageInput {
  /** 相对路径（选择范围内唯一 = 身份；同 path 重选 = 替换） */
  readonly path: string;
  /** basename */
  readonly name: string;
  readonly size: number;
  readonly file: File;
}

/** 单张图片的上传状态（按 path 记录） */
export interface CompanionUploadState {
  readonly phase: "uploading" | "uploaded" | "failed";
  /** 成功后的服务端 src（blobs/media/<sha256>.<ext>） */
  readonly serverSrc?: string;
  /** 失败原因（服务端中文文案原样透出） */
  readonly error?: string;
}

export interface UseCompanionImages {
  /** 收进新的图片候选（同 path 替换并重置上传状态） */
  readonly registerImages: (files: readonly File[]) => void;
  /** 清空（「清空清单」与批量导入返回时调用） */
  readonly clear: () => void;
  /** 重试全部失败图片（清除 failed 状态 → 上传 effect 重新发起） */
  readonly retryFailed: () => void;
  readonly images: readonly CompanionImageInput[];
  readonly pairing: ImagePairing;
  /** 被引用到（将上传）的文件 path 集合 */
  readonly pairedPaths: ReadonlySet<string>;
  readonly uploads: Readonly<Record<string, CompanionUploadState>>;
  /** 已配对 src → 服务端真实路径（ImportPage 据此改写清单条目 markdown） */
  readonly rewriteMap: ReadonlyMap<string, string>;
  readonly uploadingCount: number;
  readonly uploadedCount: number;
  readonly failedCount: number;
  /** 未被任何 md 引用的图片张数（不上传、不读内容，只计数提示） */
  readonly unreferencedCount: number;
}

export function useCompanionImages(
  pickedFiles: readonly PickedFile[],
): UseCompanionImages {
  const [images, setImages] = useState<CompanionImageInput[]>([]);
  const [uploads, setUploads] = useState<Record<string, CompanionUploadState>>(
    {},
  );
  // 真正 in-flight 的 path（effect 重入/StrictMode 双跑时防重复发起；
  // state 里虽有 uploading 相，setUpdates 是异步的，同一轮 effect 内挡不住）
  const inFlightRef = useRef<Set<string>>(new Set());

  const registerImages = useCallback((files: readonly File[]): void => {
    if (files.length === 0) return;
    setImages((prev) => {
      const byPath = new Map(prev.map((image) => [image.path, image]));
      for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        const path =
          relative !== undefined && relative.length > 0 ? relative : file.name;
        byPath.set(path, {
          path,
          name: file.name,
          size: file.size,
          file,
        });
      }
      return [...byPath.values()];
    });
    // 重新选择的 path 内容可能已变：重置上传状态（重传幂等，服务端内容寻址）
    setUploads((prev) => {
      const next = { ...prev };
      for (const file of files) {
        const relative = (file as File & { webkitRelativePath?: string })
          .webkitRelativePath;
        const path =
          relative !== undefined && relative.length > 0 ? relative : file.name;
        delete next[path];
      }
      return next;
    });
  }, []);

  const clear = useCallback((): void => {
    setImages([]);
    setUploads({});
  }, []);

  const retryFailed = useCallback((): void => {
    setUploads((prev) => {
      const next: Record<string, CompanionUploadState> = {};
      for (const [path, state] of Object.entries(prev)) {
        if (state.phase !== "failed") next[path] = state;
      }
      return next;
    });
  }, []);

  // 配对口径：清单各条目「加入那一刻」的 ::image src 快照（PickedFile.imageRefs）
  // 取并集——正文里的 src 被改写成服务器路径后原引用名就不在 markdown 里了，
  // 用正文实时提取会让配对与上传统计在改写后「失忆」（引用消失、图片从待传
  // 清单掉队）；快照在重选同名 md 时随条目替换刷新，幂等重导不受影响
  const pairing = useMemo(() => {
    const refs = new Set<string>();
    for (const file of pickedFiles) {
      for (const ref of file.imageRefs) refs.add(ref);
    }
    return pairImageRefs(
      [...refs],
      images.map((image) => ({
        path: image.path,
        name: image.name,
        size: image.size,
      })),
    );
  }, [pickedFiles, images]);

  const pairedPaths = useMemo(
    () => new Set(pairing.pairs.values()),
    [pairing],
  );

  // 上传编排：只发起「已配对且未在途、无终态」的文件，填满并发额度即止；
  // 每次 uploads/pairing 变化后重跑，自然续上下一段（滚动窗口式 3 并发）
  useEffect(() => {
    const free = MEDIA_UPLOAD_CONCURRENCY - inFlightRef.current.size;
    if (free <= 0) return;
    const toStart: CompanionImageInput[] = [];
    for (const image of images) {
      if (toStart.length >= free) break;
      if (!pairedPaths.has(image.path)) continue;
      if (inFlightRef.current.has(image.path)) continue;
      if (uploads[image.path] !== undefined) continue;
      toStart.push(image);
    }
    if (toStart.length === 0) return;
    for (const image of toStart) {
      inFlightRef.current.add(image.path);
      setUploads((prev) => ({
        ...prev,
        [image.path]: { phase: "uploading" },
      }));
      void (async () => {
        try {
          const result = await postTeacherMediaApi(image.file);
          setUploads((prev) => ({
            ...prev,
            [image.path]: { phase: "uploaded", serverSrc: result.src },
          }));
        } catch (err) {
          // 单张失败不阻断其余：该文件对应的 src 不改写，原因逐张透出
          setUploads((prev) => ({
            ...prev,
            [image.path]: {
              phase: "failed",
              error:
                err instanceof Error && err.message.length > 0
                  ? err.message
                  : "上传失败，请稍后重试",
            },
          }));
        } finally {
          inFlightRef.current.delete(image.path);
        }
      })();
    }
  }, [images, pairing, pairedPaths, uploads]);

  // 已上传 → src 改写映射（多 md 引用同一张图时多个 src 指向同一 serverSrc）
  const rewriteMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [src, path] of pairing.pairs) {
      const state = uploads[path];
      if (state?.phase === "uploaded" && state.serverSrc !== undefined) {
        map.set(src, state.serverSrc);
      }
    }
    return map;
  }, [pairing, uploads]);

  const uploadingCount = useMemo(
    () =>
      [...pairedPaths].filter((path) => uploads[path]?.phase === "uploading")
        .length,
    [pairedPaths, uploads],
  );
  const uploadedCount = useMemo(
    () =>
      [...pairedPaths].filter((path) => uploads[path]?.phase === "uploaded")
        .length,
    [pairedPaths, uploads],
  );
  const failedCount = useMemo(
    () =>
      [...pairedPaths].filter((path) => uploads[path]?.phase === "failed")
        .length,
    [pairedPaths, uploads],
  );
  const unreferencedCount = useMemo(() => {
    const conflictNames = new Set(
      pairing.conflicts.map((conflict) => conflict.name),
    );
    return images.filter(
      (image) =>
        !pairedPaths.has(image.path) && !conflictNames.has(image.name),
    ).length;
  }, [images, pairing, pairedPaths]);

  return {
    registerImages,
    clear,
    retryFailed,
    images,
    pairing,
    pairedPaths,
    uploads,
    rewriteMap,
    uploadingCount,
    uploadedCount,
    failedCount,
    unreferencedCount,
  };
}
