/**
 * 批量头合批协调（T6R.14：N 题同 tick 挂载 → 1 次批量 POST；W2 起为独立
 * 传输层小模块——api.ts 只放端点函数，react-query 接线文件不再持有合批
 * 状态；独立成模块同时让 vi.mock("@/lib/api") 能拦到传输出口，合批行为
 * 可单测）。
 *
 * 答题页每道可草稿题各挂一个 useNoteHead（各自 queryKey、各自副作用），逐题
 * GET 在二十题卷上是 N 个请求——这里做**请求级合批**：
 * fetchStudentNoteHeadCoalesced 把同 attempt 同宏任务批内的多题请求合并为
 * 一次 fetchStudentNoteHeadsApi，按 questionId 把结果分发回各调用方。
 * - 待批队列与计时器合一为 headBatches 单 Map（entry = items + timer）：
 *   timer===null 即「尚无 flush 排程」，首个入队者挂宏任务计时器；
 * - 批内请求列表按 id 去重；缺条校验由 fetchStudentNoteHeadsApi 收口
 *   （W1），分发只做映射；
 * - 跨 attempt 各自成批；flush 先整体移除 entry——flush 期间新入队的题
 *   自然落入下一批；
 * - resetNoteHeadBatchForTest 为测试出口（清空在途批与计时器，生产不调用）。
 */
import type { NoteHeadData } from "@tutor/contract";
import { fetchStudentNoteHeadsApi } from "@/lib/api";

interface PendingHeadRequest {
  readonly questionId: string;
  readonly resolve: (head: NoteHeadData) => void;
  readonly reject: (err: unknown) => void;
}

interface HeadBatch {
  items: PendingHeadRequest[];
  timer: ReturnType<typeof setTimeout> | null;
}

const headBatches = new Map<string, HeadBatch>();

/**
 * 测试出口：清空在途批（防用例间串扰；生产不调用）。不 settle 在途
 * promise——测试弃掉 QueryClient 即弃掉等待方；假时钟丢弃待触 timer 后
 * 不 reset 会让 batch.timer 指向废弃句柄、同 attemptId 永不排程（C5）。
 */
export function resetNoteHeadBatchForTest(): void {
  for (const batch of headBatches.values()) {
    if (batch.timer !== null) clearTimeout(batch.timer);
  }
  headBatches.clear();
}

/** 统一 flush：取走该 attempt 全部待批项，一次批量请求并按 id 分发 */
function flushHeadBatch(attemptId: string): void {
  const batch = headBatches.get(attemptId);
  headBatches.delete(attemptId);
  if (batch === undefined || batch.items.length === 0) return;
  const items = batch.items;
  const questionIds = [...new Set(items.map((item) => item.questionId))];
  fetchStudentNoteHeadsApi(attemptId, questionIds)
    .then((heads) => {
      const headById = new Map<string, NoteHeadData>();
      questionIds.forEach((questionId, index) => {
        const head = heads[index];
        if (head !== undefined) headById.set(questionId, head);
      });
      for (const item of items) {
        const head = headById.get(item.questionId);
        if (head === undefined) {
          item.reject(
            new Error("批量头响应缺少该题（服务端契约违约，请重试）"),
          );
        } else {
          item.resolve(head);
        }
      }
    })
    .catch((err: unknown) => {
      for (const item of items) item.reject(err);
    });
}

/** queryFn 的拉取入口：入队 + 首入队者挂宏任务计时器（同 tick 的后来者并批） */
export function fetchStudentNoteHeadCoalesced(
  attemptId: string,
  questionId: string,
): Promise<NoteHeadData> {
  let batch = headBatches.get(attemptId);
  if (batch === undefined) {
    batch = { items: [], timer: null };
    headBatches.set(attemptId, batch);
  }
  const currentBatch: HeadBatch = batch;
  const promise = new Promise<NoteHeadData>((resolve, reject) => {
    currentBatch.items.push({ questionId, resolve, reject });
  });
  if (currentBatch.timer === null) {
    currentBatch.timer = setTimeout(() => {
      currentBatch.timer = null;
      flushHeadBatch(attemptId);
    }, 0);
  }
  return promise;
}
