import type { AiShareAccessStatusData } from "@tutor/contract";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, fetchStudentAiShareAccessStatusApi } from "@/lib/api";
import { formatSnapshotTime } from "./AiConversationPanel";
import { buildAiLinkPrompt } from "./ai-link-prompt";
import {
  type AiLinkShareState,
  writeToClipboard,
} from "./use-ai-send-controller";

/**
 * SAI-30 链接查看/复制/降级组件（B15）：伴学栏链接通道的结果区。
 *
 * - 呈现面：题号/生成时刻/有效期（帮助识别缓存旧内容）+「获得链接者
 *   可读取本题参考答案与解析」如实说明（需求 §10：不能靠「仅供 AI 阅读」
 *   字样保密）；链接恒可见可选（手动复制兜底，复制失败不丢链接）。
 * - 动作面：重试复制（只碰剪贴板，控制器保证零 API 调用）、重新生成
 *   （旧任务上新票据，仍按当前权限服务端实时裁决）、撤销（整批失效）。
 * - 降级面（外部 AI 读不了链接时）：拉取票据自身 URL 的分享正文——授权
 *   与留痕都走这条真实链路（服务端逐次实时核对，未完成/已失效即拒）；
 *   提取文字入剪贴板、解析材料清单渲染下载项；缺件如实说明不伪装下载。
 *   不替换原有普通导出行为（导出本题入口不受影响）。
 * - 本组件不产生「已回信/已收到」口径：外部未写回平台不冒充完成。
 * - 重新生成（URL 变化）由父级以 key=link.url 挂载复位降级区：旧票据
 *   解析的文字与材料清单不得残留展示在新链接下方。
 */

/** 降级解析出的材料条目：就绪附件给下载链接；缺失项只给说明（id 为
 *  解析时生成的稳定标识——列表只渲染不重排，序号即稳定） */
type DegradeMaterial =
  | { readonly id: string; readonly href: string; readonly label: string }
  | { readonly id: string; readonly missing: string };

interface DegradeState {
  readonly phase: "idle" | "loading" | "ok" | "error";
  readonly message: string | null;
  /** 剪贴板失败时的手动复制文本（成功复制则不重复展示） */
  readonly text: string | null;
  readonly materials: readonly DegradeMaterial[] | null;
}

const DEGRADE_IDLE: DegradeState = {
  phase: "idle",
  message: null,
  text: null,
  materials: null,
};

/** 从分享正文 HTML 解析材料清单（只认本票据 materials 链接，缺件项无 a） */
function parseMaterials(html: string): DegradeMaterial[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("ul.materials li")].map((item, index) => {
    const anchor = item.querySelector("a[href]");
    if (anchor !== null) {
      return {
        id: `material-${index}`,
        href: anchor.getAttribute("href") ?? "",
        label: anchor.textContent?.trim() || "材料",
      };
    }
    return {
      id: `material-${index}`,
      missing: item.textContent?.trim() || "材料不可用",
    };
  });
}

