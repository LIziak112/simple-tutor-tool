import { useMutation, useQuery } from "@tanstack/react-query";
import type { LectureDetail } from "@tutor/contract";
import {
  fetchLectureDetail,
  previewLearningPackApi,
} from "@/lib/api";
import { extractOutline, type OutlineItem } from "@/features/markdown/outline";

/**
 * 学情数据包导出向导的查询封装（T4.4，纯消费 T4.3 接口）：
 * - preview 用 mutation（POST 请求体大、随勾选实时变化，不缓存；进入第⑤步
 *   或回退改动后再进时重新发起，重试由用户点击「重新预览」触发）；
 * - 讲义大纲按需加载：仅在向导②展开某篇讲义时取详情，用与导入/导出同一
 *   口径的 extractOutline（H2/H3，跳过代码围栏）得到目录，headingIndex 即
 *   数组下标——与契约 sectionIndexes、服务端 export-service 的切片序号一致
 *   （越界索引由服务端忽略，讲义被编辑时优雅降级）。
 */

/** 学情数据包预览（向导第⑤步数据源；overLimit 由页面分支提示精简） */
export function useLearningPackPreview() {
  return useMutation({
    mutationFn: previewLearningPackApi,
  });
}

/** 讲义详情 → H2/H3 目录（headingIndex = 数组下标）；id 为空不查 */
export function useLectureOutline(lectureId: string | null) {
  return useQuery<LectureDetail, Error, OutlineItem[]>({
    queryKey: ["teacher", "lecture", "detail", lectureId ?? "pending"],
    queryFn: () => fetchLectureDetail(lectureId ?? ""),
    enabled: lectureId !== null,
    // 大纲随讲义编辑可能变化，但向导会话内取一次即可（勾选是快照语义）
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    select: (detail) => extractOutline(detail.markdown),
  });
}
