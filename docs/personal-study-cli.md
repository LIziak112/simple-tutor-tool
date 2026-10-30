# v3 个人学习 CLI（第一阶段，非完整个人模式）
基线：v3 d0e9b76479fca1d6e5e69134cbd5e53ac02489eb。

## 范围
Python 3 标准库，无新增服务端依赖。复用既有鉴权、学生、导入、课程成员接口。
这是过渡性 CLI，不宣称已经移除教师/账号模型。没有修改 v2。
默认预览，只有 --commit 才导入；已有课程的显式发布通过 --publish-course-id 指定。
发布会让课程所有既有成员可见，不适合多人课程中的私密个人资料。
导入和加入成员是两个请求，不是跨接口原子事务；若后者失败，前者可能已提交，必须检查服务端状态，勿盲目重跑。
密码仅终端交互输入，Cookie 仅保存在内存；不保存、打印响应凭据或生成登录链接。
同 Wi-Fi 不等于可信网络。HTTP 密码和会话可能被监听；优先本机回环地址或 HTTPS。
服务器应以 PUBLIC_URL 配置对手机可达的地址，否则生成的学习链接可能仍指向 localhost。

## 使用
从仓库根执行；服务需已启动。首次初始化必须显式 --setup；此命令只能用于尚未设置账号的实例。
普通登录并选择唯一学习者：
    python3 scripts/personal-study.py --base http://127.0.0.1:8787 --login-name owner
无学习者时允许显式创建：
    python3 scripts/personal-study.py --login-name owner --create-self
预览已有讲练 Markdown：
    python3 scripts/personal-study.py --login-name owner --markdown lesson.md
导入并发布到指定既有个人课程：
    python3 scripts/personal-study.py --login-name owner --markdown lesson.md --commit --publish-course-id COURSE_UUID
多人情况下加 --student-id STUDENT_UUID，不自动猜选。
课程必须由当前账号拥有。课程创建、练习链接、作答及错题回看仍使用既有界面或 lecture-practice skill；本 CLI 不替代这些功能。
讲练格式必须遵循仓内 spec 与 .claude/skills/lecture-practice/SKILL.md。
搜索与内容生成应由 agent 使用自己的已授权工具完成，不伪造来源；生成物经既有 DSL 校验后导入。

## 验证
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p test_personal_study.py -v
9项测试覆盖：选择歧义、显式选择、大小限制、origin校验、预览与提交、发布字段、提交失败短路，以及真实本机HTTP Cookie/拒绝重定向。
HTTP测试用合成服务器，不是 Hono/SQLite 服务端端到端验证。未跑 Node/前端/CI。

## 个人首页（第二阶段，尚待前端运行验证）
新增 /personal，调用既有 API 和 useStudentLinkLogin；复用该 hook 的缓存清理和草稿身份隔离。
构建时 VITE_PERSONAL_MODE=true 将根页面切换为个人首页；不设置时保留原入口。
首次仍需设置本机管理账号；不是无账号模式，不绕过服务端所有权。
资料管理页面沿用既有实现，完整模块精简与自动发布闭环仍待开发。
