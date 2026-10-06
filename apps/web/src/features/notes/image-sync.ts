/**
 * 图片任务调度与补图恢复（T6R.6）：把渲染器产物经 T6R.5 的
 * POST /note-versions/:id/images 槽位上传落齐，并提供「正文 synced 而图片
 * failed/missing」的恢复入口。依据：docs/题目草稿功能方案.md §7、
 * docs/Phase6任务清单.md T6R.6「恢复」节。
 *
 * 生命周期口径（任务验收「卸载不吞错」）：
 * - 队列是**模块级单例**，完全脱离 React 生命周期——题卡卸载后作业照常
 *   渲染与上传（方案 §7「允许题卡已卸载」）；
 * - 串行：全局同时最多一份编码/上传在途（方案 §7「最多同时编码一份」，
 *   T6R.1 实验室预算试验同款约束——多作业在飞会叠加离屏位图内存）；
 * - 失败不吞错：作业错误原样经返回的 Promise 拒绝（调用方必须 .catch 或
 *   await——组件卸载后 catch 闭包仍执行，状态更新为 no-op），同时记入
 *   noteImageQueueStats().lastError 供诊断轮询；**失败不毒化队列**；
 * - 重试 = 再次调用 syncNoteImages/recoverNoteImages 整链重入：渲染确定性
 *   （同文档/规格/renderVersion 输出一致）+ 服务端槽位幂等 upsert，重复
 *   上传安全；「不可信旧图片」也可用同入口强制重建。
 *
 * 与后续任务的分工：本地排队/退避/状态机是 T6R.8（note-sync）的职责；答题页
 * 触发与状态展示是 T6R.9；本文件只提供可脱离组件调用的同步原语。
 *
 * 已知限制（复审⑦）：上传是**逐槽位 upsert**——renderVersion 递增且新切片
 * 方案页数变少时，旧的高页码槽位会残留（不会被本链路清除）；「完整重建 =
 * 替换整个槽位集」需要服务端槽位集替换语义，留后续任务裁定，不在本单扩。
 */
import {
  type NoteDoc,
  type NoteImageMeta,
  type NoteImageSpec,
  noteDocSchema,
} from "@tutor/contract";
import {
  fetchStudentNoteDocumentApi,
  fetchTeacherNoteDocumentApi,
  type NoteImageRole,
  postNoteImageApi,
} from "@/lib/api";
import {
  forEachRenderedNotePage,
  noteImageUploadMetaOf,
  type RenderedNotePage,
} from "./render-note.ts";

// ---------- 串行队列 ----------

/** 队列瞬时状态（诊断/状态展示轮询用） */
export interface NoteImageQueueStats {
  /** 在途作业数（0 或 1——串行约束） */
  active: number;
  /** 排队等待数 */
  queued: number;
  /** 最近一次作业失败的错误文案；null = 无失败记录 */
  lastError: string | null;
}

/**
 * 串行异步任务队列：任务按入队顺序逐个执行（前一任务的成败都不阻塞后一
 * 任务——失败不毒化）。内部链吞掉 rejection 只记录文案；对调用方返回的
 * Promise 保持原始拒绝（不吞错）。导出供测试与未来多队列场景构造独立实例；
 * 运行时图片派生走下方模块级单例。
 */
export class SerialTaskQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #active = 0;
  #queued = 0;
  #lastError: string | null = null;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const start = (): Promise<T> => {
      this.#queued -= 1;
      this.#active += 1;
      // Promise.resolve().then(task)：task 同步抛错也走 rejection 路径，
      // .finally 必然执行——#active 不因同步 throw 泄漏（复审①）
      return Promise.resolve()
        .then(task)
        .finally(() => {
          this.#active -= 1;
        });
    };
    // #tail 永远 resolve（吞掉前一个的失败）⇒ 后续任务照常执行
    const result = this.#tail.then(start, start);
    this.#tail = result.then(
      () => undefined,
      (err: unknown) => {
        this.#lastError = err instanceof Error ? err.message : String(err);
        return undefined;
      },
    );
    return result;
  }

  stats(): NoteImageQueueStats {
    return {
      active: this.#active,
      queued: this.#queued,
      lastError: this.#lastError,
    };
  }
}

