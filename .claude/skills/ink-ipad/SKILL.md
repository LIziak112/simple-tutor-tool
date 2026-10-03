---
name: ink-ipad
description: simple-tutor-tool 的 iPad 手写（Apple Pencil）实现要点与坑位清单。凡涉及手写答题、笔迹、画布、InkSurface、Atrament/Excalidraw、笔迹上传/回放、触屏滚动冲突、草稿防丢时使用（T2.7、T2.8、T2.9、T3.3）。核心约束：必须真机验收，不能只以模拟器为准。
---

# iPad 手写要点

完整设计见架构文档 §5.4 与 §7.1 清单，这里是实现时最容易踩的坑。

## 选型与架构（先懂再写）

- 绘制用现成库：**Excalidraw**（全屏作答）+ **Atrament**（页内小答题区），自己只写适配层和 iPad 专项处理，不写绘制算法。
- 一切消费方（答题页、草稿、上传、老师查看、回放）只依赖 `InkSurface` 接口（mount/getDoc/exportPng/undo/redo/clear/onChange/destroy），不直接 import 库。
- Excalidraw 默认从 CDN 加载资源，必须设 `window.EXCALIDRAW_ASSET_PATH` 指向本站静态目录（项目禁 CDN），且只在打开全屏作答时动态 `import()`。

## 输入层坑位

1. **笔的识别**：Pointer Events，`pointerType === 'pen'` 即 Apple Pencil，读 `pressure` 做压感。
2. **高频采样**：支持时用 `getCoalescedEvents()` 取全部采样点（笔迹顺滑），`getPredictedEvents()` 画预测段降延迟；不支持时静默回退，不要报错。
3. **"笔写字、手指滚动"（iPad 上最重要的体验）**：Canvas 上 `touchstart` 监听必须 `passive: false`；`touch.touchType === 'stylus'` 才 `preventDefault()` 进入书写，手指触摸不拦截、页面照常原生滚动。学生不应需要在"书写/滚动模式"间切换。无笔设备回退为：手指/鼠标直接写 + 工具栏滚动模式开关。
4. **防系统手势**：画布区域 CSS `-webkit-user-select:none; -webkit-touch-callout:none`，拦截 `selectstart`/`contextmenu`（否则长按弹放大镜和菜单）；页面级 `touch-action: manipulation` 防双击缩放。
5. **悬停**：`pointermove` 且 `buttons === 0` 时显示笔尖预览圈，不落墨。

## 绘制与数据层坑位

- 双层 Canvas：底层缓存已完成笔画，顶层只画当前一笔，结束合入——长答题区不卡。
- `devicePixelRatio` 缩放**上限 2**，控制内存。
- 矢量坐标**归一化到逻辑宽度 1000**：横竖屏旋转、换设备才能无损重绘。`load(getData())` 必须往返一致（有单测）。
- 橡皮用**整笔橡皮**（碰到删整笔，可撤销），撤销栈必须能撤销擦除。
- 草稿防丢：每笔结束写 IndexedDB（idb-keyval）；每 10 秒及 `visibilitychange` 增量同步服务端。刷新、锁屏、Safari 被杀都要能恢复。
- 上传：`CompressionStream('gzip')` 压缩后 multipart，单题 ≤ 2 MB（超限 413）。
- DPR 与归一化换算出错是最常见 bug：提交前在真机横竖屏各写一页对比。

## 验收（硬性）

在**真实 iPad + Apple Pencil** 上按架构文档 §7.1 的 12 项清单逐项通过，模拟器通过不算数。调试用 `?debug=1` 加载的 Eruda 页内控制台（没有 Mac，无法远程调试 iPad Safari）。
