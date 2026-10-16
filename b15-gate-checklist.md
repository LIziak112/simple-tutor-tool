# B15 质量闸门清单（codex/student-ai-b15 @ 10a36a55，diff v2...HEAD）

## 第一遍 /code-review（正确性）
- [ ] c1 票据六道实时核对逐道实证（存在/撤销/过期/快照身份/当前策略/作答可访问；正文与附件读取都走；老师中途关闭旧链接 403 重查 aiPolicyOverrides）
- [ ] c2 高熵 token 哈希域隔离（share/apiToken/登录链接/ai-mcp-token 四域互不可兑换）；payloadHash 只算实质快照段，rearm 不换票 vs refresh 旧票失效
- [ ] c3 正文授权边界（装配只吃票据快照；姓名/内部 ID/UUID/绝对路径/教师私注不进装配；HTML 转义/CSP 无注入面）
- [ ] c4 附件路径（页号形态校验+穿越/替换 ID/错页号 404；只读本票据任务材料页；media/blobs 零放宽）
- [ ] c5 缓存与留痕（no-store/no-referrer/noindex/CSP 逐头；HEAD 不记已读、GET 记 link_viewed(source=unknown)；viewCount 递增不计求助；日志脱敏）
- [ ] c6 前端 link 通道走同任务/材料/幂等主流程；copyFailed 独立事实；重试复制零 API；重新生成旧任务新票据；换题换账号清空
- [ ] c7 降级面拉票据自身 URL（同授权同留痕）；成功文案无回信口径；未完成同拒
- [ ] c8 B14 角标修复（send 成功失效 studentAiQueueSummaryKey 且幂等；组件测试真断言角标）
- [ ] c9 契约先行（student-ai-api.ts 新 schema 与实现/测试三方一致）
- [ ] c10 测试真实性抽查（AiLinkShareBox/use-ai-send-controller/public-ai-share 挑关键断言）

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
