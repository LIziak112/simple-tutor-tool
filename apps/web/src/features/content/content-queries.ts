import { useQuery } from "@tanstack/react-query";
import { fetchContentTree } from "@/lib/api";

/**
 * 内容树查询（T1.11 教师端内容页）：
 * 导入成功跳转回来后由调用方 invalidate 刷新（ImportPage 提交成功时统一处理）。
 */
export const contentTreeKey = ["teacher", "content-tree"] as const;

/** 课程 → 讲义/单元 → 题目摘要树（三态齐全由页面接 isPending/isError） */
export function useContentTree() {
  return useQuery({
    queryKey: contentTreeKey,
    queryFn: fetchContentTree,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
