//
//  SpaceFore for macOS
//
//  A window around the app you already have.
//
//  Everything that does real work — reading and writing your notes, watching
//  the folder, the editor, the graph — is the sync server and the web app in
//  the rest of this repository, both of which are covered by the test suites
//  there. This file is deliberately the thinnest shell that will hold them:
//
//    1. ask which folder holds your notes, and remember it,
//    2. start `server/index.mjs` against it on a port the system picks,
//    3. show `http://127.0.0.1:<that port>` in a web view, handing the token
//       over in the fragment so nobody has to type it,
//    4. stop the server when the window closes.
//
//  It is not sandboxed. A sandboxed app may not run Node, and this one has to.
//  That also means no App Store, which is the right trade for something that
//  exists to open a folder on your own machine.
//

import AppKit
import WebKit

// MARK: - Where Node is

/// Finding the `node` binary, which is the one thing this app cannot supply.
///
/// A GUI app inherits almost nothing from your shell — no `nvm`, no Homebrew on
/// the `PATH` — so the usual places are checked directly. A copy inside the app
/// bundle wins, which is what `build.sh --embed-node` puts there.
enum NodeBinary {
    static func locate(bundledAt bundled: URL?) -> URL? {
        if let bundled, FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        var candidates = [
            "/opt/homebrew/bin/node",     // Homebrew, Apple silicon
            "/usr/local/bin/node",        // Homebrew, Intel — and most installers
            "/usr/bin/node",
            "/opt/local/bin/node",        // MacPorts
        ]
        // Whatever `nvm` currently has, without running a shell to ask.
        let home = FileManager.default.homeDirectoryForCurrentUser
        let versions = home.appendingPathComponent(".nvm/versions/node")
        if let found = try? FileManager.default.contentsOfDirectory(atPath: versions.path) {
            for version in found.sorted().reversed() {
                candidates.append(versions.appendingPathComponent("\(version)/bin/node").path)
            }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }.map(URL.init(fileURLWithPath:))
    }
}

// MARK: - The server

/// What the server prints on its ready line, which is the only thing this app
/// reads from it. See `--print-ready` in `server/config.mjs`.
struct ServerAddress: Decodable {
    let url: String
    let port: Int
    let token: String
    let vault: String
}

/// The `node server/index.mjs` child process.
final class SyncServer {
    private var process: Process?
    /// Held open for as long as the server should live. See `start`.
    private var leashes: [Pipe] = []

    /// Start the server and wait for it to say where it is listening.
    ///
    /// - Throws: if the server exits, or never reports, within `timeout`.
    func start(node: URL, entry: URL, vault: URL, timeout: TimeInterval = 30) throws -> ServerAddress {
        let task = Process()
        task.executableURL = node
        task.arguments = [entry.path, "--vault", vault.path, "--port", "0", "--host", "127.0.0.1", "--print-ready"]
        // The server resolves `dist/` relative to its own file, so where we are
        // does not matter; set it anyway so any path it prints makes sense.
        task.currentDirectoryURL = entry.deletingLastPathComponent().deletingLastPathComponent()

        let output = Pipe()
        let errors = Pipe()
        // The leash: the server exits when this closes, which it does when this
        // process dies however it dies. Without it a crash here would leave a
        // server behind, holding a port and watching a folder for nobody.
        let leash = Pipe()
        task.standardOutput = output
        task.standardError = errors
        task.standardInput = leash

        // Collected on the pipes' own queue, never by blocking this thread:
        // `availableData` waits for ever, which would make the timeout below a
        // lie and freeze the app whenever the server failed to start.
        let lock = NSLock()
        var stdoutText = ""
        var stderrText = ""
        var address: ServerAddress?
        let arrived = DispatchSemaphore(value: 0)

        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            lock.lock()
            defer { lock.unlock() }
            stdoutText += String(decoding: chunk, as: UTF8.self)
            guard address == nil else { return }
            for line in stdoutText.split(separator: "\n") where line.hasPrefix("{") {
                guard let data = line.data(using: .utf8),
                      let decoded = try? JSONDecoder().decode(ServerAddress.self, from: data) else { continue }
                address = decoded
                arrived.signal()
                return
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            lock.lock()
            stderrText += String(decoding: chunk, as: UTF8.self)
            lock.unlock()
        }
        // A server that dies before reporting must not leave us waiting.
        task.terminationHandler = { _ in arrived.signal() }

        try task.run()
        process = task
        leashes.append(leash)

        _ = arrived.wait(timeout: .now() + timeout)

        lock.lock()
        let found = address
        let complaint = stderrText.isEmpty ? stdoutText : stderrText
        lock.unlock()

        if let found {
            // The handlers stay installed: a pipe nobody drains fills up, and a
            // full pipe stops the server dead the next time it logs anything.
            return found
        }

        stop()
        throw ServerError.didNotStart(complaint.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func stop() {
        process?.terminationHandler = nil
        process?.terminate()
        process = nil
        // Dropping our end of stdin is what tells a server we somehow failed to
        // signal that it is finished.
        for leash in leashes { try? leash.fileHandleForWriting.close() }
        leashes.removeAll()
    }

    enum ServerError: LocalizedError {
        case didNotStart(String)

        var errorDescription: String? {
            switch self {
            case .didNotStart(let detail):
                return detail.isEmpty ? "The notes server did not start." : "The notes server did not start.\n\n\(detail)"
            }
        }
    }
}

// MARK: - Which folder

/// The notes folder, remembered between launches.
enum VaultChoice {
    private static let key = "vaultPath"

    static var remembered: URL? {
        guard let path = UserDefaults.standard.string(forKey: key) else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }
        return URL(fileURLWithPath: path)
    }

    static func remember(_ url: URL) {
        UserDefaults.standard.set(url.path, forKey: key)
    }

    /// Ask, with the standard folder picker.
    static func ask() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Choose your notes folder"
        panel.message = "SpaceFore reads and writes the Markdown files in this folder. Nothing is converted or moved."
        panel.prompt = "Use This Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        return panel.runModal() == .OK ? panel.url : nil
    }
}

