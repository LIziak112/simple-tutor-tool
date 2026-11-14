import { useInfiniteQuery } from "@tanstack/react-query";
import { MEMO_KIND_LABEL } from "@tutor/contract";
import { Button } from "@/components/ui/button";
import { listMemosApi } from "@/lib/memo-api";
/** 单独读取本人随笔，不重新读取题面；不提供修改原始随笔的入口。 */
export function ReviewMemoExcerpt({
  attemptId,
  active,
}: {
  attemptId: string;
  active: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey: ["student", "memos", "review", attemptId],
    enabled: active,
    staleTime: 60_000,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listMemosApi({
        attemptId,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor,
  });
  if (query.isPending) return <p role="status">正在加载本卷随笔…</p>;
  if (query.isError)
    return (
      <div role="alert">
        随笔加载失败。
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => void query.refetch()}
        >
          重试
        </Button>
      </div>
    );
  const memos = query.data.pages.flatMap((p) => p.memos);
  return (
    <section aria-label="随笔摘录">
      <h2 className="font-semibold">随笔摘录</h2>
      {memos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          本卷还没有随笔，可从题卡记下想法后再来回看。
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {memos.map((m) => (
            <li key={m.id} className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {m.seq === null ? "尚无序号" : `#${m.seq}`} ·{" "}
                {MEMO_KIND_LABEL[m.kind]}
              </p>
              <p className="whitespace-pre-wrap">
                {m.text ?? "媒体随笔，可到随笔列表查看原件。"}
              </p>
            </li>
          ))}
        </ol>
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          className="min-h-11"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          继续加载随笔
        </Button>
      )}
    </section>
  );
}
