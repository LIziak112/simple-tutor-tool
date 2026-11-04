# iPad 真机调试

本项目已在当前 Windows 电脑配置免费的开源工具 [ios-safari-remote-debug-kit](https://github.com/HimbeersaftLP/ios-safari-remote-debug-kit)，可通过 USB 检查真实 iPad 的 Safari 页面。后续排查触摸、滚动、布局和手写问题时，可以直接使用现有安装，无需安装 Inspect 或消耗其免费额度。

## 项目内位置

完整工具位于仓库根目录 `.tools/ios-safari-remote-debug-kit/`，包含检查器、USB 代理、许可证及本机启动和停止脚本。`.tools/` 已加入 Git 忽略，第三方源码、二进制、日志和进程记录只保留在本机，不随 Git 克隆分发。

原安装仍保留在 `%LOCALAPPDATA%\CodexTools\ios-safari-remote-debug-kit`；日常使用优先从本项目启动。两个位置使用同一组端口，不能同时运行。

## 连接和启动

1. 用支持数据传输的 USB 线连接 iPad，解锁并信任此电脑。
2. 电脑已安装 Apple Devices；先确认它能识别 iPad。
3. iPad 在“设置 → Safari → 高级”开启“网页检查器”。新系统可能位于“设置 → App → Safari”。
4. 在 iPad Safari 中打开待排查页面，保持前台和解锁。
5. 在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\.tools\ios-safari-remote-debug-kit\start-local.ps1"
```

也可以双击工具目录中的 `启动调试.cmd`，然后打开 `打开检查器.url`。

检查器直达地址：

```text
http://127.0.0.1:8080/Main.html?ws=127.0.0.1:9222/devtools/page/1
```

脚本仅在本次 PowerShell 进程中设置执行策略，不修改系统执行策略，不注册开机启动。重复启动会复用同一路径的现有进程。

## 读取和验证

- `http://127.0.0.1:9221/json`：当前设备列表。
- `http://127.0.0.1:9222/json`：第一台设备的可调试网页列表。页面编号或设备端口变化时，以返回的 `webSocketDebuggerUrl` 为准，调整检查器地址中的 `ws` 参数。
- 图形界面可查看 Elements、计算样式和 Console 等面板。代理使用 WebKit 调试协议，不能将它当作完整的 Chromium CDP 接口。
- 自动读取可使用 Node.js 内置 `WebSocket` 连接网页调试地址，通过 `Target.targetCreated` 获取目标，再用 `Target.sendMessageToTarget` 转发 `Runtime.evaluate`；结果从 `Target.dispatchMessageFromTarget` 接收。
- 同一网页只连接一个检查器；自动读取前先关闭图形检查器，完成后关闭 WebSocket。
- 优先读取布局尺寸、滚动容器和事件等必要信息；不要把学生专属链接、会话令牌、题目答案、完整页面快照或个人数据提交到仓库。

## 停止

结束后关闭检查器，再在项目根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\.tools\ios-safari-remote-debug-kit\stop-local.ps1"
```

也可以双击 `停止调试.cmd`。上游 USB 代理监听全部网络接口的 9221/9222 等端口，按需启动、用完停止；检查器静态服务只监听 `127.0.0.1:8080`。

## 已验证的配置与限制

2026-11-04 已通过 USB 连接 iPadOS 17.7.2，发现 OwnClass 页面，并实际读取页面标题、加载状态、视口、触摸能力、DOM 和计算样式。图形检查器可正常显示。尚未验证全部面板与断线重连，连接成功不代表答题卡滚动问题已修复。

- 工具版本：`5c44158446ecafbbeff1cfd6d06ad27ff1a37cc5`。
- USB 代理：上游官方 Windows 包 `ios-webkit-debug-proxy 1.9.1`。该版本没有新版列表页需要的跨域响应头，因此使用检查器直达地址。
- WebKit 检查器使用 iOS 17.4 协议文件，已在当前 iPadOS 17.7.2 实测；系统升级后需要重新验证协议兼容性。
- 本机启动脚本复用现有 Python 3.12，路径为 `C:\Users\HUAYU\AppData\Local\Programs\Python\Python312\python.exe`。换电脑需按上游说明安装工具，并更新本机脚本中的 Python 路径。

这套工具服务于人工真机排查，不修改应用代码，也不替代项目的单元测试、E2E 或实际触摸验收。
