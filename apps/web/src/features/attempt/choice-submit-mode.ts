/** 只保存该次练习在本设备的单选提交偏好，默认手动。 */
export function readAutoSubmitChoice(attemptId: string): boolean {
  try {
    return (
      localStorage.getItem(`ownclass:practice-choice-submit:${attemptId}`) ===
      "auto"
    );
  } catch {
    return false;
  }
}

export function saveAutoSubmitChoice(attemptId: string, auto: boolean) {
  try {
    const key = `ownclass:practice-choice-submit:${attemptId}`;
    if (auto) localStorage.setItem(key, "auto");
    else localStorage.removeItem(key);
  } catch {
    // 存储不可用时，本次页面内仍可切换。
  }
}
