import {
  Component,
  type ComponentProps,
  lazy,
  type ReactNode,
  Suspense,
} from "react";
import { Button } from "@/components/ui/button";

const Result = lazy(() => import("./AttemptResultWithDraftCleanup"));

/** 结果模块失败保留明确入口，重新加载沿用已保存的作答与材料。 */
export class AttemptResultLoadBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <div role="alert" className="space-y-3 p-6">
        <p>结果页面加载失败，请重新加载。</p>
        <Button onClick={this.props.onRetry}>重新加载</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function AttemptResultLoader(
  props: ComponentProps<
    typeof import("./AttemptResultWithDraftCleanup").default
  >,
) {
  return (
    <AttemptResultLoadBoundary
      key={props.data.attempt.id}
      onRetry={() => window.location.reload()}
    >
      <Suspense
        fallback={
          <p role="status" className="p-6 text-muted-foreground">
            正在加载结果…
          </p>
        }
      >
        <Result {...props} />
      </Suspense>
    </AttemptResultLoadBoundary>
  );
}
