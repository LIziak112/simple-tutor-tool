/**
 * 标注底图两阶段流（T6R.20 计划决策 4）：
 * ① GET 视图（已有 ready 底图直接用——底图 ready 后永不重生成）；
 * ② 无底图/pending：POST base 取装配载荷（学生 stem 投影）→ 客户端栅格化
 *    （renderAnnotationBaseImage）→ POST base/image 回传落盘 → ready。
 * 失败分类：too-tall/forbidden/EXPORT_ASSEMBLY_BROKEN → **禁用**（该题禁用
 * 标注并说明原因，草稿照用——设计兜底）；font/media/rasterize/encode 与
 * 网络错误 → 可重试错误（入口保留，显示原因）。
 */
import type { AnnotationBaseRef } from "@tutor/contract";
import { useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  postAnnotationBaseApi,
  postAnnotationBaseImageApi,
  fetchAnnotationViewApi,
  studentAnnotationBasePngUrl,
} from "@/lib/api";
import { renderAnnotationBaseImage } from "./base-image";
import {
  applyAnnotationView,
  applyBaseDisabled,
  applyBasePreview,
  type AnnotationSessionRef,
} from "./annotation-store";

/** 底图生命周期（入口按钮与工作区的渲染依据） */
export type AnnotationBaseFlow =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; base: AnnotationBaseRef }
  /** 该题禁用标注（业务性结果：超高/装配失败——草稿照用） */
  | { kind: "disabled"; reason: string }
  /** 可重试错误（网络/栅格化瞬时失败） */
  | { kind: "error"; message: string };

/** 装配哨兵（服务端 500 EXPORT_ASSEMBLY_BROKEN——该题禁用标注） */
function isAssemblyBroken(err: unknown): boolean {
  return err instanceof ApiError && err.code === "EXPORT_ASSEMBLY_BROKEN";
}

export interface UseAnnotationBaseResult {
  flow: AnnotationBaseFlow;
  /** 触发两阶段流（幂等：ready/disabled 不重跑；loading 中不重入） */
  ensureBase: () => Promise<void>;
}

/**
 * 两阶段流编排（组件层消费）。ready 判定：视图或回执给出 pixelWidth/
 * pixelHeight 后组 ready 引用（downloadUrl 客户端直构——与服务端同构，
 * studentAnnotationBasePngUrl 单源）。
 */
export function useAnnotationBase(input: {
  session: AnnotationSessionRef | null;
  attemptId: string;
  questionId: string;
  phase: "scratch" | "correction";
}): UseAnnotationBaseResult {
  const { session, attemptId, questionId, phase } = input;
  const [flow, setFlow] = useState<AnnotationBaseFlow>({ kind: "idle" });
  const running = useRef(false);
  /** 最新流状态（ensureBase 幂等判定用 ref——不进依赖，避免 effect 重触发环） */
  const flowKindRef = useRef<AnnotationBaseFlow["kind"]>("idle");
  flowKindRef.current = flow.kind;

  const ensureBase = useCallback(async (): Promise<void> => {
    if (session === null || running.current) return;
    if (flowKindRef.current === "ready" || flowKindRef.current === "disabled") {
      return;
    }
    running.current = true;
    setFlow({ kind: "loading" });
    const scope = { attemptId, questionId, phase };
    try {
      // ① 服务端视图（ready 底图直接用；同时播种 doc/revision）
      const view = await fetchAnnotationViewApi(attemptId, questionId, phase);
      await applyAnnotationView(session, scope, view);
      if (view.base !== null && view.base.state === "ready") {
        setFlow({ kind: "ready", base: view.base });
        return;
      }
      // ② 装配载荷（幂等：pending 行复用；ready 引用兜底返回）
      const preview = await postAnnotationBaseApi(attemptId, questionId, phase);
      await applyBasePreview(session, scope, preview);
      if (preview.base.state === "ready") {
        setFlow({ kind: "ready", base: preview.base });
        return;
      }
      // 客户端栅格化（两阶段第二阶段）
      const rendered = await renderAnnotationBaseImage(preview);
      if (!rendered.ok) {
        if (
          rendered.error.kind === "too-tall" ||
          rendered.error.kind === "forbidden"
        ) {
          await applyBaseDisabled(session, scope, rendered.error.message);
          setFlow({ kind: "disabled", reason: rendered.error.message });
          return;
        }
        setFlow({ kind: "error", message: rendered.error.message });
        return;
      }
      const receipt = await postAnnotationBaseImageApi(
        attemptId,
        questionId,
        rendered.blob,
        {
          questionRevisionId: preview.questionRevisionId,
          baseRenderVersion: preview.baseRenderVersion,
          ...(phase !== "scratch" ? { phase } : {}),
        },
      );
      const readyBase: AnnotationBaseRef = {
        baseId: receipt.baseId,
        state: "ready",
        stale: preview.base.stale,
        pixelWidth: receipt.pixelWidth,
        pixelHeight: receipt.pixelHeight,
        downloadUrl: studentAnnotationBasePngUrl(attemptId, receipt.baseId),
      };
      await applyBasePreview(session, scope, {
        ...preview,
        base: readyBase,
      });
      setFlow({ kind: "ready", base: readyBase });
    } catch (err) {
      if (isAssemblyBroken(err)) {
        // 投影哨兵（题干任务列表带答案等）：该题禁用标注，草稿照用
        const reason = `${err instanceof ApiError ? err.message : "题面装配失败"}——本题已禁用题干标注，草稿纸不受影响，可照常使用`;
        await applyBaseDisabled(session, scope, reason).catch(() => undefined);
        setFlow({ kind: "disabled", reason });
        return;
      }
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        // 访问权终态：禁用（不重试必然再拒的请求）
        const reason = `${err.message}——本题暂不能标注`;
        await applyBaseDisabled(session, scope, reason).catch(() => undefined);
        setFlow({ kind: "disabled", reason });
        return;
      }
      setFlow({
        kind: "error",
        message: err instanceof Error ? err.message : "底图生成失败，请重试",
      });
    } finally {
      running.current = false;
    }
  }, [session, attemptId, questionId, phase]);

  return { flow, ensureBase };
}
