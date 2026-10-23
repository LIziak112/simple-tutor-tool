import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AttemptAnswerSaveData,
  AttemptSubmitRevision,
  PracticeWorkflowStartOptions,
  PracticeWorkflowUpdateRequest,
  StudentAnswer,
  SubmitEvidenceDeclaration,
} from "@tutor/contract";
import { attemptAnswerConflictCurrentSchema } from "@tutor/contract";
import { useState } from "react";
import {
  studentAssignmentsKey,
  studentCoursesKey,
} from "@/features/student/student-queries";
import {
  ApiError,
  fetchAttemptApi,
  fetchStudentUnitLandingApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  startCourseAttemptApi,
  submitAttemptApi,
  updateAttemptWorkflowApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { draftStore, getDraftSessionEpoch } from "./draft-store";
import { getPracticePreference } from "./practice-preference-store";

/**
 * 学生端作答数据层（T2.6；T2A.6 扩展课程练习）：attempt 创建（作业/课程两种
 * 来源入口）、单元落地查询、详情查询（草稿/结果二态视图）、草稿保存与交卷
 * mutation。两种来源共用 /attempts/:id/* 接口与答题页（D9）。
 */

/** 单个 attempt 详情 key */
export const studentAttemptKey = (attemptId: string) =>
  ["student", "attempt", attemptId] as const;

/** 课程单元落地页 key（题数/历次作答/汇总） */
export const studentUnitLandingKey = (courseId: string, unitId: string) =>
  ["student", "course", courseId, "unit", unitId] as const;

/**
 * 详情轮询暂停集（M3-D2）：新协议卷最后一题提交触发服务端自动收尾后，客户端
 * 数据仍是 draft——不暂停的话 10s 轮询会重发详情查询并把刚显示的题级反馈视图
 * 翻成整卷结果（§10.3 学生显式点「查看本次结果」才收敛）。按 attemptId 记录，
 * 只影响新协议收尾后的那一段窗口；点查看/离开页面后停留无副作用（非 draft
 * 恒不轮询）。
 */
const detailPollingPaused = new Set<string>();

/** 最后一题自动收尾后调用：停掉该卷的 draft 轮询，等学生显式查看结果 */
export function pauseAttemptDetailPolling(attemptId: string): void {
  detailPollingPaused.add(attemptId);
}

/** 学生显式查看结果（或重新进入作答）时解除暂停 */
export function resumeAttemptDetailPolling(attemptId: string): void {
  detailPollingPaused.delete(attemptId);
}

/** attempt 详情（draft→草稿视图、submitted/graded→结果视图；按 attempt.status 分支） */
export function useAttemptDetail(attemptId: string | undefined) {
  return useQuery({
    queryKey: studentAttemptKey(attemptId ?? "pending"),
    queryFn: () => fetchAttemptApi(attemptId ?? ""),
    enabled: attemptId !== undefined,
    staleTime: 0,
    refetchOnMount: "always",
    // 窗口焦点重取同样尊重收尾暂停（闸门修复）：否则最后一题自动收尾后
    // 切窗再切回会绕过暂停把反馈视图翻成整卷结果，违背「显式查看才收敛」
    refetchOnWindowFocus: () =>
      attemptId === undefined || !detailPollingPaused.has(attemptId),
    refetchInterval: (query) =>
      query.state.data?.attempt.status === "draft" &&
      (attemptId === undefined || !detailPollingPaused.has(attemptId))
        ? 10_000
        : false,
  });
}

/** 单元落地信息（开始练习/继续作答/再做一次与历次记录列表的数据源） */
export function useStudentUnitLanding(courseId: string, unitId: string) {
  return useQuery({
    queryKey: studentUnitLandingKey(courseId, unitId),
    queryFn: () => fetchStudentUnitLandingApi(courseId, unitId),
    staleTime: 15_000,
  });
}

/**
 * 建卷工作流选项（M3-D1.5；M5-D2 未设置态）：执行时同步读本机偏好——只传
 * 学生偏好，教师约束由服务端 resolver 裁决，客户端不预判；显式携带
 * workflowVersion=1 进入新协议。feedbackMode 只在偏好已设置时携带——未设置
 * （null）整个键不发，服务端按 学生缺省/文档推荐/教师限制 裁决（§5.4）。
 */
export const workflowStartOptions = () => {
  const feedback = getPracticePreference().feedback;
  return {
    workflowVersion: 1 as const,
    ...(feedback !== null ? { feedbackMode: feedback } : {}),
  };
};

/** 创建/取回 attempt（作业来源入口；返回摘要含 status 决定走答题还是结果视图） */
export function useStartAttempt(assignmentId: string) {
  return useMutation({
    // mutationFn 执行时才读偏好（点击时刻），不在模块顶层求值
    mutationFn: () => startAttemptApi(assignmentId, workflowStartOptions()),
  });
}

/**
 * 反馈节奏切换（M5-D3）：PATCH /attempts/:id/workflow，携带当前
 * workflowRevision 做 CAS。成功与 WORKFLOW_REVISION_STALE 都失效该 attempt
 * 详情查询（服务端投影为权威，invalidate 即 refetch）；stale 额外给出
 * 「已刷新，请重试」提示；其他错误透传服务端 message（notice）。禁用只按
 * 服务端投影（canChangeFeedback/allowedFeedbackModes），客户端不预判授权。
 */
export function useUpdateAttemptWorkflow(attemptId: string) {
  const queryClient = useQueryClient();
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: PracticeWorkflowUpdateRequest) =>
      updateAttemptWorkflowApi(attemptId, input),
    onSuccess: () => {
      setStaleNotice(null);
      void queryClient.invalidateQueries({
        queryKey: studentAttemptKey(attemptId),
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "WORKFLOW_REVISION_STALE") {
        // revision 被并发修改（如另一设备已改）：先重取投影再提示重试，
        // 学生基于刷新后的服务端值重试，不保留过期 revision
        void queryClient.invalidateQueries({
          queryKey: studentAttemptKey(attemptId),
        });
        setStaleNotice("反馈节奏刚被其他操作修改，已刷新，请重试");
      }
    },
  });
  return {
    ...mutation,
    staleNotice,
    /** 就地提示（节奏组下方 alert）：stale 提示优先，其余透传服务端 message */
    notice:
      staleNotice ??
      (mutation.error instanceof Error ? mutation.error.message : null),
  };
}

