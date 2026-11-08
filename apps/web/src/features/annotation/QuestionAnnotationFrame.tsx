import type {
  AnnotationSurfaceLayout,
  AttemptQuestionPublic,
} from "@tutor/contract";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { QuestionRenderContext } from "@/features/answering/question-render-context";
import { StableQuestionPixelGridContext } from "@/features/attempt/QuestionSurfaceFrame";
import {
  awaitQuestionSurfaceReady,
  publicContentSignatureOf,
  questionSurfaceMatchesLayout,
  resolveLegacyQuestionProfile,
} from "./question-base-image";

export type QuestionFrameGeometry = {
  status: "none" | "checking" | "ready" | "blocked";
  identity: string;
  reason: string | null;
  preserveInk?: boolean;
};
export interface QuestionAnnotationFrameHandle {
  verify(
    layout: AnnotationSurfaceLayout,
    signal?: AbortSignal,
  ): Promise<boolean>;
  getSurface(): HTMLElement | null;
}
export function questionFrameIdentity(
  question: AttemptQuestionPublic,
  layout: AnnotationSurfaceLayout | null,
  scopeKey: string,
): string {
  return JSON.stringify([
    scopeKey,
    question.questionRevisionId,
    publicContentSignatureOf(question),
    JSON.stringify(layout),
  ]);
}
export const QuestionAnnotationFrame = forwardRef<
  QuestionAnnotationFrameHandle,
  {
    question: AttemptQuestionPublic;
    layout: AnnotationSurfaceLayout | null;
    scopeKey: string;
    children: ReactNode;
    inkLayer?: ReactNode;
    active?: boolean;
    onBeforeResize?: () => void;
    onGeometryChange?: (geometry: QuestionFrameGeometry) => void;
  }