// MARK: - The window

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let server = SyncServer()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        openVault(VaultChoice.remembered ?? VaultChoice.ask())
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    // MARK: Opening

    private func openVault(_ chosen: URL?) {
        guard let vault = chosen else {
            NSApp.terminate(nil)
            return
        }

        let resources = Bundle.main.resourceURL
        guard let entry = resources?.appendingPathComponent("server/index.mjs"),
              FileManager.default.fileExists(atPath: entry.path) else {
            fail("This copy of SpaceFore is incomplete.", "The notes server is missing from the app bundle. Build it again with macos/build.sh.")
            return
        }
        guard let node = NodeBinary.locate(bundledAt: resources?.appendingPathComponent("node")) else {
            fail(
                "Node.js is needed, and could not be found.",
                """
                SpaceFore runs its notes server on Node. Install it from nodejs.org \
                or with `brew install node`, then open SpaceFore again.

                If Node is already installed somewhere unusual, rebuild with \
                `macos/build.sh --embed-node` to put a copy inside the app.
                """
            )
            return
        }

        do {
            server.stop()
            let address = try server.start(node: node, entry: entry, vault: vault)
            VaultChoice.remember(vault)
            window.title = vault.lastPathComponent

            // The token goes in the fragment, which is never sent to a server
            // and is cleared from the address by the page itself. The web app
            // only accepts it because this is a loopback address.
            let escaped = address.token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? address.token
            guard let url = URL(string: "\(address.url)#token=\(escaped)") else {
                fail("Could not open the vault.", "The server reported an address that makes no sense: \(address.url)")
                return
            }
            webView.load(URLRequest(url: url))
        } catch {
            fail("Could not open the vault.", error.localizedDescription)
        }
    }

    @objc private func chooseVault() {
        if let picked = VaultChoice.ask() { openVault(picked) }
    }

    // MARK: Chrome

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        // A single shared store, so localStorage and IndexedDB — where the app
        // keeps its settings and which vault it is on — survive a relaunch.
        configuration.websiteDataStore = .default()

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 840), configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "SpaceFore"
        window.titlebarAppearsTransparent = true
        window.contentView = webView
        window.setFrameAutosaveName("SpaceForeWindow")
        window.minSize = NSSize(width: 720, height: 480)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About SpaceFore", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Open Vault…", action: #selector(chooseVault), keyEquivalent: "o")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide SpaceFore", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit SpaceFore", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Without this the standard editing shortcuts do nothing in a web view.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    // MARK: Delegates

    /// A link to anywhere but our own server opens in the browser, not in here.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let isOurs = url.host == "127.0.0.1" || url.host == "localhost"
        if isOurs || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("SpaceFore could not load.", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("SpaceFore could not reach its own server.", error.localizedDescription)
    }

    // MARK: Saying what went wrong

    private func fail(_ message: String, _ detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: "Choose Another Folder")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            chooseVault()
        } else {
            NSApp.terminate(nil)
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
