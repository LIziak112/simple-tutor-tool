import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AiQueueSummaryData } from "@tutor/contract";
import {
  fetchStudentAiQueueSummaryApi,
  listStudentAiQueueApi,
  studentAiTaskActionApi,
} from "@/lib/api";

/**
 * SAI-23 全局队列查询封装（B12）。查询键全部挂在 ["student", …] 下：学生
 * 登出 removeQueries(["student"])（student-auth）时换账号缓存立即隔离——
 * 旧账号队列列表/角标不会短暂显示在新账号页面上。
 *
 * 双计数语义（需求 §7.1「助教队列·待处理N·新回复M」）：待处理与新回复是
 * 两个含义不同的角标，不得合并成一个数字双语义；派生规则单源于
 * aiQueueBadgeOf（待处理 = 待领取 + 处理中，新回复 = 已回信未读）。
 *
 * 新任务/回信到达只更新本队列与摘要（infinite query 失效重取），不触发
 * 自动切题/自动展开——切题是显式动作（SAI-20 打开绑定语义不变）。
 */

/** 队列摘要键（顶栏双角标数据源；所有队列写动作成功后失效重取） */
export const studentAiQueueSummaryKey = [
  "student",
  "ai-queue-summary",
] as const;

/** 队列列表键前缀（archived 三态 + 游标分页的 infinite query 全挂本前缀下） */
export const studentAiQueueKey = ["student", "ai-queue"] as const;

/** 队列动作四件套（按钮呈现与服务端 allowedActions 对齐） */
export type AiQueueAction = "cancel" | "resume" | "retry" | "archive";

/**
 * 角标派生规则（单源）：待处理 = pendingCount + processingCount（所有未终态
 * 队列项），新回复 = unreadReplyCount（replied 且未打开——归档不减、取消不增：
 * 归档≠已读、取消≠已读，两者都不进这两个角标）。
 */
export function aiQueueBadgeOf(summary: AiQueueSummaryData): {
  pendingCount: number;
  unreadReplyCount: number;
} {
  return {
    pendingCount: summary.pendingCount + summary.processingCount,
    unreadReplyCount: summary.unreadReplyCount,
  };
}

/** 队列摘要（顶栏角标）。窗口聚焦不自动重取——队列更新由动作/轮询驱动 */
export function useStudentAiQueueSummary() {
  return useQuery({
    queryKey: studentAiQueueSummaryKey,
    queryFn: fetchStudentAiQueueSummaryApi,
    refetchOnWindowFocus: false,
  });
}

/**
 * 队列列表（游标分页「加载更多」；exclude = 默认队列视图，only = 已归档
 * 分组）。列表载荷只含展示与导航定位字段；对话正文在授权详情接口读取。
 */
export function useStudentAiQueue(archived: "exclude" | "only") {
  return useInfiniteQuery({
    queryKey: [...studentAiQueueKey, archived],
    queryFn: ({ pageParam }) =>
      listStudentAiQueueApi({
        archived,
        limit: 20,
        ...(pageParam !== null ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * 队列动作（取消/明确重试/继续暂停/归档）。成功后失效队列摘要 + 队列列表
 * + 本题任务历史 + 单题状态（服务端为权威——动作可能改状态机与已读/配额
 * 派生），失败不清缓存（错误就地展示，列表保持原状可重试）。
 */
export function useStudentAiQueueAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { taskId: string; action: AiQueueAction }) =>
      studentAiTaskActionApi(input.taskId, input.action),
    onSuccess: () => {
      for (const queryKey of [
        studentAiQueueSummaryKey,
        studentAiQueueKey,
        ["student", "ai-tasks"],
        ["student", "ai-status"],
      ] as const) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
