# B11 合并前闸门清单（simplify → code-review → security-review）

范围：v2...codex/student-ai-b11（Head 6312e459），30 文件 +5060/-128。
纪律：确认缺陷当场修（小步提交+定向测试）；简化只做低风险；不确定列遗留。

## 第一遍 simplify（commit 02e6ad18）
- [x] S1 面板/控制器/受限渲染重复：errorMessageOf 错误文案单源（5 处同构三元式收口）、AiReplyMarkdown cn 常量段合并
- [x] S2 AiConversationPanel 与 AiCompanionSession 状态重复：审查无新增重复（面板/控制器职责分界维持 SAI-18/21 既有边界）
- [x] S3 测试 fixture 重复：connectedAiStatus fixture 单源（三测试文件逐字同构工厂去重）；定向 12 文件 92/92
- [x] 跑 check-self.cjs（OK）

## 第二遍 code-review
- [x] C1 SAI-20 遗留①裁决：**当场修**（commit 4cd70be6）——create 路由无任何 active 连接 403 AI_SETUP_REQUIRED（不落任务行不占配额）+ channel=link 409 AI_CHANNEL_UNSUPPORTED（不产僵尸任务）；RED 2 用例实证后 GREEN；39/39 + 242/242
- [x] C2 SAI-20 遗留②：**当场补**（commit df1e0324）——材料上传失败专项（任务已建明示补传/同幂等键重试只补传/成功后清理策略）10/10
- [x] C3 回执 dedup 修复复核：worker.test.ts:1158/1203 追问再派发出站诉求=末条学生消息、首问回信整体入历史（修复即「末条学生消息才成立重放」的实证）；queue.test ①②同批/同反馈重放语义在案；断言基于连接层桩捕获的真实载荷与消息序，非恒真
- [x] C4 追问语义：followup 路由 6 例——快照不重采（contextSnapshotJson 逐字比对不变）、AI_TURNS_MAX 友好 409 AI_TURNS_LIMIT 非崩溃、同文在途幂等（消息计数=3）、跨账号 404 防枚举、模式即时生效零落库、超长 400（本轮补）；并发 lease=queue.test:648 双连接真实文件库仅一有效 lease；replied→created 重排队=worker:1203 + queue:1404（教师恢复→显式继续才回 created，不自动发送）
- [x] C5 面板查询策略：隐藏暂停/恢复零重发=panel.test:443（30s 窗口零新增轮询）；错误退避 30s 时序=df1e0324（退避窗口零出站、期满重试）；opened 调用次数断言 281/298/683；同 key 去重为 TanStack Query 观察者机制（面板未自建第二套 fetch），无需重复测试框架保证
- [x] C6 opened 幂等：df1e0324——失败回滚本地已读标记（收起再展开可重试）不虚报；与 replyDeliveredAt 合判（tasks.test:589 未读 null / 打开后置值）
- [x] C7 门禁语义：tasks.test:591-614 服务端真实支撑——禁用期 detail/list 双关口均不下发回信正文（REPLY_SENTINEL 缺席 + assistant 消息空数组）、hasReply 事实如实、opened 403 AI_POLICY_DISABLED、恢复后交付；面板「已收到回信暂不能查看」分支有据
- [x] C8 测试真实性：4cd70be6 RED 2 用例实证记录在提交信息；本轮新增向量断言均有行为锚（占位文案在场/恰 1 链接/哨兵字符串缺席/DOM 节点计数），无恒真断言
- [x] C9 七项 blocking：答案泄露=X5 双断言；契约=仅 review-pack.ts 格式化（无 schema 变更，无 schema:export 义务）；判分未触；迁移未触（diff 无 drizzle 文件）；DSL 注册表未触；samples 未触；禁项=无新依赖、无 CDN、无 any/@ts-ignore
- [x] 跑 check-self.cjs（OK）

## 第三遍 security-review（XSS 面 + 追问端点）
- [x] X1 绕过面四向量（commit fe8a44d，15/15）：协议变体（大小写/制表符/HTML 实体提协议不在白名单全降级为文字）；KaTeX 危险命令（\href/\includegraphics trust=false 零 anchor/img/src/xlink 属性）；原始 HTML 注入面（svg onload/form/iframe/details ontoggle/input 不进 DOM）；GFM autolink 同清洗（https 成链 noopener、javascript 裸文本不成链）。向量均未绕过（无需改实现）；断言组合非恒真（零链接断言与「安全外链保留成链」互补）
- [x] X2 零图片真实性：双层防线均有断言——层1 源文本替换（占位文案「图片不显示」在场）+ 层2 清洗 schema 剥 img（零 img/srcset/style url() 节点）；本轮补引用式图片向量（![alt][ref] 不匹配层1 正则，层2 兜底实证：无 img 且引用定义 URL 不落 DOM 任何位置）
- [x] X3 三上限绕过：入检对整段 source 解析前统一执行，无逐块路径（分片拼接不绕过）；已有 bytes/nodes/formula_size 三例 + 本轮补 formula_count（80+1 条小公式分片维度）→「公式过多」不进渲染；压缩向量受双层约束（服务端 AI_REPLY_MAX_CHARS=32KB 写回截断 + 客户端 128KB 字节帽），无无界展开输入
- [x] X4 追问端点：他人任务 id 跨账号 404 同文案防枚举；attempt/questionId 不能拼入（contract strict + followup schema 设计注释明示）；question 长度上限=本轮补超长（2001 字）400 AI_TEXT_TOO_LONG 零落库（与既有空白 400 同 zod 路径、too_big 分流有 textLimitCodeOf 单测级实证）；出站注入边界=system 段恒为「模板+硬约束+注入防御句」（题面/学生文本永不拼入 system），诉求与题面以 user 数据段【待分析数据】包裹（context.test:890/910）
- [x] X5 防泄露双断言：允许侧=worker.test:311 出站捕获断言答案/解析/学生问题确实外发（受控出口授权内容）+ context.test:332 快照含 referenceAnswerMd/solutionMd；禁止侧=tasks/status/materials 路由全部学生可读响应过 assertNoLeak + 跨题哨兵BETA/教师私注哨兵TC 缺席断言；apps/server/src/test/assert-no-leak.ts 不在分支 diff（全局禁止键未改）
- [x] 跑 check-self.cjs（OK）

## 收尾
- [x] 验证：lint / typecheck / 全仓 pnpm test（见验收记录 B11 行数字）
- [x] 更新验收记录 B11 行（闸门结论与遗留裁决）
- [x] 删除 b11-gate-checklist.md
- [x] 最终回复 ≤8 行
