/**
 * 任意笔记版本的只读查看组件（T6R.15 D）：按 versionId + viewer 直接渲染
 * 订正/补充稿等非原稿版本——与 NoteOriginalView（按证据行定位本次原稿）
 * 互补，正文渲染核共用 use-note-version-view（抽共享而非复制）。
 *
 * 硬性口径（继承 NoteOriginalView 的只读纪律）：
 * - **只读**：不 PUT、不触碰 note/note_versions/submission_evidence 任何
 *   状态；本组件也没有补图入口——任意版本的派生图行不在任何 head 投影里
 *   （head.images 恒指 scratch 生效版本），查看侧本地确定性渲染不受服务端
 *   图片缺失影响，重建通道留给有图片行数据的视图（NoteOriginalView）；
 * - 三态互斥：折叠（零请求）/读取错误（→ 重试，不吞错）/就绪（analysis
 *   规格整逻辑宽切片 + 笔数 + 时间/次序元信息行）；
 * - 元信息（标题/时间/次序/说明/反思分栏）由调用方以 props 传入——组件
 *   不假设订正/补充稿的字段来源，结果页与题目笔记本共用同一渲染。
 */

import {
  CircleAlert,
  LoaderCircle,
  type LucideIcon,
  RotateCcw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { NoteRole } from "@/lib/api";
import { formatCnTime } from "@/lib/time";
import { useNoteVersionBody } from "./use-note-version-view";

export interface NoteVersionViewProps {
  /** 查看角色（api 层 NoteRole：学生本人 / 教师域链授权） */
  viewer: NoteRole;
  /** 目标版本（note_versions.id）；null 不渲染（调用方自判空态） */
  versionId: string | null;
  /** 面板标题（如「订正」「补充稿」） */
  title: string;
  /** 入口按钮文案（如「查看订正」「查看补充稿」） */
  openLabel: string;
  /** 时间前缀文案（如「封存于」「保存于」） */
  savedAtLabel: string;
  /** 展示时间（UTC ISO；订正=sealedAt、补充稿=serverSavedAt） */
  savedAt: string;
  /** 正文保存次序（noteRecordMeta.revision；0=尚未产生版本，不显示次序） */
  revision: number;
  /** 无障碍标签前缀（如「第 3 题」），拼入按钮与图片 alt */
  ariaPrefix?: string;
  /** 面板内附加内容（反思分栏等）；折叠态不渲染 */
  extra?: ReactNode;
  /** 标题图标（订正/补充稿视觉区分；缺省不显示图标） */
  icon?: LucideIcon;
}

export function NoteVersionView({
  viewer,
  versionId,
  title,
  openLabel,
  savedAtLabel,
  savedAt,
  revision,
  ariaPrefix = "本题",
  extra,
  icon: Icon,
}: NoteVersionViewProps) {
  const body = useNoteVersionBody(viewer);
  const { resetBody } = body;

  const open = useCallback(() => {
    if (versionId === null) return;
    // 失败由 body.phase 的 error 态呈现（openBody 抛错前置好 error 相位，
    // 这里吞掉重复通道——面板以 phase 为唯一渲染依据）
    body.openBody(versionId).catch(() => undefined);
  }, [body, versionId]);

  // versionId 变化守卫（列表复用实例的定位变化）：弃缓存回折叠态——旧
  // 版本的渲染页与 URL 不能带入新版本（缓存清理对折叠态同样必要：重开
  // 不得命中旧版本缓存）
  const prevVersionRef = useRef(versionId);
  useEffect(() => {
    if (prevVersionRef.current === versionId) return;
    prevVersionRef.current = versionId;
    resetBody();
  }, [versionId, resetBody]);

  if (versionId === null) return null;

  const label = `${ariaPrefix}${title}`;

  // ---- 折叠态：入口按钮（零请求；点击才拉正文） ----
  if (body.phase.kind === "closed") {
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-fit"
        aria-label={`${ariaPrefix}${openLabel}`}
        onClick={open}
      >
        {Icon !== undefined && <Icon aria-hidden className="size-4" />}
        {openLabel}
      </Button>
    );
  }

  // ---- 展开态：面板 ----
  return (
    <div
      data-slot="note-version-view"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {Icon !== undefined && <Icon aria-hidden className="size-4" />}
          {title}
        </p>
        <Button
          type="button"
          variant="ghost"
          className="ml-auto h-11 px-2.5"
          aria-label={`收起${label}`}
          onClick={body.closeBody}
        >
          收起
        </Button>
      </div>

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {savedAtLabel} {formatCnTime(savedAt)}
        </span>
        {revision >= 1 && <span>正文第 {revision} 次保存</span>}
        {body.phase.kind === "ready" && (
          <span>{body.phase.strokeCount} 笔</span>
        )}
      </p>

      {extra}

      {body.phase.kind === "loading" && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          正在读取{title}…
        </p>
      )}

      {body.phase.kind === "error" && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm"
        >
          <p className="flex items-center gap-1.5">
            <CircleAlert
              aria-hidden
              className="size-4 shrink-0 text-destructive"
            />
            {title}读取失败：{body.phase.message}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={open}
          >
            <RotateCcw aria-hidden className="size-4" />
            重试
          </Button>
        </div>
      )}

      {body.phase.kind === "ready" && (
        <div className="flex flex-col gap-2">
          {body.phase.urls.map((url, index) => (
            <img
              key={url}
              src={url}
              alt={`${label} 第 ${index + 1} 页`}
              className="w-full rounded-lg border border-border bg-white"
            />
          ))}
        </div>
      )}
    </div>
  );
}