/**
 * 课程练习入口（T2A.6，D10）：开始/继续/再做一次。
 * 成功后失效落地页与课程列表（目录状态徽章、首页进度联动）。
 * M5-D3（裁决⑨）：options 由调用方组装传入——未显式触碰节奏时传 undefined，
 * mutationFn 执行时才读偏好（点击时刻，维持 D2 链：偏好已设置才携带
 * feedbackMode，未设置由服务端按 单元推荐/教师约束 裁决）；开始页显式触碰
 * 节奏时传 {...workflowStartOptions(), feedbackMode: 所选}（显式选择恒最高）。
 */
export function useStartCourseAttempt(courseId: string, unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: PracticeWorkflowStartOptions | undefined) =>
      startCourseAttemptApi(
        courseId,
        unitId,
        options ?? workflowStartOptions(),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentUnitLandingKey(courseId, unitId),
      });
    },
  });
}

/**
 * 交卷：mutation 入参 = 页面渲染的题目版本集合（T6R.3 建卷冻结下发过
 * questionRevisionId，交卷原样回传验证——旧标签页陈旧提交被 409
 * QUESTION_REVISION_STALE 可诊断拒绝，提示刷新后重交）+ 每题笔记证据声明
 * （T6R.10：none/frozen/missing，服务端同一事务固定原稿）。成功后失效
 * attempt 详情、作业列表（首页状态徽章联动）与课程侧数据（T2A.6：目录单元
 * 状态、单元落地页、首页课程卡片进度）；错题本与我的记录同步失效——交卷即
 * 产生新的已判定轮次（2026-10 重练后回错题本立即可见新轮次，不受 15s
 * staleTime 影响看到旧聚合）。
 * T6R.10 响应丢失口径：提交实际上已成功但回执丢失时，重试收到 409
 * ALREADY_SUBMITTED——同样失效 attempt 详情（详情重取即切结果视图，
 * 不把用户困在答题页），错误文案由服务端中文 message 承载。
 */
