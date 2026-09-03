//
//  SpaceLink for macOS
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
        panel.message = "SpaceLink reads and writes the Markdown files in this folder. Nothing is converted or moved."
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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    /// Where the download in flight is being written, so it can be revealed.
    private var lastDownload: URL?
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
            fail("This copy of SpaceLink is incomplete.", "The notes server is missing from the app bundle. Build it again with macos/build.sh.")
            return
        }
        guard let node = NodeBinary.locate(bundledAt: resources?.appendingPathComponent("node")) else {
            fail(
                "Node.js is needed, and could not be found.",
                """
                SpaceLink runs its notes server on Node. Install it from nodejs.org \
                or with `brew install node`, then open SpaceLink again.

                If Node is already installed somewhere unusual, rebuild with \
                `macos/build.sh --embed-node` to put a copy inside the app.
                """
            )
            return
        }

        server.stop()
        window.title = "Starting…"
        // Starting Node can take a moment — longer if macOS asks about access
        // to the folder first — and waiting for it here would freeze the window
        // that has just been shown. Wait on a background queue, come back for
        // the UI.
        let server = self.server
        DispatchQueue.global(qos: .userInitiated).async {
            // The port from last time, so the page keeps its origin — and with
            // it its settings and its vault choice. If something else has that
            // port now, the system picks another and the page starts afresh,
            // which is the lesser evil.
            let wanted = UserDefaults.standard.integer(forKey: "SpaceLinkPort")
            let outcome = Result { () throws -> ServerAddress in
                if wanted > 0, let address = try? server.start(node: node, entry: entry, vault: vault, port: wanted) {
                    return address
                }
                return try server.start(node: node, entry: entry, vault: vault)
            }
            if case .success(let address) = outcome {
                UserDefaults.standard.set(address.port, forKey: "SpaceLinkPort")
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch outcome {
                case .success(let address):
                    VaultChoice.remember(vault)
                    self.window.title = vault.lastPathComponent
                    // The token goes in the fragment, which is never sent to a
                    // server and is cleared from the address by the page itself.
                    // The web app only accepts it because this is a loopback
                    // address.
                    let escaped = address.token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? address.token
                    guard let url = URL(string: "\(address.url)#token=\(escaped)") else {
                        self.fail("Could not open the vault.", "The server reported an address that makes no sense: \(address.url)")
                        return
                    }
                    self.webView.load(URLRequest(url: url))
                case .failure(let error):
                    self.fail("Could not open the vault.", error.localizedDescription)
                }
            }
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
        #if DEBUG
        // ⌘R from Xcode is a Debug build: let Safari's Develop menu inspect the
        // page, or a blank first launch cannot be diagnosed at all.
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        #endif

        window = NSWindow(
            // A plain title bar, with the page starting below it. Full-size
            // content would put the traffic lights and the title over the
            // ribbon and the tab bar, which have no inset for them.
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        // Apple: "Swift and ARC clients need to set this property to false to
        // avoid releasing the window too many times." It is held in a property.
        window.isReleasedWhenClosed = false
        window.title = "SpaceLink"
        window.contentView = webView
        window.minSize = NSSize(width: 720, height: 480)
        // Where it was last time, or the centre the first time. Centring after
        // restoring would undo the restore on every launch.
        if !window.setFrameUsingName("SpaceLinkWindow") {
            window.center()
        }
        window.setFrameAutosaveName("SpaceLinkWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About SpaceLink", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        // ⌥⌘O: the page owns plain ⌘O (the quick switcher), and a web view hands
        // Command chords to the page first once it has focus.
        let openItem = appMenu.addItem(withTitle: "Open Vault…", action: #selector(chooseVault), keyEquivalent: "o")
        openItem.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide SpaceLink", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit SpaceLink", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        // ⌃⌘F, as everywhere else on the Mac; plain ⌘F is "find" wherever the
        // page does not handle it itself.
        let fullScreenItem = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreenItem.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    // MARK: Delegates

    /// A link to anywhere but our own server opens in the browser, not in here.
    ///
    /// A download is not a navigation. "Export vault as JSON" is an `<a download>`
    /// on a `blob:` URL, and a WKWebView told to *allow* that simply navigates
    /// to the blob — nothing is saved, and nothing says so. WebKit flags the
    /// intent on the action; answering `.download` is what turns it into a
    /// `WKDownload`, which then asks the delegate below where to put it.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
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

    /// A response WebKit cannot display — a PDF attachment opened directly, a
    /// zip — is saved rather than shown as a blank page.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// The file picker behind `<input type="file">` — "Import notes from JSON".
    ///
    /// On macOS, file uploads are disabled unless the UI delegate implements
    /// this; without it the import control does nothing and says nothing.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    // MARK: Downloads

    /// Where a download goes: wherever the reader says, defaulting to the name
    /// the page suggested (`My Vault.json`) in their Downloads folder.
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let panel = NSSavePanel()
        panel.title = "Save"
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard panel.runModal() == .OK, let chosen = panel.url else {
            completionHandler(nil)
            return
        }
        // WebKit refuses a destination that already exists rather than
        // overwriting, so honour the panel's "Replace" by clearing it first.
        try? FileManager.default.removeItem(at: chosen)
        lastDownload = chosen
        completionHandler(chosen)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let saved = lastDownload {
            NSWorkspace.shared.activateFileViewerSelecting([saved])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "The file could not be saved."
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        _ = alert.runModal()
    }

    /// A load superseded by a newer one — ⌘R while still loading, choosing a
    /// vault mid-load, a link handed to the browser — is reported as
    /// `URLError.cancelled`. It is not a failure, and the alert below has only
    /// "Choose Another Folder" and "Quit" on it.
    private func isCancellation(_ error: Error) -> Bool {
        (error as? URLError)?.code == .cancelled
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if isCancellation(error) { return }
        fail("SpaceLink could not load.", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if isCancellation(error) { return }
        fail("SpaceLink could not reach its own server.", error.localizedDescription)
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

/// The entry point.
///
/// `@main` rather than statements at the top of the file: Xcode compiles an
/// application target with `-parse-as-library`, and under that flag a
/// top-level expression is an error rather than a program. Verified against a
/// real Swift compiler, which is also why `build.sh` passes the same flag —
/// two build paths that disagree about what a program is would be worse than
/// either being wrong.
@main
enum SpaceLink {
    /// `NSApplication.delegate` does not retain what it is given, so this does.
    private static let delegate = AppDelegate()

    static func main() {
        let application = NSApplication.shared
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
