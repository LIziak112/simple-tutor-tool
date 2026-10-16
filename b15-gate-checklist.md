# B15 质量闸门清单（codex/student-ai-b15 @ 10a36a55，diff v2...HEAD）

## 第一遍 /code-review（正确性）——已完成 @716fc911
- [x] c1 六道核对实证：requireShareTicketByToken 逐道（存在 404 同文案/撤销 403/过期 403/任务行 404/payloadHash 403/策略+作答）；第 6 道经 resolveAttemptQuestionAiPolicy→requireUsableAttempt（归属/作废/失权异常穿透）；正文与附件共用入口；老师中途关闭（aiPolicyOverrides post_submit_only）测试实证 403
- [x] c2 哈希域：share=sha256("ai-share-token:"+t) 查 aiShareTickets；MCP=sha256("ai-mcp-token:"+t)；教师 apiToken=teachers.apiToken 明文列；登录链接 student-service 域——四域互不可兑换；token=randomBytes(32) base64url 43 字符；payloadHash 排除 promptSnapshotMd/capturedAt（rearm 不换票 504 行测试/快照更新失效 470 行测试）
- [x] c3 装配只吃 contextSnapshotJson 冻结快照+firstQuestionOf（任务问题行）；姓名/私注/UUID/绝对路径/blobs 路径哨兵测试全断言不出；escapeHtml 全段+CSP default-src 'none'
- [x] c4 页号 /^(\d+)\.png$/+0≤n<rows.length；rows=本任务材料行（邻题任务附件 404 实证）；路径来自 DB 行经 resolveWithinRoot+64hex 模式；media/blobs 零放宽（diff 仅导出标签/读函数+新增探测）
- [x] c5 no-store/no-referrer/noindex,nofollow/CSP 逐头+HTML meta 双保险；HEAD 不记已读/GET 才 recordShareTicketViewed（viewCount SQL 自增+link_viewed source=unknown，不改任务状态不写回复）；app.ts 两处日志 sanitizePathForLog 实证
- [x] c6 link 分流在 send() 主流程成功段（任务/材料/幂等键同源）；copyFailed 独立；重试复制零 API；重新生成旧任务新票据；换题 bind 清/换账号 effect 清
- [x] c7 降级拉 link.url 自身（同授权同留痕）；成功消息无回信口径（872 行测试）；未完成同拒（752 行测试）
- [x] c8 角标：642 行测试预挂 summary+断言 isInvalidated（非恒真）；本遍修复票据生成失败路径跳过失效
- [x] c9 契约：aiTaskShareRevokeDataSchema 新增+aiTaskShareRequestSchema 既有；实现/测试/api.ts 三方一致；无前后端手写同型（hc 推断不出的手写 fetch 有注释理由）
- [x] c10 抽查断言具体（fetchSpy/withCalledWith/isInvalidated/PNG 逐位 toEqual/uuid 正则嗅探）

### 第一遍确认缺陷（已修 @716fc911）
1. link 票据生成失败 early-return 跳过三处 invalidateQueries（角标/历史滞后）→ 挪到任务创建成功点统一执行
2. 降级 fetch 把 500 归为「链接已失效」误导重新生成 → 403/404 与服务故障分类
3. 重新生成后降级区残留旧票据解析内容 → link.url 变化 effect 复位
4. link 成功后主按钮「复制 AI 链接」点击落空正文拦截覆盖成功提示 → Composer 分流 retryCopyLink
5. share 正文模式标签「完成后复盘」≠需求标准名「完成后可用」且注释虚假同文案 → 统一标准名
6. 降级按钮连击竞态（closure guard）→ ref 守卫

### 第一遍遗留裁决（不修，记录到验收记录）
- linkShare 不持久化（刷新丢链接→重发占配额）：x4 防泄露要求 token 只在 React state 是刻意权衡；建议后续批次在任务历史行加「为此任务生成链接」入口
- 题号实时算 vs 快照冻结（前序题软删→重编号漂移）：低危显示辅助，快照无题号字段，扩契约不值当
- createAiShareTicket 无每任务 active 上限：生成需学生会话+本人任务+策略实时裁决，匿名面不可达，自伤面接受

## 第二遍 /simplify
- [ ] s1 公开读端点装配与 SAI-12 队列/快照服务重复度；路由薄壳真薄
- [ ] s2 前端 link 分支与 inapp/mcp 分支可合并重复；AiLinkShareBox 复用度
- [ ] s3 测试 fixture 重复（public-ai-share 与 student-ai-share 两文件 prepareWorld 样板）

## 第三遍 /security-review
- [ ] x1 匿名面攻击面（token 熵与形态；404 同文案防枚举；viewCount 无限递增裁决；无 CORS 泄露）
- [ ] x2 附件二进制面（content-type 固定 image/png；PNG 逐位相等；缺件明确 404）
- [ ] x3 错误页与日志（无 token/快照/路径；revoked vs expired vs 猜测文案可区分性裁决）
- [ ] x4 前端无 secret 落地（token 只在 React state；撤销后不残留旧链）
- [ ] x5 泄露测试双断言完整（允许断言进正文、禁止哨兵全断言；未改 assertNoLeak 掩盖）

## 基线已知问题（只确认未加重）
- 设置页无限循环已修（v2 02156967）/ webkit 130 题 spec 焦点 / route-integration flake（双证伪）/ 教师 mcp 第三份连接样板 / AI_MATERIAL_STORE_FAILED 含路径低危

## 修复与验证
- [ ] 确认缺陷当场修 + 定向 vitest 复跑；触及公共路径跑 pnpm test 全量
- [ ] 每遍小步提交
