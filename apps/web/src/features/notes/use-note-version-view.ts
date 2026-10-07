/**
 * 按版本 id 取正文并确定性渲染的共享视图核（T6R.15 单3，D 裁决「抽共享
 * 而非复制」路径）：从 NoteOriginalView 抽出「fetchNoteDocumentApi →
 * parseNoteDocOrThrow → renderNoteImages("analysis") → object URL 落地」
 * 核心链路，NoteOriginalView（按证据行定位原稿）与 NoteVersionView（按
 * versionId 直接渲染任意版本——订正/补充稿查看）共用。
 *
 * 口径照搬 NoteOriginalView 原实现（T6R.11 复审结论不随搬家丢失）：
 * - **重展开缓存**只存 {versionId, pages, strokeCount}（不常驻 NoteDoc——
 *   每卡数 MB），同版本重开免下载免渲染，URL 从缓存 blob 重建；
 * - **epoch 代际守卫**：close/reset/卸载后迟到的异步结果不落地任何状态；
 * - **object URL 生命周期**：landReady 单点（创建→登记→setPhase），重开/
 *   重试/收起/卸载即 revoke，无堆积；
 * - load 是单个 await，中途收起不中断渲染——有界浪费（离屏渲完即弃、
 *   epoch 守卫保证 URL 不落地，无泄漏），不加 abort 机制（T6R.11 取舍）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { parseNoteDocOrThrow } from "@/features/notes/note-fixtures";
import {
  type RenderedNotePage,
  renderNoteImages,
} from "@/features/notes/render-note";
import type { NoteRole } from "@/lib/api";
import { fetchNoteDocumentApi } from "@/lib/note-endpoints";

/** 正文阶段（单一判别联合：一次 set 完成迁移，无中间组合态） */
export type NoteVersionBodyPhase =
  /** 折叠态（零请求零渲染） */
  | { kind: "closed" }
  | { kind: "loading" }
  /** 读取/解析/渲染失败 */
  | { kind: "error"; message: string }
  | { kind: "ready"; versionId: string; urls: string[]; strokeCount: number };

/** openBody 成功时的就绪载荷（消费方据此拼自己的元信息行） */
export interface NoteVersionBodyReady {
  versionId: string;
  urls: string[];
  strokeCount: number;
}

/** 重展开缓存：收起不清（blob 仍在内存），重开同版本免下载免渲染 */
interface VersionBodyCache {
  versionId: string;
  pages: RenderedNotePage[];
  strokeCount: number;
}

export interface NoteVersionBodyHandle {
  phase: NoteVersionBodyPhase;
  /**
   * 展开指定版本：缓存命中免下载免渲染。成功返回就绪载荷；**stale（期间
   * close/reset/换版本）返回 null 且不落地**；读取/解析/渲染失败抛错（相位
   * 已置 error——直接消费方可以只看 phase，包装方自行落自己的错误态）。
   */
  openBody: (versionId: string) => Promise<NoteVersionBodyReady | null>;
  /** 收起（epoch 拦在途结果；缓存保留供重展开；URL 回收） */
  closeBody: () => void;
  /** 定位变化守卫：弃缓存回折叠态（外部 attemptId/questionId/versionId
   * 变化时由消费方调用——旧渲染页与 URL 不带入新定位） */
  resetBody: () => void;
}

export function useNoteVersionBody(viewer: NoteRole): NoteVersionBodyHandle {
  const [phase, setPhase] = useState<NoteVersionBodyPhase>({ kind: "closed" });
  /** 加载代际：卸载/收起/重开后迟到的异步结果不再落地 */
  const epochRef = useRef(0);
  /** 在役 object URL（替换/收起/卸载时成批 revoke） */
  const urlsRef = useRef<string[]>([]);
  /** 最近一次就绪的渲染页与笔迹数（重展开缓存；定位变化弃） */
  const cacheRef = useRef<VersionBodyCache | null>(null);

  const revokeUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  /** 就绪落地单点：URL 不变量（创建→登记→setPhase）只此一处维护 */
  const landReady = useCallback((ready: NoteVersionBodyReady) => {
    urlsRef.current = ready.urls;
    setPhase({ kind: "ready", ...ready });
  }, []);

  // 卸载回收：URL revoke 走同一原语；epoch 自增拦在途结果；缓存随组件释放
  useEffect(
    () => () => {
      epochRef.current += 1;
      cacheRef.current = null;
      revokeUrls();
    },
    [revokeUrls],
  );

  const openBody = useCallback(
    async (versionId: string): Promise<NoteVersionBodyReady | null> => {
      const epoch = epochRef.current + 1;
      epochRef.current = epoch;
      revokeUrls();
      setPhase({ kind: "loading" });
      try {
        const cached = cacheRef.current;
        if (cached !== null && cached.versionId === versionId) {
          // 缓存命中：同版本免下载免渲染（blob 在缓存内未回收，URL 重建）
          const ready: NoteVersionBodyReady = {
            versionId,
            urls: cached.pages.map((page) => URL.createObjectURL(page.blob)),
            strokeCount: cached.strokeCount,
          };
          landReady(ready);
          return ready;
        }
        const raw = await fetchNoteDocumentApi(viewer, versionId);
        if (epoch !== epochRef.current) return null;
        // 错误文案主语由消费方语境定（原稿/订正/补充稿），这里用中性词；
        // 包装方（NoteOriginalView）会替换为自己的错误态文案
        const doc = parseNoteDocOrThrow(raw, "笔记版本正文", "，无法查看");
        // 确定性渲染走渲染骨架共用入口（renderNoteImages：入口级包围盒缓存 +
        // 页间显式 yieldToMain + 离屏画布渲完即移除；取舍同 T6R.11——load 是
        // 单个 await，中途收起不中断渲染，epoch 守卫保证 URL 不落地）
        const pages = await renderNoteImages(doc, "analysis");
        if (epoch !== epochRef.current) return null;
        cacheRef.current = {
          versionId,
          pages,
          strokeCount: doc.ink.strokes.length,
        };
        const ready: NoteVersionBodyReady = {
          versionId,
          urls: pages.map((page) => URL.createObjectURL(page.blob)),
          strokeCount: doc.ink.strokes.length,
        };
        landReady(ready);
        return ready;
      } catch (err) {
        if (epoch !== epochRef.current) return null;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : "网络异常",
        });
        throw err;
      }
    },
    [viewer, revokeUrls, landReady],
  );

  const closeBody = useCallback(() => {
    epochRef.current += 1; // 在途加载作废（缓存保留供重展开）
    revokeUrls();
    setPhase({ kind: "closed" });
  }, [revokeUrls]);

  const resetBody = useCallback(() => {
    epochRef.current += 1;
    cacheRef.current = null;
    revokeUrls();
    setPhase({ kind: "closed" });
  }, [revokeUrls]);

  return { phase, openBody, closeBody, resetBody };
}
