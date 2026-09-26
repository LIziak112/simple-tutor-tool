import { useQuery } from "@tanstack/react-query";
import { fetchSpecFile } from "@/lib/api";

/**
 * DSL 规范文档查询（T1.13"AI 出题助手"）：
 * 三份文档（规范/完整样例/提示词模板）经公开接口 /api/public/spec 拉取，
 * 由 TanStack Query 缓存——规范只在发版后变化，staleTime 放宽到 10 分钟。
 */

/** 三份文档一次性拉齐的结果（拼装见 ai-prompt.ts） */
export interface SpecDocs {
  rules: string;
  example: string;
  prompt: string;
}

export const specDocsKey = ["public", "spec-docs"] as const;

async function fetchSpecDocs(): Promise<SpecDocs> {
  const [rules, example, prompt] = await Promise.all([
    fetchSpecFile("rules.md"),
    fetchSpecFile("example.md"),
    fetchSpecFile("prompt.md"),
  ]);
  return { rules, example, prompt };
}

/**
 * 三份规范文档查询。enabled 由面板展开态控制（收起时不发请求，按需加载）；
 * 三态齐全由面板接 isPending/isError 展示。
 */
export function useSpecDocs(enabled: boolean) {
  return useQuery({
    queryKey: specDocsKey,
    queryFn: fetchSpecDocs,
    enabled,
    staleTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
