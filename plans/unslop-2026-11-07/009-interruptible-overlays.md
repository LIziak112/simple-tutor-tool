# 009 弹层动画从当前位置反向，并遵守减少动画偏好

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。`TOUCHES-DS`：SheetContent、DropdownMenuContent 的共享动效；无 `REQUIRES-APPROVAL`。

UI-10；P2；canon `KR-13`（hard / slop / judgement，source UNSLOP），修复位置依 `US-004`。减少动画项同时依据已有项目验收约定，不假称 KR-13 直接规定该媒体查询。版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`；原文见 `evidence/canon/interface.json`。

## 问题与目标

`apps/web/src/components/ui/sheet.tsx:48` 同时使用 `motion-safe:transition` 和 open/closed 的 enter/exit keyframes，打开 500ms、关闭 300ms。500ms 打开途中 Esc，实测 **22.4ms 内 x≈−306.31→−2.31px**，随后再向左退出，发生起点重置。不是单凭“用了 keyframes”报错。

`components/ui/dropdown-menu.tsx:25` 的 `data-[state=open]:animate-in`、zoom 没有 motion-safe；reduce 下实测 animation=enter、200ms、scale≈0.955。证据 `canon-interaction-probes.json`、`drawer-opening.png`、`drawer-closing.png`、`menu-reduced-motion-verified.png`。

## 实施步骤

1. 先补失败浏览器检查：开启后 50–100ms Esc，逐帧记录 transform；反向第一帧不能跳到完全展开位置。正常闭合仍完成卸载、恢复焦点和解除滚动锁；连续打开/关闭不能留下透明遮罩。
2. Sheet 改为持有目标 transform/opacity 的 CSS transition，左侧 closed 为 translateX(-100%)、右侧为 +100%、open 为 0；正常偏好时 transform 与 opacity 统一 **180ms / cubic-bezier(0.2,0,0,1)**，让反向从实际进度接续。移除同一属性竞争的 enter/exit/slide keyframes。
3. Radix 关闭后的 Presence 生命周期必须保留：若不能在当前结构下等待 transition，使用该项目允许的 React 状态做最小的呈现生命周期，transitionend 后才释放挂载；不要只删 keyframes 让抽屉立即消失。关闭时的 aria、焦点归还与 body 滚动锁以完整测试验收，不写到一半交付。
4. DropdownMenu 取消非必要缩放，采用 **120ms opacity transition**；不改变定位、菜单项焦点和键盘导航。reduce 下所有位移、缩放和 opacity 动画设为 0ms，静态状态继续清晰。
5. Dialog 原有基座不在此次改动范围；读取其实现作为焦点和媒体查询参考。无需新增动效依赖。

## 验证

真实消费者：师生/管理导航、资源库文件夹菜单、课程添加/编辑抽屉、AI 独立面板。分别看 390/768/1440、左右侧、开关中途 Esc、再次打开、reduce。菜单减弱动画后的缩放必须为 1，抽屉反向过程坐标连续。现有手写场景仍先落盘再允许关闭，不改任何材料控制器。不能用构建通过代替这组帧证据；未覆盖消费者应列为未验证。
