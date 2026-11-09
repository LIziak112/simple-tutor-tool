import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type QuestionNavigationItem,
  QuestionNavigationTile,
} from "./QuestionNavigator";

/**
 * 左栏题号导航（阶段 B 做题工作区改版，2026-11）：三栏布局的左列——作答状态
 * 点阵常驻可见，点击即跳题；窄屏（< lg）整列不渲染，题号导航改走底部上滑
 * 面板（AttemptNavigatorSheet）。
 * - 折叠态只剩一个 44px 竖条（展开按钮 + 当前题号）：AI 助教固定在右栏而
 *   宽度不足时由布局控制器代为折叠（ai-companion-layout 的 navigatorCollapsed），
 *   学生也可手动折叠/展开；
 * - 点阵复用 QuestionNavigationTile（与底部面板同一格样式与可达名），完成度
 *   只看答案与正式笔迹（不订阅草稿纸逐笔更新——常驻栏不能为「部分作答」
 *   判定付出每笔重渲染，底部面板打开时仍按原口径细分）；
 * - 高度随视口，长卷点阵内部滚动；吸顶跟随顶栏/底栏实测高度变量。
 */
export function AttemptQuestionRail({
  items,
  currentId,
  answered,
  total,
  submittedCount,
  collapsed,
  onToggleCollapsed,
  onJump,
  locked = false,
}: {
  items: readonly QuestionNavigationItem[];
  currentId: string | null;
  answered: number;
  total: number;
  /** v1 卷逐题提交数；legacy 卷 undefined 不显示 */
  submittedCount?: number | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onJump: (id: string) => void;
  /** 提交在途禁跳题（单题模式） */
  locked?: boolean;
}) {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  const stickyClass =
    "sticky top-[calc(var(--attempt-header-height,64px)+16px)] max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)]";
  if (collapsed) {
    return (
      <nav
        aria-label="题号导航"
        data-slot="attempt-question-rail"
        data-collapsed="true"
        className={`hidden w-11 shrink-0 flex-col items-center gap-2 lg:flex ${stickyClass}`}
      >
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-0"
          aria-label="展开题号导航"
          aria-expanded={false}
          title="展开题号导航"
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpen aria-hidden className="size-5" />
        </Button>
        <p
          role="status"
          className="text-xs tabular-nums text-muted-foreground [writing-mode:vertical-rl]"
          aria-label={`当前第 ${currentIndex + 1} 题，共 ${total} 题`}
        >
          {currentIndex >= 0 ? `${currentIndex + 1} / ${total}` : `${total} 题`}
        </p>
      </nav>
    );
  }
  return (
    <nav
      aria-label="题号导航"
      data-slot="attempt-question-rail"
      data-collapsed="false"
      className={`hidden w-[216px] shrink-0 flex-col gap-2 rounded-xl border border-border bg-card p-2 lg:flex ${stickyClass}`}
    >
      <div className="flex shrink-0 items-center justify-between gap-1 ps-1">
        <p className="min-w-0 text-sm font-semibold">答题卡</p>
        <Button
          type="button"
          variant="ghost"
          className="size-11 shrink-0 p-0"
          aria-label="收起题号导航"
          aria-expanded
          title="收起题号导航"
          onClick={onToggleCollapsed}
        >
          <PanelLeftClose aria-hidden className="size-5" />
        </Button>
      </div>
      <p
        role="status"
        className="shrink-0 ps-1 text-xs tabular-nums text-muted-foreground"
      >
        已填写 {answered}/{total}
        {total - answered > 0 ? ` · 未答 ${total - answered}` : " · 全部已填写"}
        {submittedCount !== undefined && ` · 已提交 ${submittedCount}/${total}`}
      </p>
      <ol className="grid min-h-0 flex-1 grid-cols-4 content-start gap-2 overflow-y-auto overscroll-contain p-1">
        {items.map((item) => (
          <li key={item.id}>
            <QuestionNavigationTile
              item={item}
              current={item.id === currentId}
              locked={locked}
              onJump={onJump}
            />
          </li>
        ))}
      </ol>
    </nav>
  );
}
