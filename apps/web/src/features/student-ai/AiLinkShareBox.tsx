import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AiLinkShareState } from "./use-ai-send-controller";

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
 */

/** 时间呈现（YYYY-MM-DD HH:mm；与 AiConversationPanel 同款格式） */
function formatShareTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  // 降级在途守卫（ref 而非 state）：同一渲染帧内连击闭包读到的 state 相同，
  // 只有 ref 同步可见——双击不产生第二次请求（不双记留痕/双写剪贴板）
  const degradeLoadingRef = useRef(false);

  // 链接 URL 变化（重新生成）即复位降级区：旧票据解析出的文字与材料清单
  // 不得残留展示在新链接下方（旧票据内容与新快照不对应）
  useEffect(() => {
    degradeLoadingRef.current = false;
    setDegrade(DEGRADE_IDLE);
  }, [link.url]);

  const loadDegrade = async (): Promise<void> => {
    if (degradeLoadingRef.current) return;
    degradeLoadingRef.current = true;
    setDegrade({
      ...DEGRADE_IDLE,
      phase: "loading",
      message: "正在读取分享内容…",
    });
    let response: Response;
    try {
      response = await fetch(link.url);
    } catch {
      degradeLoadingRef.current = false;
      setDegrade({
        ...DEGRADE_IDLE,
        phase: "error",
        message:
          "读取分享内容失败（网络问题），请稍后重试；链接本身仍可发给外部 AI",
      });
      return;
    }
    degradeLoadingRef.current = false;
    if (!response.ok) {
      // 403/404：票据失效或当前模式禁用——服务端逐次实时核对后的拒绝；
      // 其余状态码（500 等）是服务端瞬时故障，不归因失效也不误导重新生成
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
    let copied = false;
    try {
      if (navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    setDegrade({
      phase: "ok",
      message: copied
        ? "已复制本题文字（含答案解析），可直接粘贴给外部 AI"
        : "自动复制失败：请手动选择下方文字复制",
      text: copied ? null : text,
      materials,
    });
  };

  return (
    <section
      aria-label="AI 链接"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-2 py-2"
    >
      <p className="text-xs font-medium">{questionLabel ?? "本题"}的 AI 链接</p>
      <p className="text-xs text-muted-foreground">
        生成时刻：{formatShareTime(link.snapshotAt)}｜有效期至：
        {formatShareTime(link.expiresAt)}
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
