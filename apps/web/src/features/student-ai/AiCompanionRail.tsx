import { Sparkles, X } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
    label?: string;
  }
>(function AiCompanionTrigger({ controller, label = "AI 助教" }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      className="size-11 shrink-0 p-0"
      aria-label={label}
      title={label}
      aria-expanded={controller.open}
      aria-controls={controller.panelId}
      onClick={() => {
        if (controller.open) controller.closePanel();
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
  questionLabel: string | null;
  settingsHref: string;
  /** dock 模式的关闭按钮（panel 模式由 Sheet 内建关闭提供） */
  dockCloseRef?: RefObject<HTMLButtonElement | null>;
  onDockClose?: () => void;
  /** 会话状态区（SAI-20 真实注入；未注入时保留合成的诚实回退） */
  status?: ReactNode;
  /** 合成子内容（空间测试注入；生产留空显示占位） */
  quickButtons?: ReactNode;
  /** 发送输入区（SAI-20 真实注入；未注入时不渲染该分区） */
  composer?: ReactNode;
  materials?: ReactNode;
  conversation?: ReactNode;
}

function AiCompanionPanelBody({
  questionLabel,
  settingsHref,
  dockCloseRef,
  onDockClose,
  status,
  quickButtons,
  composer,
  materials,
  conversation,
}: PanelBodyProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">AI 助教</h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {questionLabel ?? "未绑定题目"}
        </span>
        {onDockClose && (
          <Button
            ref={dockCloseRef}
            type="button"
            variant="ghost"
            className="size-8 shrink-0 p-0"
            aria-label="关闭 AI 助教"
            onClick={onDockClose}
          >
            <X aria-hidden className="size-4" />
          </Button>
        )}
      </div>
      <section
        aria-label="通道与模式"
        className="border-b border-border px-3 py-2"
      >
        {status ?? <AiCompanionChannelStatus settingsHref={settingsHref} />}
      </section>
      <nav aria-label="快捷按钮" className="border-b border-border px-3 py-2">
        {quickButtons ?? (
          <p className="text-xs text-muted-foreground">快捷按钮功能建设中</p>
        )}
      </nav>
      {composer !== undefined && (
        <section
          aria-label="发送输入"
          className="border-b border-border px-3 py-2"
        >
          {composer}
        </section>
      )}
      <section
        aria-label="当前材料"
        className="border-b border-border px-3 py-2"
      >
        {materials ?? (
          <p className="text-xs text-muted-foreground">材料汇总功能建设中</p>
        )}
      </section>
      <section
        aria-label="本题对话记录"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
      >
        {conversation ?? (
          <p className="text-xs text-muted-foreground">暂无对话记录</p>
        )}
      </section>
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
  quickButtons,
  composer,
  materials,
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
  quickButtons?: ReactNode;
  /** 发送输入区（SAI-20 真实注入；未注入时不渲染该分区） */
  composer?: ReactNode;
  materials?: ReactNode;
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
      className={`flex min-w-0 gap-4 ${dockActive ? "flex-row" : "flex-col"}`}
    >
      {controller.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive bg-card px-3 py-2 text-sm text-destructive"
        >
          {controller.error}
        </p>
      )}
      <section aria-label="作答区" className="min-w-0 flex-1">
        {children}
      </section>
      {dockActive && (
        <DockPanel
          controller={controller}
          triggerRef={triggerRef}
          questionLabel={questionLabel}
          settingsHref={settingsHref}
          status={status}
          quickButtons={quickButtons}
          composer={composer}
          materials={materials}
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
          id={controller.panelId}
          closeLabel="关闭 AI 助教"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[min(100vw,24rem)]"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef?.current?.focus();
          }}
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle>AI 助教</SheetTitle>
            <SheetDescription>
              {questionLabel ?? "未绑定题目"}的 AI 伴学栏
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <AiCompanionPanelBody
              questionLabel={questionLabel}
              settingsHref={settingsHref}
              status={status}
              quickButtons={quickButtons}
              composer={composer}
              materials={materials}
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
  quickButtons,
  composer,
  materials,
  conversation,
}: {
  controller: AiCompanionLayoutController;
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  questionLabel: string | null;
  settingsHref: string;
  status?: ReactNode;
  quickButtons?: ReactNode;
  composer?: ReactNode;
  materials?: ReactNode;
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
      className="sticky top-[calc(var(--attempt-header-height,64px)+16px)] max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] flex w-80 shrink-0 flex-col self-start overflow-hidden rounded-lg border bg-card"
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
        triggerRef?.current?.focus();
      }}
    >
      <AiCompanionPanelBody
        questionLabel={questionLabel}
        settingsHref={settingsHref}
        dockCloseRef={closeRef}
        onDockClose={() => {
          controller.closePanel();
          triggerRef?.current?.focus();
        }}
        status={status}
        quickButtons={quickButtons}
        composer={composer}
        materials={materials}
        conversation={conversation}
      />
    </aside>
  );
}