/** 图片派生全局队列（模块级单例：脱离组件生命周期，卸载不停摆） */
let noteImageQueue = new SerialTaskQueue();

// ---------- 同步原语 ----------

/** syncNoteImages / recoverNoteImages 公共参数（角色 + 目标版本） */
export interface NoteImageSyncParams {
  /** 学生补自己的图 / 教师按授权补学生版本（方案 §7 教师重建）；类型与
   * 上传客户端同源（复审⑩：不在两处手写同一联合） */
  role: NoteImageRole;
  /** 目标 NoteVersion（补图只挂既定版本，不改正文） */
  versionId: string;
}

/**
 * 按计划渲染并上传一个版本的全套派生图（缩略图 1 页 + 分析图按需切片），
 * 逐页走全局串行队列：渲染 → 上传 → 回执收集。中途失败：已传槽位留在服务端
 * （幂等 upsert），Promise 拒绝；重试整链重入即可补齐。
 *
 * 注：不做「已有槽位跳过」——确定性渲染 + 幂等 upsert 下重传成本可控，
 * 且「不可信旧图片」本就需要无条件重建通道；增量优化留给 T6R.9 接入时
 * 按实测再定。
 */
export function syncNoteImages(
  params: NoteImageSyncParams & { doc: NoteDoc },
): Promise<NoteImageMeta[]> {
  const { role, versionId, doc } = params;
  return noteImageQueue.run(async () => {
    const metas: NoteImageMeta[] = [];
    const upload =
      (spec: NoteImageSpec) =>
      async (page: RenderedNotePage): Promise<void> => {
        metas.push(
          await postNoteImageApi(
            role,
            versionId,
            page.blob,
            noteImageUploadMetaOf(spec, page),
          ),
        );
      };
    // 缩略图先行的上传顺序维持（AI 先见正文图的评估在 T6R.13）；
    // 逐页骨架（缓存/让出/中止语义）与 renderNoteImages 同源
    await forEachRenderedNotePage(doc, "thumbnail", upload("thumbnail"));
    await forEachRenderedNotePage(doc, "analysis", upload("analysis"));
    return metas;
  });
}

/**
 * 补图恢复入口（任务验收「正文 synced 而图片 failed 的恢复」）：拉取版本
 * 正文 → noteDocSchema 收窄（缺省高度/背景物化——不物化会 NaN，见契约
 * NoteDocInput 注释）→ syncNoteImages 重建补传。学生重新进入草稿或教师
 * 查看证据时触发（接线在 T6R.9/T6R.11）；正文损坏/版本不兼容时明确报错，
 * 不静默跳过。
 */
export async function recoverNoteImages(
  params: NoteImageSyncParams,
): Promise<NoteImageMeta[]> {
  const raw =
    params.role === "student"
      ? await fetchStudentNoteDocumentApi(params.versionId)
      : await fetchTeacherNoteDocumentApi(params.versionId);
  const parsed = noteDocSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "形状错误";
    throw new Error(`草稿正文损坏或版本不兼容，无法重建派生图：${first}`);
  }
  return syncNoteImages({ ...params, doc: parsed.data });
}

/** 队列状态快照（诊断/状态展示） */
export function noteImageQueueStats(): NoteImageQueueStats {
  return noteImageQueue.stats();
}

/**
 * **仅测试使用**：复位模块级队列单例（vitest beforeEach 隔离用例间状态）。
 * 生产代码不得调用——运行中调用会绕过串行约束。
 */
export function resetNoteImageQueueForTest(): void {
  noteImageQueue = new SerialTaskQueue();
}
