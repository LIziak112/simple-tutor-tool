# 圈画跨设备查看第一批

用户已确认实施第一批，并授权完成后合并、推送 v2。

## 范围与步骤

1. 提取共用只读原稿组件：原底图与矢量笔迹按底图像素域回放，校验尺寸，加载失败可重试。
2. 结果回看复用该组件；作答页布局不兼容或旧稿缺少布局时，现有圈画入口打开只读原稿弹窗，保留原生题面与唯一作答控件。
3. 原位编辑继续严格核验布局，不重建或覆盖历史底图，不修改同步协议、契约或封存证据。
4. 先补失败测试，再实现；补充跨 WebKit/Chromium 读取同一云端记录的真实 E2E，并覆盖旧布局、本机未上传稿、加载重试及材料尺寸不符。
5. 依次做简化审查、正确性审查，运行单测、E2E、lint、typecheck、build，记录真实输出后提交并合并推送 v2。

## 文件清单

- apps/web/src/features/annotation/AnnotationOriginal.tsx 及测试
- apps/web/src/features/annotation/AnnotationView.tsx
- apps/web/src/features/annotation/QuestionAnnotationOverlay.tsx 及测试
- e2e/annotation-cross-device-view.spec.ts
- AGENTS.md 与本计划的验证记录

## 手动验收

iPad 在已有练习圈画并确认上传后，电脑打开同一题：排版兼容时原位显示；不兼容时点击圈画查看原稿，缩放不改变底图与笔迹相对位置。关闭弹窗回原入口，仍可作答。旧稿无布局信息也能查看。断网加载失败后可重试，未上传稿只在原设备显示本机状态。真机 iPad/Pencil 验收须明确单列，桌面 WebKit 不代替真机。

## 简化与正确性审查

- 简化：提取原有静态笔迹回放为 AnnotationOriginal，结果回看与作答页共用；保留已有绘制入口，不另建栅格化或答案控件。
- 正确性：只读查看与原位编辑准入分开；布局不兼容不再抛“重新开始练习”，也不解除编辑校验。实际 PNG 尺寸与正文坐标域不符拒绝叠画，网络失败可重试。
- 异步与会话：Blob URL 按来源对象核对并释放；弹窗按部署、账号、作答、题目和重置代次隔离，范围改变或隐藏即关闭；关闭恢复真实圈画入口焦点。
- 安全：未改契约、服务端接口或普通学生投影；只使用现有授权底图和笔迹，不重新采集题目。跨内核 E2E 检查学生载荷无泄露、查看期间无上传、云端记录前后相同。
- 历史兼容：没有 layout 字段的旧稿直接在原底图上只读回放，不伪造布局信息或替换底图。第二批的字体和签名算法调整不在本次范围内。
- 本轮逐行审查未留下待修复的代码发现；真实硬件验收另列，不能以桌面 WebKit 通过替代。

## 自动验证结果

- TDD：先将不兼容布局测试改为查看原稿，出现 1 项预期失败；实现后定向单测 20 文件、191 项通过。
- `pnpm test --maxWorkers=2`：486 文件、5765 项全部通过，921.59 秒。先前高并发与其他测试同时运行时出现超时，已停止该轮并以低并发完整重跑。
- `pnpm e2e e2e/annotation-cross-device-view.spec.ts e2e/question-inline-annotation.spec.ts e2e/annotation-paper-interaction.spec.ts e2e/annotation-local-base.spec.ts --workers=1`：28 项通过，5.3 分钟。双向跨内核读取同一云端原稿，历史 layout 缺省、图片失败重试、云端数据不变及零上传断言通过；已查看两种浏览器的截图。
- `pnpm lint`：1233 文件，无错误；`pnpm typecheck` 与 `pnpm build` 均退出 0。
- `git diff --check` 与暂存区检查均退出 0。
- 真机 iPad/Pencil 验收尚未执行；按仓库手写技能要求，桌面 WebKit 结果不替代真机。

用户追加授权：完成后合并 v2、推送远端并部署云服务器；部署前备份，部署后验证健康与原稿查看。
