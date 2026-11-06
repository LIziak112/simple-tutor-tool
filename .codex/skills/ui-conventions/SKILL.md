---
name: ui-conventions
description: simple-tutor-tool 前端 UI 实现约定。凡写 React 页面/组件、用 shadcn/ui、写中文界面文案、适配 iPad 横竖屏、做触控目标、处理加载/空/错误状态时使用。核心要求：触控目标不小于 44px、三种状态齐全、禁 CDN、性能按需加载。
---

# 前端 UI 约定

适用于所有前端任务。技术底座：React 19 + Tailwind CSS v4 + shadcn/ui + lucide-react，状态用 TanStack Query（服务端）/ Zustand（本地）。

## 组件

- 优先用 shadcn/ui（Radix 底层、可访问性好、源码落在仓库里可改）。shadcn 没有的再手写，手写组件同样要过的标准：键盘可用、焦点可见、aria 属性齐全。
- 图标只用 lucide-react，不引入第二个图标库。
- 拖拽排序用 dnd-kit。
- Markdown 渲染统一走 `<RichMarkdown>`（带 rehype-sanitize），不要自己拼 `dangerouslySetInnerHTML`。

## iPad 适配（学生端主要在 iPad Safari 上用）

- **触控目标不小于 44×44px**（按钮、选项、复选框、输入框，含 padding 算）。这是硬性尺寸，鼠标舒服但手指点不准的控件不合格。
- 布局在横屏/竖屏都要正常：以 `sm:`/`md:` 断点覆盖 768×1024（竖）与 1024×768（横），答题页、讲义页是重点检查对象。
- 滚动容器内避免嵌套横向滚动；长列表虚拟化或分页。
- 手写相关区域的触摸处理见 ink-ipad skill。

## 文案

- UI 文案用中文，面向老师和中小学生，语气平实（"保存中…"而不是"持久化请求处理中"）；按钮动词开头（"导入""交卷""复制链接"）。
- 标识符（变量、函数、文件）用英文。代码注释用中文。
- 错误提示要能指导下一步："链接已失效，请联系老师重新发送"，不是"error 403"。
- 时间显示 Asia/Shanghai（dayjs），相对时间优先（"3 分钟前"）。

## 三种状态必须齐全

任何展示数据的视图都要实现并测试：

1. **加载中**：骨架屏或 spinner，不许白屏。
2. **空态**：解释性文案 + 下一步动作（如"还没有作业。去布置一份 →"）。
3. **错误态**：错误原因 + 重试按钮。TanStack Query 的 `isPending`/`isError` 都要接住，不允许只写成功分支。

## 资源与性能

- **禁 CDN**：所有 JS/CSS/字体（含 KaTeX 字体、Excalidraw 资源）随构建打包本地提供。
- 首屏（学生端）可交互 < 3 秒：路由级代码分割；KaTeX、ECharts、CodeMirror、Excalidraw 一律按需动态 `import()`。
- PWA 只有 `PUBLIC_URL` 为 https 时才注册 Service Worker，HTTP 环境下功能必须完整。
