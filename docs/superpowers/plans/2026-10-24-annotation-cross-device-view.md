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

## 合并、部署与线上验收

- 修复提交 `8ee2e9d6`，合并并推送 origin/v2 的运行代码提交 `95e010ec5dba887346cbf276bdfc903d6a71c321`。未操作 main。
- 云服务器 `47.116.99.166`，服务 `simple-tutor-tool`，程序 `/opt/simple-tutor-tool`；沿用已使用的 tar-over 流程，归档 SHA-256 `907ba72f6b0347fa247f91c15f46f436de999055b95d8b5c202dad4b7bc9ea1e`，服务器收包校验通过。
- 服务器记录北京时间 2026-10-24 20:24:28 停服并完整备份，20:24:56 启动，20:24:58 健康检查通过；依赖全部复用缓存，独立 staging 构建成功后切换，配置和整个数据目录保留。
- 数据备份 `/opt/simple-tutor-backups/data-before-95e010ec-20261024-202428.tar.gz`；旧程序 `/opt/simple-tutor-backups/app-before-95e010ec-20261024-202428`；日志 `/opt/simple-tutor-staging/deploy-95e010ec.log`。脚本包含失败回滚。
- 停服后的切换前后 41 张业务表按全部行内容排序后散列比较完全一致。启动及浏览验证后，除正常更新的 events/sessions 外其余表仍一致：attempts 49、responses 782、notes 59、ink 2、annotation_bases 36、annotations 35。SQLite quick_check = ok。
- 公网健康接口成功，systemd 为 active，`.deployed-commit` 与运行代码提交一致。
- 在用户已有浏览器会话中刷新实际作答 `be31d0b8-0048-4797-bfbb-89d7fc08daff`（刷新前为全部已保存），第 1 题 1 笔、第 2 题 6 笔均成功打开只读原稿，旧布局报错不再出现；关闭第一题后仍为全部已保存，未修改任何答案或笔迹。
- 第 1 题保存的旧 PNG 内部分公式原本为空白，此次按原底图展示，没有自动重建或覆盖。旧底图采集质量需另查，与本批跨设备读取解耦。
- 线上截图保存在被忽略的 `e2e/.artifacts/annotation-deploy/production-original.png` 与 `production-original-question2.png`。这些真实记录验证发生在电脑浏览器，仍不能替代 iPad/Pencil 真机操作验收。
- 本节后续文档提交只补验收记录，不改变服务器已部署的运行代码。
