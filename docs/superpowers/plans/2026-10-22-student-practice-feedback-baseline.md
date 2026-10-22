# 学生做题反馈升级 — 已核实基线（2026-10-22）

## 复用与现状

- 可复用组件已核实：`AttemptSession` / `QuestionSurface` / `FinalAnswerInput` / `PaperPresentation`。
- `submitLessonQuestion` 现仅服务 lesson，且在事务外读答案判分；M2 必须改为事务内核对答案 revision 再判分。
- `useAttemptAnswers.flush` 目前为全局 flush，须扩展为按题提交。
- AI 普通来源目前按整卷完成判定，后续须识别题级完成。
- pending-mark 已有 `submittedAt` 谓词，收尾时保留 `teacherMark`。
- 教师设置实际路径：`apps/web/src/pages/teacher/SettingsPage.tsx`；反馈配置不混入 steps/ink。

## 待验收矩阵

- 四种组合：list/single × per_question/after_attempt。
- 七种题型全覆盖。
- AI 三布局（回复阅读布局等）逐一验收。
- 普通取卷（非反馈路径）永不携带未提交题的答案；反馈走专用投影。
- 最后一题提交后保留解析展示，不自动跳转。
- 手写落盘失败时不切题。

## 真机待验收

- 真机 / Pencil 手写场景待验收。

## 真实基线

- `pnpm test --maxWorkers=4`：453 个测试文件、5312 个用例，全部通过。
- lint / typecheck / build 均 exit 0（存在旧 warning，非本次引入）。