export function useSubmitAttempt(attemptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      revisions: AttemptSubmitRevision[];
      /** 每题笔记证据声明（T6R.10）；旧客户端语义不适用于本前端，恒携带 */
      evidence: SubmitEvidenceDeclaration[];
    }) => submitAttemptApi(attemptId, input.revisions, input.evidence),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentAttemptKey(attemptId),
      });
      void queryClient.invalidateQueries({ queryKey: studentAssignmentsKey });
      void queryClient.invalidateQueries({ queryKey: studentCoursesKey });
      void queryClient.invalidateQueries({ queryKey: ["student", "course"] });
      // 前缀失效（studentWrongQuestionsKey 是带参函数，这里取其前两层前缀）
      void queryClient.invalidateQueries({
        queryKey: ["student", "wrong-questions"],
      });
      void queryClient.invalidateQueries({ queryKey: ["student", "records"] });
    },
    onError: (err) => {
      // 响应丢失后的重试撞 409 ALREADY_SUBMITTED：交卷实际已成功——失效
      // 详情让视图切到结果页（方案 §6.4 第 4 步：绝不自动重交产生不同引用）
      if (err instanceof ApiError && err.code === "ALREADY_SUBMITTED") {
        void queryClient.invalidateQueries({
          queryKey: studentAttemptKey(attemptId),
        });
      }
    },
  });
}

/**
 * 草稿保存的底层调用（useAttemptAnswers 直接调用，不走 useMutation——
 * 高频触发（每次作答/每个防抖窗）时 mutation 栈会堆积无意义的历史条目）。
 * 失败由调用方捕获并置「保存失败」提示；重试靠学生继续作答或刷新页面。
 */
const answerSaveTails = new Map<string, Promise<void>>();
export function saveDraftAnswer(
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
): Promise<AttemptAnswerSaveData> {
  const epoch = getDraftSessionEpoch();
  const mutationId =
    draftStore.answerMutationId(attemptId, questionId) ?? randomUuid();
  const key = JSON.stringify([epoch, attemptId, questionId]);
  const prior = answerSaveTails.get(key) ?? Promise.resolve();
  const task = prior.then(async () => {
    if (epoch !== getDraftSessionEpoch())
      throw new Error("作答会话已切换，旧答案未上传");
    const record = await draftStore.loadDraft(attemptId, { strictRead: true });
    if (epoch !== getDraftSessionEpoch())
      throw new Error("作答会话已切换，旧答案未上传");
    if (record?.answerConflicts?.[questionId])
      throw new Error("本题答案有同步冲突，请先选择保留哪一份");
    const baseRevision = record?.answerRevisions?.[questionId];
    try {
      const receipt = await (baseRevision === undefined
        ? saveAttemptAnswerApi(attemptId, questionId, answer)
        : saveAttemptAnswerApi(attemptId, questionId, answer, {
            baseRevision,
            mutationId,
          }));
      if (epoch !== getDraftSessionEpoch()) return receipt;
      await draftStore.markAnswerSynced(
        attemptId,
        questionId,
        answer,
        receipt.revision,
      );
      return receipt;
    } catch (cause) {
      if (
        epoch === getDraftSessionEpoch() &&
        cause instanceof ApiError &&
        cause.code === "ANSWER_REVISION_CONFLICT"
      ) {
        const current = attemptAnswerConflictCurrentSchema.safeParse(
          cause.extra?._current,
        );
        if (current.success)
          draftStore.setAnswerConflict(attemptId, questionId, current.data);
      }
      throw cause;
    }
  });
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  answerSaveTails.set(key, tail);
  void tail.then(() => {
    if (answerSaveTails.get(key) === tail) answerSaveTails.delete(key);
  });
  return task;
}
