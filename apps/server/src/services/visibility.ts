/**
 * 学生可见性纯函数（T2A.1，Phase 2A 改进任务清单 D5）。
 *
 * canStudentSeeItem 是学生端课程目录可见规则的**唯一判定函数**（T2A.5 起所有学生端
 * 接口复用；本任务先实现函数与测试，接口切换属 T2A.5）。学生能看到某目录条目，
 * 当且仅当同时满足：
 * 1. 学生未归档，且是该课程成员；
 * 2. 课程未归档；
 * 3. 条目 visible = true，且 publishAt 为空或 ≤ 现在；
 * 4. 被引用资源未软删；单元条目还要求该单元至少有 1 道未删除题目。
 *
 * 纯函数约定：不读库、不读时钟——全部条件由调用方查好传入，now 可注入
 * （publishAt 到点判断在测试中用固定时钟覆盖）。
 */

/** canStudentSeeItem 的条件输入（调用方从库中查出后传入） */
export interface StudentItemVisibilityInput {
  /** 学生是否已归档（students.archivedAt 非空 → true） */
  readonly studentArchived: boolean;
  /** 该学生是否为该课程成员（course_students 命中） */
  readonly isMember: boolean;
  /** 课程是否已归档（courses.archivedAt 非空 → true） */
  readonly courseArchived: boolean;
  /** 条目 visible（course_items.visible） */
  readonly itemVisible: boolean;
  /** 条目定时发布时间（course_items.publishAt，UTC ISO）；NULL = 不定时 */
  readonly publishAt: string | null;
  /** 被引用资源是否已软删（lectures/units.deletedAt 非空 → true）；分节恒 false */
  readonly resourceDeleted: boolean;
  /**
   * 单元条目的未删除题目数（questions.deletedAt IS NULL 计数）；
   * 讲义/分节条目传 null——D5 条件 4 的题目数检查只对单元条目生效。
   */
  readonly unitLiveQuestionCount: number | null;
}

/** 把 now 规整为 epoch 毫秒（支持 Date 或 UTC ISO 字符串注入） */
function nowMs(now: Date | string): number {
  return typeof now === "string" ? Date.parse(now) : now.getTime();
}

/**
 * D5 判定：全部条件同时满足才可见（见文件头注释）。
 * publishAt 与 now 比较用 epoch 毫秒（避免不同精度 ISO 字符串的字典序陷阱），
 * 「≤ 现在」含等于——到点即刻可见。
 */
export function canStudentSeeItem(
  input: StudentItemVisibilityInput,
  now: Date | string,
): boolean {
  // 条件 1：学生未归档 + 是课程成员
  if (input.studentArchived || !input.isMember) return false;
  // 条件 2：课程未归档
  if (input.courseArchived) return false;
  // 条件 3：条目可见 + 定时发布已到点（publishAt 为空 = 不定时）
  if (!input.itemVisible) return false;
  if (input.publishAt !== null && Date.parse(input.publishAt) > nowMs(now)) {
    return false;
  }
  // 条件 4：资源未软删；单元条目至少 1 道未删除题目
  if (input.resourceDeleted) return false;
  if (input.unitLiveQuestionCount !== null && input.unitLiveQuestionCount < 1) {
    return false;
  }
  return true;
}
