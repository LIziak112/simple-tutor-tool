import type { AttemptSource } from "@tutor/contract";

/**
 * 作答来源徽章的词表与组件（2026-10 四角清理收口单源）：
 * 作业蓝、课程练习紫、错题重练橙、讲练绿——原先学生端记录卡
 * （records-views）、教师端数据卡（attempt-views）与待批队列
 * （PendingMarkQueuePage）三处平行词表收归于此；class 串原样搬，视觉零变化。
 * 讲练徽标（LessonBadge）= 来源词表的讲练绿（讲义/课程/资源库列表的
 * kind=lesson 行标四处复用，同一出处）。
 */

/** 来源中文（作业 / 课程练习 / 错题重练 / 讲练；师生两端同词表） */
export const SOURCE_LABELS: Record<AttemptSource, string> = {
  assignment: "作业",
  course: "课程练习",
  wrong: "错题重练",
  lesson: "讲练",
};

/** 来源徽章配色：作业蓝、课程练习紫、错题重练橙、讲练绿（师生两端同配色） */
export const SOURCE_BADGE_CLASS: Record<AttemptSource, string> = {
  assignment: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  course:
    "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  wrong:
    "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  lesson:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
};

/** 来源徽章（学生记录卡 / 教师数据卡 / 待批卡共用形态） */
export function SourceBadge({ sourceType }: { sourceType: AttemptSource }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_BADGE_CLASS[sourceType]}`}
    >
      {SOURCE_LABELS[sourceType]}
    </span>
  );
}

/** 讲练徽标：讲义/课程目录/资源库列表中 kind=lesson 的行标（配色同讲练绿） */
export function LessonBadge() {
  return <SourceBadge sourceType="lesson" />;
}
