import { Settings2, Sparkles, X } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useDynamicOverscroll } from "@/lib/use-dynamic-overscroll";
import { CHANNEL_LABEL } from "./ai-channel-label";
import type { AiCompanionLayoutController } from "./ai-companion-layout";
import { useStudentAiConnections } from "./ai-connection-queries";

/**
 * SAI-19 伴学栏视图壳（B10）：只做安全的栏壳与布局，不含真实发送/对话。
 * - dock 模式：右侧文档流内栏列（sticky、可滚动、宽 w-80 固定占位）；
 * - panel 模式：窄屏退为可关闭的独立面板（Sheet 浮层，Esc 关闭、焦点
 *   返回触发按钮），主区不被挤占；
 * - 通道状态如实呈现（未连接/已配置），入口不向用户假报已可连接；
 * - 栏内分区沿用需求规格 §7.1 顺序：题目绑定信息、通道/模式、快捷按钮、
 *   发送输入、当前材料、本题对话记录；SAI-20 起真实会话内容（状态区/
 *   快捷按钮/输入区）经 props 注入，未注入的分区保留合成占位或诚实回退
 *   （合成子内容同样经 props 注入用于空间测试）。
 */

export const AiCompanionTrigger = forwardRef<
  HTMLButtonElement,
  {
    controller: AiCompanionLayoutController;
    /** 入口名（作答态「AI 助教」；结果页完成后按 §7.5 显示「AI 复盘」） */
    label?: string | undefined;
    /** 题卡入口的局部选中态；未传时跟随共享面板状态 */
    expanded?: boolean | undefined;
    questionId?: string | undefined;
    onPress?: ((trigger: HTMLButtonElement) => void) | undefined;
  }
>(function AiCompanionTrigger(
  { controller, label = "AI 助教", expanded, onPress, questionId },
  ref,
) {
  const isExpanded = expanded ?? controller.open;
  return (
    <Button
      ref={ref}
      data-ai-trigger-question={questionId}
      type="button"
      variant="ghost"
      className={`size-11 shrink-0 p-0 ${isExpanded ? "bg-primary/10 text-primary" : ""}`}
      aria-label={label}
      title={label}
      aria-expanded={isExpanded}
      aria-pressed={isExpanded}
      data-ai-selected={isExpanded ? "true" : "false"}
      aria-controls={controller.panelId}
      onClick={(event) => {
        if (onPress !== undefined) {
          onPress(event.currentTarget);
          return;
        }
        if (isExpanded) controller.closePanel();
        else void controller.openPanel();
      }}
    >
      <Sparkles aria-hidden className="size-5" />
    </Button>
  );
});

/** 通道/模式区：只呈现真实连接状态，不宣称可发送（B10 无发送能力） */
function AiCompanionChannelStatus({ settingsHref }: { settingsHref: string }) {
  const query = useStudentAiConnections();
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        正在确认连接状态…
      </p>
    );
  if (query.isError)
    return (
      <p className="text-xs text-muted-foreground">
        连接状态读取失败，无法确认是否已连接
      </p>
    );
  const connections = query.data?.connections ?? [];
  if (connections.length === 0)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">未连接 AI 服务</p>
        <Link
          to={settingsHref}
          className="min-h-11 self-start text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          去设置连接
        </Link>
      </div>
    );
  const fallback = connections.find((item) => item.isDefault);
  const label =
    fallback === undefined
      ? null
      : fallback.channel === "inapp"
        ? fallback.model
        : CHANNEL_LABEL[fallback.channel];
  return (
    <p className="text-xs text-muted-foreground">
      已配置 {connections.length} 个 AI 通道
      {label === null ? "" : `（默认：${label}）`}，发送与对话功能建设中
    </p>
  );
}

interface PanelBodyProps {
  flow?: boolean;
  onFix?: (() => void) | undefined;
  fixed?: boolean;
  closeLabel?: string;
  questionLabel: string | null;
  settingsHref: string;
  /** dock 模式的关闭按钮（panel 模式由 Sheet 内建关闭提供） */
  dockCloseRef?: RefObject<HTMLButtonElement | null>;
  onDockClose?: () => void;
  /** 会话状态区（SAI-20 真实注入；未注入时保留合成的诚实回退） */
  status?: ReactNode;
  compactStatus?: ReactNode;
  /** 需要立刻让用户看见的设置问题（未连接/状态读取失败）——抽屉自动展开 */
  settingsAttention?: boolean | undefined;
  /** 合成子内容（空间测试注入；生产留空显示占位） */
  quickButtons?: ReactNode;
  /** 发送输入区（SAI-20 真实注入；未注入时不渲染该分区） */
  composer?: ReactNode;
  conversation?: ReactNode;
}

