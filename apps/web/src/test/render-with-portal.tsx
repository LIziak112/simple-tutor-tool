import {
  render as baseRender,
  renderHook as baseRenderHook,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { PortalRuntimeProvider } from "@/features/runtime/portal-runtime";
import { createTestRuntime } from "./portal-fixture";

export * from "@testing-library/react";

function scopedRender(ui: ReactNode, options?: RenderOptions) {
  const runtime = createTestRuntime();
  const result = baseRender(
    <PortalRuntimeProvider runtime={runtime}>{ui}</PortalRuntimeProvider>,
    options,
  );
  return {
    ...result,
    rerender: (next: ReactNode) =>
      result.rerender(
        <PortalRuntimeProvider runtime={runtime}>{next}</PortalRuntimeProvider>,
      ),
  };
}
// 透明转发自定义queries/container的原有重载，新增的只有统一测试宿主。
export const render = scopedRender as typeof baseRender;
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options?: RenderHookOptions<Props>,
) {
  const runtime = createTestRuntime();
  const Wrapper = options?.wrapper;
  return baseRenderHook(callback, {
    ...options,
    wrapper: ({ children }) => (
      <PortalRuntimeProvider runtime={runtime}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </PortalRuntimeProvider>
    ),
  });
}