export function AiLinkShareBox({
  questionLabel,
  link,
  sending,
  onRegenerate,
  onRevoke,
  onRetryCopy,
}: {
  /** 绑定题显示名（如「第 3 题」）；未提供时回落「本题」 */
  questionLabel: string | null;
  link: AiLinkShareState;
  /** 控制器动作在途（重新生成/撤销期间禁用对应按钮） */
  sending: boolean;
  onRegenerate: () => void;
  onRevoke: () => void;
  onRetryCopy: () => void;
}) {
  const [degrade, setDegrade] = useState<DegradeState>(DEGRADE_IDLE);
  const prompt = useMemo(() => buildAiLinkPrompt(link.url), [link.url]);
  const [accessStatus, setAccessStatus] =
    useState<AiShareAccessStatusData | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  async function loadAccessStatus() {
    setAccessLoading(true);
    setAccessError(null);
    try {
      setAccessStatus(await fetchStudentAiShareAccessStatusApi(link.taskId));
    } catch (error) {
      setAccessError(
        error instanceof ApiError
          ? error.message
          : "访问记录读取失败，请重试。",
      );
    } finally {
      setAccessLoading(false);
    }
  }
  // 降级在途守卫（ref 而非 state）：同一渲染帧内连击闭包读到的 state 相同，
  // 只有 ref 同步可见——双击不产生第二次请求（不双记留痕/双写剪贴板）
  const degradeLoadingRef = useRef(false);

  const loadDegrade = async (): Promise<void> => {
    if (degradeLoadingRef.current) return;
    degradeLoadingRef.current = true;
    setDegrade({
      ...DEGRADE_IDLE,
      phase: "loading",
      message: "正在读取分享内容…",
    });
    try {
      const response = await fetch(link.url, { cache: "no-store" });
      if (!response.ok) {
        setDegrade({
          ...DEGRADE_IDLE,
          phase: "error",
          message:
            response.status === 403 || response.status === 404
              ? "链接已失效或当前无权限，复制与下载被拒绝；可重新生成链接"
              : "分享内容读取失败（服务暂时不可用），请稍后重试；链接本身仍可发给外部 AI",
        });
        return;
      }
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = (doc.body?.textContent ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const materials = parseMaterials(html);
      const copied = await writeToClipboard(text);
      setDegrade({
        phase: "ok",
        message: copied
          ? "已复制本题文字（含答案解析），可直接粘贴给外部 AI"
          : "自动复制失败：请手动选择下方文字复制",
        text: copied ? null : text,
        materials,
      });
    } catch {
      setDegrade({
        ...DEGRADE_IDLE,
        phase: "error",
        message:
          "读取分享内容失败（网络问题），请稍后重试；链接本身仍可发给外部 AI",
      });
    } finally {
      // 读完正文和复制后才释放；响应中断同样可恢复重试。
      degradeLoadingRef.current = false;
    }
  };

  return (
    <section
      aria-label="AI 链接"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-2 py-2"
    >
      <p className="text-xs font-medium">{questionLabel ?? "本题"}的 AI 链接</p>
      <p className="text-xs text-muted-foreground">
        生成时刻：{formatSnapshotTime(link.snapshotAt)}｜有效期至：
        {formatSnapshotTime(link.expiresAt)}
      </p>
      <p className="text-xs text-muted-foreground">
        获得链接者可读取本题参考答案、解析与选定材料；链接有有效期且可撤销。
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">AI 链接</span>
        <input
          type="text"
          readOnly
          aria-label="AI 链接"
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-9 w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        一条链接只含一道题。可发送多条独立链接，请让 AI
        每次逐条重新打开并核对题号；复制成功不代表 AI
        已读取。内容是生成时的快照，修改作答后需更新求助内容再重新生成。
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">
          发给 AI 的内容（含重新读取说明）
        </span>
        <textarea
          aria-label="发给 AI 的内容"
          readOnly
          value={prompt}
          rows={5}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full resize-y rounded-lg border border-input bg-background p-2 text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
        />
      </label>
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9 px-2"
          onClick={onRetryCopy}
        >
          重试复制
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9 px-2"
          disabled={sending}
          onClick={onRegenerate}
        >
          重新生成链接
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9 px-2"
          disabled={sending}
          onClick={onRevoke}
        >
          撤销链接
        </Button>
      </div>
      <div className="space-y-2 border-t border-border pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9"
          disabled={accessLoading}
          onClick={() => void loadAccessStatus()}
        >
          {accessLoading
            ? "正在查询访问记录…"
            : accessStatus
              ? "刷新访问记录"
              : "查看访问记录"}
        </Button>
        {accessError && (
          <p role="alert" className="text-xs text-destructive">
            {accessError}
          </p>
        )}
        {accessStatus && (
          <p role="status" className="text-xs text-muted-foreground">
            {accessStatus.viewCount === 0
              ? "尚未收到本题链接的访问请求，请让 AI 重新打开链接。"
              : `本题所有链接累计被访问 ${accessStatus.viewCount} 次（含旧链接），最近访问：${formatSnapshotTime(accessStatus.lastViewedAt ?? "")}。`}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          访问可能来自你、网页预览或 AI，不能证明 AI 已阅读或理解。请让 AI
          先复述题号与题干进行核对。
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        重新生成与撤销仍按当前教学模式实时校验；已复制出去的内容无法收回。
      </p>
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-9 self-start px-2"
          disabled={degrade.phase === "loading"}
          onClick={() => void loadDegrade()}
        >
          {degrade.phase === "loading"
            ? "正在读取…"
            : "外部读不了？复制本题文字"}
        </Button>
        {degrade.message !== null && (
          <p role="status" className="text-xs text-muted-foreground">
            {degrade.message}
          </p>
        )}
        {degrade.text !== null && (
          <textarea
            readOnly
            rows={6}
            aria-label="分享正文（手动复制）"
            className="min-h-11 w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={degrade.text}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
        {degrade.materials !== null &&
          (degrade.materials.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {degrade.materials.map((item) =>
                "href" in item ? (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      download
                      className="min-h-9 text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {item.label}
                    </a>
                  </li>
                ) : (
                  <li key={item.id} className="text-xs text-muted-foreground">
                    {item.missing}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              本次分享未附带材料。
            </p>
          ))}
      </div>
    </section>
  );
}