export function AiCompanionPanelBody({
  flow = false,
  onFix,
  fixed = false,
  closeLabel = "关闭 AI 助教",
  questionLabel,
  settingsHref,
  dockCloseRef,
  onDockClose,
  status,
  compactStatus,
  settingsAttention = false,
  quickButtons,
  composer,
  conversation,
}: PanelBodyProps) {
  const [settingsOpen, setSettingsOpen] = useState(settingsAttention);
  const settingsId = useId();
  // 对话记录区按需挂载 overscroll-contain：未溢出时滚轮透传外层页面滚动。
  // flow 布局下该区不滚动、类名不被消费，关闭观察避免与外层容器重复观察
  const replyOverscroll = useDynamicOverscroll<HTMLElement>({
    enabled: !flow,
  });
  // 未连接/状态读取失败时把设置展开一次，不让问题藏在抽屉里
  useEffect(() => {
    if (settingsAttention) setSettingsOpen(true);
  }, [settingsAttention]);
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${flow ? "ai-companion-inline" : ""}`}
    >
      <div
        className={`flex shrink-0 items-center gap-1 border-b border-border py-1 pl-3 ${
          // Sheet 模式右上角有内建关闭按钮（absolute），头部让出位置避免重叠
          onDockClose ? "pr-2" : "pr-11"
        }`}
      >
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          AI 助教
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {questionLabel ?? "未绑定题目"}
        </span>
        {onFix && (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 shrink-0 px-2"
            onClick={onFix}
          >
            {fixed ? "回到题下" : "固定对照"}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-0"
          aria-label="AI 设置"
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          onClick={() => setSettingsOpen((previous) => !previous)}
        >
          <Settings2 aria-hidden className="size-4" />
        </Button>
        {onDockClose && (
          <Button
            ref={dockCloseRef}
            type="button"
            variant="ghost"
            className="size-11 shrink-0 p-0"
            aria-label={closeLabel}
            onClick={onDockClose}
          >
            <X aria-hidden className="size-4" />
          </Button>
        )}
      </div>
      {!settingsOpen && !settingsAttention && compactStatus}
      {settingsOpen && (
        <div
          id={settingsId}
          className="shrink-0 border-b border-border bg-muted/30 px-3 py-2"
        >
          <section aria-label="通道与模式" className="flex flex-col gap-1">
            {status ?? <AiCompanionChannelStatus settingsHref={settingsHref} />}
          </section>
        </div>
      )}
      <section
        ref={replyOverscroll.ref}
        aria-label="本题对话记录"
        data-slot="ai-reply-workspace"
        className={
          flow
            ? "min-w-0 px-3 py-3 sm:px-5"
            : `min-h-0 flex-1 overflow-y-auto ${replyOverscroll.overscrollClass} bg-muted/20 px-3 py-3`
        }
      >
        {conversation ?? (
          <p className="text-sm text-muted-foreground">
            还没有对话记录。发送一次求助后，回复会显示在这里。
          </p>
        )}
      </section>
      {quickButtons !== null && (
        <nav
          aria-label="快捷按钮"
          className="shrink-0 border-t border-border px-3 py-2"
        >
          {quickButtons ?? (
            <p className="text-xs text-muted-foreground">快捷按钮功能建设中</p>
          )}
        </nav>
      )}
      {composer !== undefined && (
        <section
          aria-label="发送输入"
          className="shrink-0 border-t border-border px-3 py-2"
        >
          {composer}
        </section>
      )}
    </div>
  );
}

export function AiCompanionRail({
  containerRef,
  controller,
  triggerRef,
  questionLabel,
  settingsHref,
  status,
  settingsAttention,
  quickButtons,
  composer,
  conversation,
  children,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  controller: AiCompanionLayoutController;
  /** dock 模式 Esc/关闭后焦点返回的触发按钮 */
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  questionLabel: string | null;
  /** 连接设置入口（含 ?from= 回跳原题路径） */
  settingsHref: string;
  /** 会话状态区（SAI-20 真实注入；未注入时保留合成的诚实回退） */
  status?: ReactNode;
  /** 未连接/状态读取失败时自动展开设置抽屉 */
  settingsAttention?: boolean | undefined;
  quickButtons?: ReactNode;
  /** 发送输入区（SAI-20 真实注入；未注入时不渲染该分区） */
  composer?: ReactNode;
  conversation?: ReactNode;
  children: ReactNode;
}) {
  const dockActive = controller.open && controller.mode === "dock";
  const panelActive = controller.open && controller.mode === "panel";
  return (
    <div
      ref={containerRef}
      data-slot="ai-companion-rail"
      data-ai-state={controller.open ? controller.mode : "closed"}
      className={
        dockActive
          ? "flex w-full min-w-0 items-start gap-4 flex-row"
          : controller.open
            ? "flex w-full min-w-0 flex-col gap-4"
            : "block w-full min-w-0"
      }
    >
      {controller.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive bg-card px-3 py-2 text-sm text-destructive"
        >
          {controller.error}
        </p>
      )}
      <section
        aria-label="作答区"
        className={dockActive ? "min-w-0 flex-1" : "w-full"}
      >
        {children}
      </section>
      {dockActive && (
        <DockPanel
          controller={controller}
          triggerRef={triggerRef}
          questionLabel={questionLabel}
          settingsHref={settingsHref}
          status={status}
          settingsAttention={settingsAttention}
          quickButtons={quickButtons}
          composer={composer}
          conversation={conversation}
        />
      )}
      {/*
        Sheet 常驻挂载、open 受控：关闭须经 Radix 退出路径（Esc/遮罩/
        onCloseAutoFocus 焦点返回），不能因卸载组件绕过焦点管理。
        */}
      <Sheet
        open={panelActive}
        onOpenChange={(next) => {
          if (!next) {
            controller.closePanel();
            // 焦点返回触发按钮（§7.3）：微任务延后到 Radix 卸载清理之后，
            // 避免 FocusScope 卸载把焦点重置回 body。
            queueMicrotask(() => {
              triggerRef?.current?.focus({ preventScroll: true });
            });
          }
        }}
      >
        <SheetContent
          forceMount
          id={controller.panelId}
          closeLabel="关闭 AI 助教"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[min(100vw,26rem)]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef?.current?.focus({ preventScroll: true });
          }}
        >
          {/* 可见标题由面板头承担；这里只保留 Radix 需要的无障碍标题 */}
          <SheetTitle className="sr-only">AI 助教</SheetTitle>
          <SheetDescription className="sr-only">
            {questionLabel ?? "未绑定题目"}的 AI 伴学栏
          </SheetDescription>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AiCompanionPanelBody
              questionLabel={questionLabel}
              settingsHref={settingsHref}
              status={status}
              settingsAttention={settingsAttention}
              quickButtons={quickButtons}
              composer={composer}
              conversation={conversation}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DockPanel({
  controller,
  triggerRef,
  questionLabel,
  settingsHref,
  status,
  settingsAttention,
  quickButtons,
  composer,
  conversation,
}: {
  controller: AiCompanionLayoutController;
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  questionLabel: string | null;
  settingsHref: string;
  status?: ReactNode;
  settingsAttention?: boolean | undefined;
  quickButtons?: ReactNode;
  composer?: ReactNode;
  conversation?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // 打开后焦点进入面板（关闭按钮）；不做动画等待
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      id={controller.panelId}
      aria-label="AI 助教"
      data-slot="ai-companion-panel"
      className="sticky top-[calc(var(--attempt-header-height,64px)+16px)] h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] flex w-[22rem] shrink-0 flex-col self-start overflow-hidden rounded-lg border bg-card"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        )
          return;
        event.preventDefault();
        controller.closePanel();
        triggerRef?.current?.focus({ preventScroll: true });
      }}
    >
      <AiCompanionPanelBody
        questionLabel={questionLabel}
        settingsHref={settingsHref}
        dockCloseRef={closeRef}
        onDockClose={() => {
          controller.closePanel();
          triggerRef?.current?.focus({ preventScroll: true });
        }}
        status={status}
        settingsAttention={settingsAttention}
        quickButtons={quickButtons}
        composer={composer}
        conversation={conversation}
      />
    </aside>
  );
}
