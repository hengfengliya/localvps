// localvps 的 Mac App：菜单栏图标 + 控制台窗口 + 开机自启。
// 服务本身还是同一个 localvps 程序（放在 App 的 Resources 里），App 只负责拉起它、显示它的控制台。
// 已经有一个 localvps 在跑（比如终端里启动的），App 直接连上它，不再另起。
import AppKit
import ServiceManagement
import WebKit

let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory())
let configDir = home.appendingPathComponent(".localvps")

/// 读 ~/.localvps/.env 里的一个键
func envValue(_ key: String) -> String? {
    guard let text = try? String(contentsOf: configDir.appendingPathComponent(".env"), encoding: .utf8) else { return nil }
    for line in text.split(whereSeparator: \.isNewline) {
        let parts = line.split(separator: "=", maxSplits: 1)
        if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == key {
            return parts[1].trimmingCharacters(in: .whitespaces)
        }
    }
    return nil
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var statusItem: NSStatusItem!
    var server: Process?
    var restarts: [Date] = []
    var quitting = false
    var window: NSWindow?
    var state: [String: Any] = [:]
    var reachable = false
    let panelURL = URL(string: "http://127.0.0.1:\(envValue("PANEL_PORT") ?? "18788")")!

    func applicationDidFinishLaunching(_ note: Notification) {
        // 已经开着一个就把它叫到前面
        let mine = Bundle.main.bundleIdentifier ?? ""
        if NSRunningApplication.runningApplications(withBundleIdentifier: mine).count > 1 {
            NSRunningApplication.runningApplications(withBundleIdentifier: mine).first { $0 != .current }?.activate()
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        NSApp.mainMenu = editMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "server.rack", accessibilityDescription: "localvps")
        statusItem.button?.image?.isTemplate = true
        rebuildMenu()

        let loginLaunch = NSAppleEventManager.shared().currentAppleEvent?
            .paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        Task {
            if await !self.poll() { self.startServer() }
            // 开机自启时安静地待在菜单栏；手动打开时直接显示控制台
            if !loginLaunch { self.showWindow() }
        }
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in Task { await self.tick() } }
    }

    // 没有主菜单的话，控制台里的输入框按 ⌘V 粘贴不了
    func editMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu()
        appItem.submenu?.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appItem.submenu?.addItem(withTitle: "退出 localvps", action: #selector(quit), keyEquivalent: "q")
        main.addItem(appItem)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "编辑")
        edit.submenu?.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.submenu?.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(edit)
        return main
    }

    // MARK: 服务进程

    func startServer() {
        #if arch(arm64)
        let name = "localvps-arm64"
        #else
        let name = "localvps-x64"
        #endif
        guard let exe = Bundle.main.url(forResource: name, withExtension: nil) else { return }
        let p = Process()
        p.executableURL = exe
        var env = ProcessInfo.processInfo.environment
        env["LOCALVPS_APP"] = "1"
        env["LOCALVPS_OPEN_PANEL"] = "false"
        p.environment = env
        p.currentDirectoryURL = home
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        let log = configDir.appendingPathComponent("app.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile()
            p.standardOutput = h
            p.standardError = h
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.serverExited() }
        }
        do {
            try p.run()
            server = p
        } catch {
            alert("localvps 没能启动", error.localizedDescription)
        }
    }

    // 意外退出就重启；一分钟内退了 3 次就不再硬拉，免得死循环
    func serverExited() {
        server = nil
        if quitting { return }
        restarts = restarts.filter { $0.timeIntervalSinceNow > -60 } + [Date()]
        if restarts.count > 3 {
            alert("localvps 反复退出", "看一下 ~/.localvps/error.log 和 app.log。菜单栏里点「重新启动服务」再试。")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { Task { if await !self.poll() { self.startServer() } } }
    }

    @objc func restartServer() {
        restarts = []
        if let s = server {
            s.terminationHandler = nil
            s.terminate()
            s.waitUntilExit()
            server = nil
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.startServer() }
    }

    // MARK: 状态

    @discardableResult
    func poll() async -> Bool {
        var req = URLRequest(url: panelURL.appendingPathComponent("api/state"))
        req.timeoutInterval = 2
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            await MainActor.run { reachable = false; render() }
            return false
        }
        await MainActor.run { state = obj; reachable = true; render() }
        return true
    }

    func tick() async {
        await poll()
    }

    var statusText: String {
        if !reachable { return server == nil ? "服务没在运行" : "正在启动…" }
        switch state["status"] as? String {
        case "online": return "运行中"
        case "connecting": return "隧道连接中"
        case "paused": return "已暂停"
        case "error": return "隧道没连上"
        case "local": return "仅本机"
        default: return "—"
        }
    }

    func render() {
        let ok = reachable && (state["status"] as? String) == "online"
        statusItem.button?.appearsDisabled = !ok
        statusItem.button?.toolTip = "localvps · \(statusText)"
        rebuildMenu()
    }

    func rebuildMenu() {
        let m = NSMenu()
        let head = NSMenuItem(title: "localvps · \(statusText)", action: nil, keyEquivalent: "")
        head.isEnabled = false
        m.addItem(head)
        if let url = state["mcpUrl"] as? String, !url.isEmpty {
            let u = NSMenuItem(title: url.replacingOccurrences(of: "https://", with: ""), action: nil, keyEquivalent: "")
            u.isEnabled = false
            m.addItem(u)
        }
        m.addItem(.separator())
        m.addItem(item("打开控制台", #selector(showWindow), "o"))
        if reachable {
            m.addItem(item("复制 MCP 地址", #selector(copyURL)))
            m.addItem(item("复制访问令牌", #selector(copyToken)))
            m.addItem(item("复制 Claude Code 接入命令", #selector(copyCommand)))
        }
        m.addItem(.separator())
        let login = item("开机自动启动", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        m.addItem(login)
        if server != nil || !reachable { m.addItem(item("重新启动服务", #selector(restartServer))) }
        m.addItem(.separator())
        m.addItem(item("退出 localvps", #selector(quit), "q"))
        statusItem.menu = m
    }

    func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    func copy(_ s: String?) {
        guard let s, !s.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
    @objc func copyURL() { copy(state["mcpUrl"] as? String) }
    @objc func copyToken() { copy(state["token"] as? String) }
    @objc func copyCommand() {
        guard let url = state["mcpUrl"] as? String, let token = state["token"] as? String, !url.isEmpty else { return }
        copy("claude mcp add --transport http localvps \(url) --header \"Authorization: Bearer \(token)\"")
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            alert("没能设置开机启动", "把 localvps 拖进「应用程序」文件夹后再试。\n\(error.localizedDescription)")
        }
        rebuildMenu()
    }

    @objc func quit() {
        quitting = true
        if let s = server {
            s.terminate()
            s.waitUntilExit()
        }
        NSApp.terminate(nil)
    }

    // MARK: 控制台窗口

    @objc func showWindow() {
        if window == nil {
            let config = WKWebViewConfiguration()
            // 控制台的「复制」按钮用 navigator.clipboard，WKWebView 里不一定放行，改走原生剪贴板
            let shim = "navigator.clipboard.writeText = function (t) { window.webkit.messageHandlers.copy.postMessage(String(t)); return Promise.resolve(); };"
            config.userContentController.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            config.userContentController.add(self, name: "copy")
            let web = WKWebView(frame: .zero, configuration: config)
            web.navigationDelegate = self
            web.uiDelegate = self
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "localvps"
            w.contentView = web
            w.minSize = NSSize(width: 640, height: 480)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("localvps.panel")
            if !w.setFrameUsingName("localvps.panel") { w.center() }
            window = w
            web.load(URLRequest(url: panelURL))
        } else if let web = window?.contentView as? WKWebView, web.url == nil || !reachable {
            web.load(URLRequest(url: panelURL))
        }
        // 窗口开着时在程序坞和 ⌘Tab 里出现，关掉后回到只在菜单栏
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "copy" { copy(message.body as? String) }
    }

    // 控制台里的外部链接（发布页、文档）用默认浏览器打开
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != panelURL.host || url.port != panelURL.port {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // 服务还没起来时页面加载失败，过两秒再试
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { webView.load(URLRequest(url: self.panelURL)) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
    }

    func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// 被 kill 时也先关掉服务进程，别留下没人管的 localvps
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { delegate.quit() }
sigterm.resume()
app.run()
