/**
 * 纯函数判分包（骨架占位）。
 * 硬性规则：判分只在服务端执行，客户端结果不可信。正式判分逻辑在后续任务实现。
 */

/**
 * 占位判分函数：当前恒等返回，用于打通包结构与测试链路。
 * @param answer 标准答案占位入参
 * @returns 与入参相同的占位结果
 */
export function gradeIdentity(answer: string): string {
  return answer;
}
