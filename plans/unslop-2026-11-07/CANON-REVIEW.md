# 56 条适用规则逐项复核

固定版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。全部为 judgement；没有将本地旧检测器同名 ID 当作已绑定机器检测。

每条均给出适用性判断、范围与证据；scoped-no-finding 只表示受测范围没有确认问题，不代表全站/所有状态通过。not-verified 和 provenance-unknown 保留为未知，不能算通过。实现候选的独立审阅是后续门禁。

| 规则 | 主题 / 强度 / 类别 | 结论 | 依据与证据 |
| --- | --- | --- | --- |
| UR-1 | process / hard / slop | process-satisfied | 本轮只写获准的计划与证据，没有增加生产UI元素；既有设计只依文档可追溯部分判断。<br>README.md |
| US-001 | process / hard / slop | project-override | 保留明确约定的蓝/靛蓝主题、彩色课程类型图标、题量/进度tabular-nums及AI助教名称。<br>docs/约定/界面与账号.md；docs/archive/已落地专项/学生答题页桌面布局与界面迭代计划.md:30 |
| US-002 | process / soft / instruction | process-satisfied | 只提出计划；布局与按压手感存在真实取舍，分别标记REQUIRES-APPROVAL；不据touches-DS额外阻断审查。<br>007、014 |
| US-003 | process / hard / slop | implementation-gate | 现状问题均有截图/运行证据；未实施候选修订，独立评审候选UI及各支持主题是实施后的门禁，本轮不宣称已完成。<br>evidence/；只支持浅色见apps/web/src/index.css |
| US-004 | process / hard / slop | finding | 五组模态绕过现有Dialog；状态映射重复；busy尺寸、弹层动画和AI入口图标应在共享源修复。<br>001、002、008、009、013 |
| US-005 | process / soft / instruction | process-satisfied | DS变化仅记录TOUCHES-DS；未决定的手机布局/按压风格才标记审批。<br>各计划首段 |
| US-006 | process / soft / instruction | process-satisfied | 没有改变全局skill、他项目视觉或用户工具配置；图形与颜色范围限定于OwnClass。<br>README.md |
| US-007 | process / hard / slop | process-satisfied | 保留初审与本轮来源；明确mock、历史截图、实测、源码枚举和未验证项，不把代理渲染称生产验收。<br>canon-status.json、各probe JSON |
| US-008 | process / hard / slop | process-satisfied | 无应用源码diff；计划保护草稿、提交、公布、载荷、坐标、布局与项目确认项。<br>git diff -- apps/web/src apps/server/src packages |
| US-010 | process / hard / slop | implementation-gate | 已枚举同类实际位置；没有执行全产品删除请求。实施时必须复测所有列出的消费者。<br>002、011、012、013 |
| C-11 | interface / soft / bad-tone | not-applicable | 中文工作界面，无全大写display页面；没有把品牌OwnClass和AI/MCP缩写当成大小写问题。<br>pages/及index.css检索 |
| DEC-1 | interface / hard / slop | finding | 待公布摘要内多层容器去框实验后，原有标题/网格/间距仍能承载层次。<br>UI-16；nested-frames-before.png / nested-frames-preview.png |
| DEC-2 | interface / hard / slop | finding | 同一待公布摘要簇存在重复边框；已按规则先临时去框，再检查分组与例外。<br>UI-16；canon-layout-probes.json |
| DEC-3 | interface / hard / slop | finding | 倒计时和只读凭证的内层卡并非可拖/整卡可点对象；外层真实提交状态保留。<br>UI-16；015 |
| DEC-4 | interface / hard / slop | finding | 倒计时静态内层卡shadow-xs并不表达浮层；不把正常Dialog/Sheet阴影列为问题。<br>UI-16；PendingReleaseBanner.tsx:65 |
| DEC-6 | interface / hard / slop | finding | 次级状态字在实际背景上约4.48:1；同计划修复白字状态徽标的2.71:1。尚未认证全站对比度。<br>UI-03；browser-probes.json |
| DEC-7 | interface / hard / slop | scoped-no-finding | 导出五步为真实过程，账号/课程来源为真实元信息；受测屏幕没有无意义营销眉题。<br>HomePage、ExportWizard、125状态样本 |
| DEC-8 | interface / hard / slop | project-override | 学生彩色类型图标与卡片有明确界面专题依据；身份入口为真实等价选项，不按特征三格模板误报。<br>docs/约定/界面与账号.md:63；HomePage.tsx |
| DEC-9 | interface / hard / slop | scoped-no-finding | 受测页面没有渐变文字、暗底彩色glow或紫蓝营销hero；学生蓝色横幅沿用项目既有主题，不借此重做品牌。<br>StudentHomePage.tsx:91；index.css |
| J-12 | interface / hard / slop | finding | 更多问法summary使用flex且无可见marker/SVG，开合两态均无指示。其他受测设置summary有Chevron。<br>UI-11；canon-interaction-probes.json |
| KR-1 | interface / hard / slop | scoped-no-finding | 受测分段导航外层12/内层8/padding4为同心模式；输入和同一表面的summary不当作独立套卡。未做全站每个角的几何认证。<br>StudentLayout.tsx；设置与题卡截图 |
| KR-10 | interface / hard / slop | owner-choice | 现有1px按压是反馈而非缺失；与canon精确0.96偏好不一致，保留/改变由用户选择。<br>UI-15；014；press-style |
| KR-11 | interface / hard / slop | scoped-no-finding | 受测界面主要使用Lucide描边族，未见无来源的混合填充图标；未声称对所有字体/尺寸精确测量笔画。<br>brand.tsx；teacher/student导航与截图 |
| KR-13 | interface / hard / slop | finding | 抽屉enter中途Esc改为exit时重置起点；22.4ms跳动约304px，需共享源改可中断transition。<br>UI-10；canon-interaction-probes.json |
| KR-15 | interface / hard / slop | scoped-no-finding | 受测首屏无整页/列表进场表演；条件挂载的Dialog/Sheet是交互触发，不是页面入口动画。<br>125状态及components/ui |
| KR-16 | interface / hard / slop | scoped-no-finding | 颜色反馈约150ms，Dialog200ms，Sheet300/500ms，非所有动作同一时长；Sheet连续性问题单列KR-13。<br>button.tsx、dialog.tsx、sheet.tsx |
| KR-18 | interface / hard / slop | scoped-no-finding | 未发现html全局scroll-behavior:smooth。脚本滚动在材料/题组内使用JS；嵌入viewer停滚故障未实际复现，不能断言完整覆盖。<br>QuestionMaterialsAnchor.tsx:111；QuestionGroupAnchor.tsx:106 |
| KR-19 | interface / hard / slop | finding | 普通登录名标签和倒计时使用font-mono；保留真正代码/配置/编辑器等技术角色。<br>UI-12；login-name-monospace.png；011 |
| KR-21 | interface / hard / slop | scoped-no-finding | 受测有hover的记录卡是Link，文件夹行为是Button，报告行为是Button；未发现已确认的假点击高亮。<br>records-views.tsx:108；FolderSidebar.tsx；StudentReportsSection.tsx |
| KR-3 | interface / hard / slop | finding | 在pointer:coarse的真实浏览器仿真复核逐项checkbox仍20×20且labels=0；其他关联大label不误报。<br>UI-02；canon-layout-probes.json |
| KR-3d | interface / soft / slop | scoped-no-finding | 桌面关键动作多为44px；窄姓名/筛选按项目更严格44px约定处理，不把菜单15px以上一概报错。<br>UI-02；003 |
| KR-4 | interface / hard / slop | scoped-no-finding | 对已查看的图标按钮和头像未确认明显视觉偏心；没有把缺少text-box-trim单独等同实际偏移。<br>作答、导航、记录及设置截图 |
| KR-5 | interface / hard / slop | scoped-no-finding | 菜单/弹窗实际有shadow；正常输入与选中状态保留边界。静态重复框问题归到同一UI-16，不重复计数。<br>components/ui/dialog.tsx、sheet.tsx、dropdown-menu.tsx |
| KR-7 | interface / hard / slop | scoped-no-finding | 受测标题未人为br或窄max-width强迫断句；未设置pretty不是已观察到断句缺陷的充分证据。单元统计拥挤仍作为项目附加发现。<br>UI-08；006；标题/正文源码检索 |
| KR-8 | interface / soft / slop | scoped-no-finding | 未检出对root/body全局设定统一font-smoothing。<br>apps/web/src/index.css与生产源码搜索 |
| KR-9 | interface / hard / slop | scoped-no-finding | 未检出强制给所有内容图片的outline；RichMarkdown图片是max-width/圆角，画布和题面边框不等同内容图像描边。<br>index.css .rich-markdown img |
| NR-02 | interface / hard / slop | scoped-no-finding | 设置和目录chevron使用rotate，未检出同形箭头坐标morph；不要求普通图标替换引入动画库。<br>AiReplyMarkdown、KeyboardBindingsSection、StudentSettingsPage |
| ST-1 | interface / hard / slop | scoped-no-finding | 已查看UI图标可追溯Lucide；数学图像与手写笔迹不是界面图标。没有仅凭内联SVG就报错。<br>UI-13/14修复继续复用Lucide |
| ST-11 | interface / hard / slop | finding | 庆祝和锁emoji用于状态标题/提示，三处生产位置已枚举；用户正文emoji不在范围。<br>UI-13；pending-release-emoji.png；012 |
| ST-13 | interface / hard / slop | provenance-unknown | 品牌名与Brand组件已有专题/验收来源；未独立确认帽子图形的最终品牌批准链，不据缺少外部logo文件直接删图标。<br>components/brand.tsx；2026-10-12-OwnClass教师端改版验收.md:21 |
| ST-2 | interface / hard / slop | finding | AI提问/复盘/出题/报告/导出用同一Sparkles泛指AI；保留需求明确命名，仅提议用途图标。<br>UI-14；AiCompanionRail.tsx:75；013 |
| ST-3 | interface / hard / slop | scoped-no-finding | 受测主要卡片间距8/12/16px；nav内4px等为明确分段组件内部间距，不作near-touch。未全站两两距离穷举。<br>StudentLayout；LibraryPage；实际截图 |
| ST-4 | interface / hard / slop | finding | 保存按钮pending时新增Loader导致98→120px、左移22px；原标签没变。<br>UI-09；canon-ui-probes.json；008 |
| ST-5 | interface / soft / slop | not-applicable | 中文界面无Title Case问题；OwnClass为定稿品牌，AI/MCP/API为专有缩写。<br>AGENTS.md；lib/brand.ts |
| TY-1 | interface / hard / slop | project-override | 题数、进度与结果统计等宽数字有已落地专题/验收依据，依US-001保留；不能在新计划中反向破坏。<br>学生做题记录与结果回看精进实施计划.md:36；结果回看页三处界面修正计划.md:13 |
| XP-18 | interface / hard / slop | scoped-no-finding | 蓝色问候横幅为白字，彩色状态为同色深字；浅冷调页面底色不当成饱和accent fill。对比度问题独立记录。<br>StudentHomePage.tsx；source-badge.tsx；UI-03 |
| XP-31 | interface / hard / slop | scoped-no-finding | RichMarkdown正文ul/ol设list-disc/list-decimal；导航与选项控件列表有独立组件语义，不强行补bullet。<br>index.css .rich-markdown ul/ol |
| DEC-5 | copy / soft / bad-tone | scoped-no-finding | 受测指标来自demo数据和真实聚合API；没有营销证言/客户logo或凭空增长统计。demo来源在报告中注明。<br>seed-demo.ts；InsightsOverviewPage；DEC-5不把演示夹具当生产证明 |
| KR-20 | copy / hard / slop | scoped-no-finding | 时间通过formatCnTime/formatDueTime显示；MCP/JSON配置本为供复制技术文本，不误译成自然语言。<br>lib/time.ts；CopyBlock.tsx；ConnectPage.tsx |
| LK-01 | copy / soft / bad-tone | scoped-no-finding | 作业截止与答案倒计时来自dueAt，非虚构紧迫感；未把真实截止提醒列为诱导。<br>student-ui.tsx dueUrgencyOf；use-due-countdown.ts |
| US-009 | copy / hard / slop | scoped-no-finding | 审查/验收日期写在plans，生产源码内任务号主要为注释；管理规模时间是业务时间说明，不是agent来源脚注。<br>AdminOverviewPage.tsx:100；生产TSX检索 |
| XP-22a | copy / hard / slop | not-applicable | 当前项目工作界面无竞品营销对比页；导出v2数据包是技术兼容信息，非竞品优劣宣传。<br>App.tsx路由与ExportWizard |
| XP-22b | copy / soft / bad-tone | not-applicable | 受测页面与生产文案未发现竞品优劣主张。<br>pages/、components/生产文案搜索 |
| XP-23 | copy / hard / slop | not-applicable | 没有建设推广/竞品对比页；保留用户定稿OwnClass定位与广告词。<br>AGENTS.md、brand.ts、HomePage.tsx |
| XP-33 | copy / hard / slop | scoped-no-finding | 空态与未连接说明为真实可操作状态；模板源码/提示词是教师主动查看的技术内容。未确认卡死的loading。<br>连接AI空态、导出空态、设置与AI面板 |
| XP-34 | copy / hard / slop | not-verified | 源码检查dev专用路由与debug开关有门控；未连接生产站逐屏比对，不声称stage/production完全一致。<br>App.tsx devRoutes、main.tsx、vite.config.ts |

原始 rule 的 source、license、credits/attribution 原样保留在 `evidence/canon/{topic}.json`，没有把本项目判断写回规则。完整机器可读复核在 `evidence/canon-rule-review.json`。
