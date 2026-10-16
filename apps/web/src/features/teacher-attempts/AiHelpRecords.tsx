import type {
  AiFactType,
  AiTaskStatus,
  AiTeacherFact,
  AiTeacherTaskDetailData,
  AiTeacherTaskRecord,
} from "@tutor/contract";
import { cn } from "cn";
import { Bot, ChevronDown, HelpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";
import { CHANNEL_LABEL } from "@/features/student-ai/ai-channel-label";
import { AI_INHERITABLE_MODE_LABELS } from "@/features/student-ai/ai-policy-text";
import { teacherAiTaskMaterialPngUrl } from "@/lib/api";
import { type AiHelpLabelKind, aiHelpLabelOf } from "./ai-help-label";
import {
  useTeacherAiTaskDetail,
  useTeacherAttemptAiRecords,
} from "./ai-help-queries";

/**
 * SAI-24 教师督学：题卡 AI 求助标签 + 按卷求助记录抽屉（B13）。
 *
 * 标签（ai-help-label 纯函数单源）旁置呈现——对错/待批/分数/评语原值不动；
 * 抽屉只消费服务端事实行（时间/诉求/通道/当时模式），回信正文、当时模板与
 * 材料图按任务经详情端点按需加载（列表载荷即抽屉默认可见的全部内容）。
 * 键盘可达：打开走按钮（Enter/Space），关闭用 Esc（Sheet 焦点圈闭，关闭后
 * 焦点返回触发按钮）。读取失败提供显式重试，不把失败当空记录。
 */

/** 标签配色（颜色只是辅助，文字承担完整含义——需求 §11 完成条件③） */
const AI_HELP_BADGE_CLASS: Record<AiHelpLabelKind, string> = {
  none: "bg-muted text-muted-foreground",
  review: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  queued: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "unknown-outbound": "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "late-outbound": "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  helped: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

/** 事实类型中文（教师域时间线；与 aiFactTypeSchema 一一对应） */
const AI_HELP_FACT_LABELS: Record<AiFactType, string> = {
  task_created: "创建求助",
  link_generated: "生成上下文链接",
  dispatched: "已外发给 AI",
  link_viewed: "外部链接被读取",
  reply_received: "平台收到回信",
  reply_delivered: "学生查看回信",
  paused: "学生暂停",
  resumed: "学生继续",
  cancelled: "取消",
  failed: "外发失败",
  late_reply: "迟到回信",
  archived: "学生归档",
};

/** 处理状态中文（教师督学口径；与学生队列文案独立措辞） */
const AI_HELP_STATUS_LABELS: Record<AiTaskStatus, string> = {
  created: "仅入队未外发",
  dispatching: "正在外发",
  uncertain: "出站状态未确认",
  claimed: "已领取处理中",
  replied: "已收到回信",
  paused: "已暂停",
  failed: "外发失败",
  cancelled: "已取消",
};

/** 时间呈现（YYYY-MM-DD HH:mm，事实行保留服务端时刻） */
function formatFactTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 事实时间线行（detail 里的连接方式等细节不逐键展开——需要时教师看任务详情） */
function FactTimeline({ facts }: { facts: readonly AiTeacherFact[] }) {
  if (facts.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      {facts.map((fact) => (
        <li key={fact.id} className="flex flex-wrap gap-1.5">
          <span className="tabular-nums">{formatFactTime(fact.serverTs)}</span>
          <span>
            {AI_HELP_FACT_LABELS[fact.type]}
            {fact.beforeSubmit ? "（提交前）" : "（提交后）"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 材料类别中文 */
const MATERIAL_KIND_LABELS = {
  annotation: "题面圈画",
  draft: "草稿",
  formal_ink: "正式手写",
} as const;

/**
 * 单条材料（按需图像加载）：ready 才挂 <img>（loading=lazy，进入视口才取
 * PNG）；missing/failed/pending 真实呈现缺失与原因，不用新稿或空图冒充。
 */
function AiTaskMaterialImage({
  taskId,
  material,
}: {
  taskId: string;
  material: AiTeacherTaskDetailData["task"]["materials"][number];
}) {
  const [broken, setBroken] = useState(false);
  if (material.state !== "ready" || broken) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        {MATERIAL_KIND_LABELS[material.kind]} 第 {material.pageIndex + 1} 页：
        {broken
          ? "图像加载失败（可重开详情重试）"
          : material.state === "missing"
            ? `材料缺失——${material.missingReason ?? "原因未记录"}`
            : material.state === "failed"
              ? "材料固定失败"
              : "材料固定中"}
      </p>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={teacherAiTaskMaterialPngUrl(taskId, material.id)}
        alt={`${MATERIAL_KIND_LABELS[material.kind]} 第 ${material.pageIndex + 1} 页`}
        loading="lazy"
        className="w-full rounded-lg border border-border bg-white"
        onError={() => setBroken(true)}
      />
      <figcaption className="text-xs text-muted-foreground">
        {MATERIAL_KIND_LABELS[material.kind]} 第 {material.pageIndex + 1} 页 ·{" "}
        {material.pixelWidth}×{material.pixelHeight}
      </figcaption>
    </figure>
  );
}

/**
 * 任务详情展开区（按需查询）：当时模板（promptSnapshotMd 固化在快照里）+
 * 实际对话（assistant 回复全量；外部链接无平台回信时如实呈现「未知」）+
 * 固定材料图。失败三态齐全，重试不静默。
 */
function AiTaskDetailExpansion({ taskId }: { taskId: string }) {
  const detail = useTeacherAiTaskDetail(taskId);
  if (detail.isPending) {
    return <p className="text-sm text-muted-foreground">任务详情读取中…</p>;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-red-600">任务详情读取失败</p>
        <Button
          variant="outline"
          className="min-h-11 w-fit"
          onClick={() => void detail.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }
  const data = detail.data;
  const replies = data.messages.filter((m) => m.role === "assistant");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <section className="flex flex-col gap-1.5" aria-label="当时模板与模式">
        <p className="text-xs font-medium text-muted-foreground">
          当时模式：{AI_INHERITABLE_MODE_LABELS[data.task.modeAtSend]} · 发送时
          固化的提示词（含模式硬约束）：
        </p>
        <RichMarkdown
          source={data.task.contextSnapshot.promptSnapshotMd}
          className="rounded-lg bg-background p-3 text-sm"
        />
      </section>
      <section className="flex flex-col gap-1.5" aria-label="实际回复">
        <p className="text-xs font-medium text-muted-foreground">实际回复：</p>
        {replies.length > 0 ? (
          <div className="flex flex-col gap-2">
            {data.messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-lg p-3 text-sm",
                  message.role === "student"
                    ? "bg-background"
                    : "bg-background border border-border",
                )}
              >
                <p className="mb-1 text-xs text-muted-foreground">
                  {message.role === "student" ? "学生" : "AI 回信"} ·{" "}
                  {formatFactTime(message.createdAt)}
                </p>
                <RichMarkdown
                  source={message.contentMd}
                  className="text-sm [&_p]:my-1"
                />
              </div>
            ))}
          </div>
        ) : data.task.channel === "link" ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            外部链接求助——平台未收到回信正文；谁读取了链接、是否实际辅导，
            平台无法确认（仅记录链接读取事实）。
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            平台未收到 AI 回信（{AI_HELP_STATUS_LABELS[data.task.status]}）。
          </p>
        )}
      </section>
      {data.task.materials.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="固定材料">
          <p className="text-xs font-medium text-muted-foreground">
            固定材料（发送时快照，不随此后的新稿变化）：
          </p>
          {data.task.materials.map((material) => (
            <AiTaskMaterialImage
              key={material.id}
              taskId={taskId}
              material={material}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** 单条任务记录卡（默认收起详情；展开按需查询） */
function AiTaskRecordCard({ record }: { record: AiTeacherTaskRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
      aria-label={`求助记录 ${formatFactTime(record.createdAt)}`}
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium tabular-nums">
          {formatFactTime(record.createdAt)}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
          {CHANNEL_LABEL[record.channel]}
        </span>
        <span className="text-xs text-muted-foreground">
          当时模式：{AI_INHERITABLE_MODE_LABELS[record.modeAtSend]}
        </span>
        <span className="text-xs text-muted-foreground">
          {record.beforeSubmit ? "提交前发起" : "提交后发起"}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs",
            record.status === "failed" || record.status === "uncertain"
              ? "bg-orange-500/15 text-orange-700 dark:text-orange-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {AI_HELP_STATUS_LABELS[record.status]}
        </span>
      </p>
      <p className="text-sm">学生诉求：{record.question}</p>
      {record.status === "failed" && record.errorText !== null && (
        <p className="text-xs text-red-600">失败摘要：{record.errorText}</p>
      )}
      {record.cancelRequestedAt !== null && (
        <p className="text-xs text-muted-foreground">
          取消请求于 {formatFactTime(record.cancelRequestedAt)}（已外发的信息
          无法撤回，事实保留）
        </p>
      )}
      {record.archivedAt !== null && (
        <p className="text-xs text-muted-foreground">
          学生归档于 {formatFactTime(record.archivedAt)}（归档只是队列整理，
          事实保留）
        </p>
      )}
      <FactTimeline facts={record.facts} />
      <Button
        variant="outline"
        className="min-h-11 w-fit"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? "收起详情" : "查看详情（模板 / 回复 / 材料）"}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </Button>
      {expanded && <AiTaskDetailExpansion taskId={record.taskId} />}
    </article>
  );
}

/** 抽屉内记录分页（长记录分页；单页内不渲染翻页按钮） */
const RECORDS_PAGE_SIZE = 5;

function RecordsPagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label="求助记录分页"
      className="flex items-center justify-between gap-3"
    >
      <p aria-live="polite" className="text-sm text-muted-foreground">
        第 {page + 1} / {pageCount} 页
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </nav>
  );
}

/** 求助记录抽屉（只列本题任务行；键盘 Esc 关闭，焦点返回打开按钮） */
export function AiHelpRecordsDrawer({
  open,
  onOpenChange,
  questionNo,
  records,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionNo: number;
  records: readonly AiTeacherTaskRecord[];
}) {
  const pageCount = Math.max(1, Math.ceil(records.length / RECORDS_PAGE_SIZE));
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (open) setPage(0);
  }, [open]);
  const visible = records.slice(
    page * RECORDS_PAGE_SIZE,
    (page + 1) * RECORDS_PAGE_SIZE,
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[min(90vw,40rem)]">
        <SheetHeader>
          <SheetTitle>第 {questionNo} 题 · AI 求助记录</SheetTitle>
          <SheetDescription>
            共 {records.length} 条平台事实记录（取消与归档不消除事实）；回信
            正文与材料图按任务展开加载。
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            {visible.map((record) => (
              <AiTaskRecordCard key={record.taskId} record={record} />
            ))}
          </div>
          <RecordsPagination
            page={page}
            pageCount={pageCount}
            onPageChange={setPage}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 题卡的 AI 求助标签区（旁置呈现；对错/待批/分数原值不在本区）。
 * 同页多卡共享按卷缓存（React Query 按 attemptId 去重）；三态齐全——
 * 读取中/失败（显式重试，不把失败当无记录）/数据就绪。
 */
export function AiHelpQuestionSection({
  attemptId,
  questionId,
  questionNo,
}: {
  attemptId: string;
  questionId: string;
  questionNo: number;
}) {
  const records = useTeacherAttemptAiRecords(attemptId);
  const [drawerOpen, setDrawerOpen] = useState(false);
  if (records.isPending) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Bot aria-hidden className="size-4" />
        AI 求助记录读取中…
      </p>
    );
  }
  if (records.isError) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-red-600">AI 求助记录读取失败</span>
        <Button
          variant="outline"
          className="h-9 px-3 text-xs"
          onClick={() => void records.refetch()}
        >
          重试
        </Button>
      </p>
    );
  }
  const facts = records.data.questions.find(
    (entry) => entry.questionId === questionId,
  )?.facts;
  const taskRecords = records.data.records.filter(
    (record) => record.questionId === questionId,
  );
  const label = aiHelpLabelOf(facts, taskRecords);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${AI_HELP_BADGE_CLASS[label.kind]}`}
      >
        {label.kind === "none" ? (
          <HelpCircle aria-hidden className="size-3.5" />
        ) : (
          <Bot aria-hidden className="size-3.5" />
        )}
        {label.text}
      </span>
      {taskRecords.length > 0 && (
        <>
          <Button
            variant="outline"
            className="min-h-11 px-3 text-xs"
            aria-label={`打开第 ${questionNo} 题的 AI 求助记录（共 ${taskRecords.length} 条）`}
            onClick={() => setDrawerOpen(true)}
          >
            求助记录 {taskRecords.length} 条
          </Button>
          <AiHelpRecordsDrawer
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            questionNo={questionNo}
            records={taskRecords}
          />
        </>
      )}
    </div>
  );
}
