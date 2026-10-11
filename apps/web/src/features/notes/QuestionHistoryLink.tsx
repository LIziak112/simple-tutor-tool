import { History } from "lucide-react";
import { Link, useLocation } from "react-router";

/** 来源保存在地址中，刷新历史页后仍能回到原结果及当前题目。 */
export function QuestionHistoryLink({
  questionId,
  ariaPrefix = "本题",
}: {
  questionId: string;
  ariaPrefix?: string;
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("reviewQuestion", questionId);
  const returnTo = `${location.pathname}?${params.toString()}${location.hash}`;
  const query = new URLSearchParams({ returnTo });
  return (
    <Link
      to={`/s/notebook/${encodeURIComponent(questionId)}?${query}`}
      aria-label={`${ariaPrefix}本题历史`}
      className="flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-border px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <History aria-hidden className="size-4" />
      本题历史
    </Link>
  );
}