>(
  (
    {
      question,
      layout,
      scopeKey,
      children,
      inkLayer,
      active = false,
      onBeforeResize,
      onGeometryChange,
    },
    ref,
  ) => {
    const root = useRef<HTMLDivElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const [fitScale, setFitScale] = useState(1);
    const [expanded, setExpanded] = useState(false);
    const [legacyProfile, setLegacyProfile] = useState<{
      identity: string;
      direction: "horizontal" | "vertical";
    } | null>(null);
    const legacyResolution = useRef<{
      identity: string;
      promise: Promise<"horizontal" | "vertical" | null>;
    } | null>(null);
    // 不含正文版本或云端绑定回执；相同逻辑基准在每笔保存后仍是同一工作区。
    const identity = questionFrameIdentity(question, layout, scopeKey);
    const scopeIdentity = questionFrameIdentity(question, null, scopeKey);
    const facts = useRef({
      question,
      layout,
      identity,
      scopeIdentity,
      onBeforeResize,
      onGeometryChange,
    });
    facts.current = {
      question,
      layout,
      identity,
      scopeIdentity,
      onBeforeResize,
      onGeometryChange,
    };
    const getSurface = useCallback(
      () =>
        root.current?.querySelector<HTMLElement>(
          '[data-slot="question-surface"]',
        ) ?? null,
      [],
    );
    const verify = useCallback(
      async (candidate: AnnotationSurfaceLayout, signal?: AbortSignal) => {
        const expectedScope = facts.current.scopeIdentity;
        // 首次本机落盘会发布布局；等 React 提交固定逻辑框再测量同一 children。
        const deadline = performance.now() + 15_000;
        while (
          JSON.stringify(facts.current.layout) !== JSON.stringify(candidate)
        ) {
          if (signal?.aborted || facts.current.scopeIdentity !== expectedScope)
            throw new DOMException("题面核验已取消", "AbortError");
          if (performance.now() > deadline)
            throw new Error("题面布局尚未就绪，原稿已保留，请重试");
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
        const expected = facts.current.identity;
        const surface = getSurface();
        if (!surface) throw new Error("题面尚未就绪，请重试");
        const check = () => {
          if (signal?.aborted || expected !== facts.current.identity)
            throw new DOMException("题面核验已取消", "AbortError");
        };
        if (
          candidate.renderVersion !== 4 &&
          (facts.current.question.type === "matching" ||
            facts.current.question.type === "ordering")
        ) {
          await Promise.resolve();
          check();
          if (legacyResolution.current?.identity !== expected) {
            const promise = resolveLegacyQuestionProfile(
              facts.current.question,
              surface,
              candidate,
              signal,
            );
            legacyResolution.current = { identity: expected, promise };
            promise.catch(() => {
              if (legacyResolution.current?.promise === promise)
                legacyResolution.current = null;
            });
          }
          const direction = await legacyResolution.current.promise;
          check();
          if (!direction) {
            legacyResolution.current = null;
            return false;
          }
          flushSync(() => setLegacyProfile({ identity: expected, direction }));
          check();
        }
        facts.current.onBeforeResize?.();
        await awaitQuestionSurfaceReady(surface, check, signal);
        check();
        const matches = await questionSurfaceMatchesLayout(
          facts.current.question,
          surface,
          candidate,
        );
        check();
        return matches;
      },
      [getSurface],
    );
    useImperativeHandle(ref, () => ({ verify, getSurface }), [
      verify,
      getSurface,
    ]);
    useEffect(() => {
      const controller = new AbortController();
      const current = facts.current;
      let verified = false;
      let verifying = false;
      let scheduled = false;
      const publish = (
        status: QuestionFrameGeometry["status"],
        reason: string | null = null,
      ) => {
        if (!controller.signal.aborted && facts.current.identity === identity)
          current.onGeometryChange?.({
            status,
            identity,
            reason,
            preserveInk: verified,
          });
      };
      const savedLayout = current.layout;
      if (!savedLayout) {
        publish("none");
        return;
      }
      const validate = async () => {
        if (verifying) {
          scheduled = true;
          return;
        }
        verifying = true;
        publish("checking");
        try {
          const matches = await verify(savedLayout, controller.signal);
          if (matches) verified = true;
          publish(
            matches ? "ready" : "blocked",
            matches
              ? null
              : savedLayout.compatibility
                ? "题面与保存基准偏差超过 10px 或区域不符，原稿已保留，请恢复原排版后重试"
                : "旧稿缺少位置证据且原签名未匹配，无法核验对齐，原稿已保留，请在原设备继续或导出原稿",
          );
        } catch (cause) {
          publish(
            "blocked",
            cause instanceof Error ? cause.message : "题面核验失败，原稿已保留",
          );
        } finally {
          verifying = false;
          if (scheduled && !controller.signal.aborted) {
            scheduled = false;
            void validate();
          }
        }
      };
      void validate();
      const surface = getSurface();
      let size = surface?.getBoundingClientRect();
      const observer = new ResizeObserver(() => {
        const next = surface?.getBoundingClientRect();
        if (
          !next ||
          (next.width === size?.width && next.height === size?.height)
        )
          return;
        size = next;
        current.onBeforeResize?.();
        void validate();
      });
      if (surface) observer.observe(surface);
      return () => {
        controller.abort();
        observer.disconnect();
      };
    }, [identity, verify, getSurface]);
    const cssWidth = layout?.cssWidth;
    const cssHeight = layout?.cssHeight;
    const renderVersion = layout?.renderVersion ?? 4;
    const legacyDirection =
      legacyProfile?.identity === identity
        ? legacyProfile.direction
        : undefined;
    // 墨层和缩放可以独立更新。题面只在渲染参数变化时接收新配置。
    const renderProfile = useMemo(
      () => ({
        renderVersion,
        ...(cssWidth ? { logicalWidth: cssWidth } : {}),
        ...(legacyDirection ? { legacyDirection } : {}),
      }),
      [renderVersion, cssWidth, legacyDirection],
    );
    const scale = expanded ? 1 : fitScale;
    useLayoutEffect(() => {
      const element = viewport.current;
      if (!element || !cssWidth) return;
      let previousWidth = 0;
      const resize = () => {
        const width = element.getBoundingClientRect().width;
        if (width <= 0 || width === previousWidth) return;
        facts.current.onBeforeResize?.();
        if (previousWidth > 0) setExpanded(false);
        previousWidth = width;
        setFitScale(Math.min(1, width / cssWidth));
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      return () => observer.disconnect();
    }, [cssWidth]);
    return (
      <div ref={root} className="w-full min-w-0">
        <div
          ref={viewport}
          data-slot="annotation-viewport"
          className={`relative mx-auto w-full min-w-0 overflow-x-auto ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`}
          style={cssWidth ? { maxWidth: cssWidth } : undefined}
        >
          <div
            className="relative"
            style={
              cssWidth && cssHeight
                ? { width: cssWidth * scale, height: cssHeight * scale }
                : undefined
            }
          >
            <div
              data-slot="annotation-logical-frame"
              data-annotation-scale={cssWidth ? scale : 1}
              style={
                cssWidth && cssHeight
                  ? {
                      width: cssWidth,
                      height: cssHeight,
                      transform: `scale(${scale})`,
                      transformOrigin: "top left",
                    }
                  : undefined
              }
            >
              <QuestionRenderContext value={renderProfile}>
                <StableQuestionPixelGridContext value>
                  {children}
                </StableQuestionPixelGridContext>
              </QuestionRenderContext>
            </div>
            {cssWidth && cssHeight && (
              <div
                className="pointer-events-none absolute left-0 top-0 z-10"
                style={{ width: cssWidth * scale, height: cssHeight * scale }}
              >
                {inkLayer}
              </div>
            )}
          </div>
        </div>
        {fitScale < 1 && (
          <Button
            variant="ghost"
            className="mt-2 h-11"
            aria-pressed={expanded}
            onClick={() => {
              facts.current.onBeforeResize?.();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? "适应宽度" : "放大题面"}
          </Button>
        )}
      </div>
    );
  },
);
