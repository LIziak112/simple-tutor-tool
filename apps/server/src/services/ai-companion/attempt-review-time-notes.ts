export function globalNotesOf(hasAnyInk: boolean): string[] {
  const notes = [
    "整体复盘为文字上下文：不包含题面图片、草稿与正式笔迹图像，不能分析书写过程。",
    "作答用时以 time 字段的封存题内活动账为准；legacy_focus 明确表示历史焦点口径，activeSec 仅保留历史兼容。缺失不代表 0，不跨口径比较。",
    "一次练习不能代表长期能力掌握情况。",
  ];
  if (hasAnyInk) {
    notes.push("本次练习存在正式笔迹：笔迹内容未包含在本任务中。");
  }
  return notes;
}

/** 发送字段说明（预览知情；学生确认的范围即这些字段） */
export const FIELD_NOTES: readonly string[] = [
  "将随任务发送：每题题干与选项、知识点与难度、你的正式答案文本、参考答案与官方解析（按当前公布规则允许时）、判分状态与作答状态。",
  "不会发送：草稿、教师批注、图片与正式笔迹图像、其他练习或其他学生的数据。",
];
