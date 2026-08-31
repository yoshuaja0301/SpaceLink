//
//  Exercises SyncServer.swift against the real notes server.
//
//  The app's AppKit half cannot be run anywhere but a Mac, so the half that
//  can be run anywhere is separated out and actually run. This is the code
//  that launches Node, waits for it to say where it is listening, parses that,
//  and shuts it down again — the part where a mistake means the app opens to
//  an error instead of your notes.
//
//  Run it with `macos/Tests/run.sh`. It needs a Swift compiler and Node, and
//  nothing else; it does not need a Mac.
//

import Foundation
#if canImport(FoundationNetworking)
// On Linux, URLSession lives in its own module. On a Mac it is part of
// Foundation, and this import does not exist.
import FoundationNetworking
#endif

// `@main` and a type, not statements at the top of the file: this is compiled
// with `-parse-as-library`, exactly as the app is, and there a top-level
// expression is an error rather than a program.
@main
enum SyncServerTests {

static var failures: [String] = []

static func check(_ passed: Bool, _ what: String) {
    if passed {
        print("  ok    \(what)")
    } else {
        failures.append(what)
        print("  FAIL  \(what)")
    }
}

static func checking(_ what: String, _ body: () throws -> Bool) {
    do {
        check(try body(), what)
    } catch {
        failures.append(what)
        print("  FAIL  \(what)\n          \(error)")
    }
}

/// A box for a value a URLSession callback writes and this thread reads.
/// Captured `var`s across threads are a warning today and an error in Swift 6.
final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    var current: Value {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// GET a URL, with an optional bearer token, and return the status code.
static func statusOf(_ url: URL, token: String? = nil) -> Int {
    var request = URLRequest(url: url)
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let status = Box(0)
    let waited = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, _ in
        status.current = (response as? HTTPURLResponse)?.statusCode ?? 0
        waited.signal()
    }.resume()
    _ = waited.wait(timeout: .now() + 15)
    return status.current
}

static func main() throws {
let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    print("usage: SyncServerTests <path to node> <path to server/index.mjs>")
    exit(2)
}
let node = URL(fileURLWithPath: arguments[1])
let entry = URL(fileURLWithPath: arguments[2])

let vault = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("spacefore-swift-\(UUID().uuidString)")
try? FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
try? "# Beranda\n\nHalo dari Swift. [[Ide]]\n".write(to: vault.appendingPathComponent("Beranda.md"), atomically: true, encoding: .utf8)

print("== SyncServer, against a real notes server ==")

/* ------------------------------------------------------------------ *
 * Finding Node
 * ------------------------------------------------------------------ */

checking("prefers a copy inside the app bundle over anything on the system") {
    NodeBinary.locate(bundledAt: node) == node
}

checking("falls back to the system when the bundle has no copy") {
    // A path that is not there must not be returned just because it was asked
    // for — that would be an app that fails to launch with "file not found".
    let missing = vault.appendingPathComponent("no-node-here")
    let found = NodeBinary.locate(bundledAt: missing)
    return found != missing
}

checking("returns nothing rather than a wrong guess when there is no Node") {
    // Not assertable about the host, but the shape must hold: whatever comes
    // back is executable.
    guard let found = NodeBinary.locate(bundledAt: nil) else { return true }
    return FileManager.default.isExecutableFile(atPath: found.path)
}

/* ------------------------------------------------------------------ *
 * Starting it
 * ------------------------------------------------------------------ */

let server = SyncServer()
var started: ServerAddress?

checking("starts the server and reads back where it is listening") {
    let address = try server.start(node: node, entry: entry, vault: vault)
    started = address
    return address.port > 0 && address.token.count > 20 && address.url == "http://127.0.0.1:\(address.port)/"
}

checking("reports the vault it was actually given") {
    // `URL.path` resolves symlinks differently on different platforms, so
    // compare the last component, which is what identifies the folder.
    started.map { URL(fileURLWithPath: $0.vault).lastPathComponent == vault.lastPathComponent } ?? false
}

checking("the server is genuinely answering at that address") {
    guard let address = started, let url = URL(string: "\(address.url)api/health") else { return false }
    return statusOf(url) == 200
}

checking("the token it reported is the one the server actually wants") {
    guard let address = started, let url = URL(string: "\(address.url)api/files") else { return false }
    // …and that it is needed: the same request without it must be refused.
    return statusOf(url, token: address.token) == 200 && statusOf(url) == 401
}

/* ------------------------------------------------------------------ *
 * Stopping it
 * ------------------------------------------------------------------ */

checking("stopping it releases the port") {
    guard let address = started else { return false }
    server.stop()

    // Give it a moment to go, then confirm nothing answers there any more.
    guard let url = URL(string: "\(address.url)api/health") else { return false }
    for _ in 0..<40 {
        Thread.sleep(forTimeInterval: 0.25)
        if statusOf(url) == 0 { return true }
    }
    return false
}

/* ------------------------------------------------------------------ *
 * Failing
 * ------------------------------------------------------------------ */

checking("says so, rather than hanging, when the server cannot start") {
    let broken = SyncServer()
    let nowhere = vault.appendingPathComponent("not-a-server.mjs")
    let began = Date()
    do {
        _ = try broken.start(node: node, entry: nowhere, vault: vault, timeout: 20)
        return false // it must not claim success
    } catch {
        // The point is that it returns at all, and quickly: a blocking read on
        // a pipe that never fills would make the whole app freeze on launch.
        let took = Date().timeIntervalSince(began)
        let complaint = error.localizedDescription
        print("        took \(String(format: "%.1f", took))s, said: \(complaint.prefix(90))")
        return took < 20 && !complaint.isEmpty
    }
}

checking("says so when Node itself is not where it was told") {
    let broken = SyncServer()
    do {
        _ = try broken.start(node: vault.appendingPathComponent("no-such-node"), entry: entry, vault: vault, timeout: 10)
        return false
    } catch {
        return true
    }
}

try? FileManager.default.removeItem(at: vault)

print("")
if failures.isEmpty {
    print("All SyncServer checks passed.")
    exit(0)
}
print("\(failures.count) check(s) failed.")
exit(1)
}
}
