//
//  Starting and stopping the notes server.
//
//  Split out from the app itself because it imports nothing but Foundation,
//  and that is what makes it testable: `macos/Tests/run.sh` compiles this file
//  on any platform Swift runs on, launches the real `server/index.mjs` against
//  a real folder, and checks what comes back. The AppKit half cannot be
//  exercised that way, so as little as possible lives there.
//

import Foundation

// MARK: - Where Node is

/// Finding the `node` binary, which is the one thing this app cannot supply.
///
/// A GUI app inherits almost nothing from your shell — no `nvm`, no Homebrew on
/// the `PATH` — so the usual places are checked directly. A copy inside the app
/// bundle wins, which is what `build.sh --embed-node` puts there.
enum NodeBinary {
    /// The places a Mac keeps Node, newest version first.
    ///
    /// A GUI app's PATH is /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so
    /// Homebrew, MacPorts and every version manager have to be looked up by
    /// hand. `home` is a parameter so the search can be tested against a fake
    /// one; the app passes the real home directory.
    static func candidates(home: URL) -> [String] {
        var found = [
            "/opt/homebrew/bin/node",     // Homebrew, Apple silicon
            "/usr/local/bin/node",        // Homebrew, Intel — and most installers
            "/usr/bin/node",
            "/opt/local/bin/node",        // MacPorts
            home.appendingPathComponent(".volta/bin/node").path,    // Volta: a native shim, no shell needed
            home.appendingPathComponent(".asdf/shims/node").path,   // asdf
            home.appendingPathComponent(".nodenv/shims/node").path, // nodenv
            home.appendingPathComponent("n/bin/node").path,         // n, with N_PREFIX=~/n
        ]
        // One directory per installed version. Newest first, by number rather
        // than by string: as text, "v9" sorts after "v22".
        for versions in [
            home.appendingPathComponent(".nvm/versions/node"),
            home.appendingPathComponent(".local/share/fnm/node-versions"),
            home.appendingPathComponent("Library/Application Support/fnm/node-versions"),
            home.appendingPathComponent(".asdf/installs/nodejs"),
            home.appendingPathComponent(".nodenv/versions"),
        ] {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: versions.path) else { continue }
            for name in names.sorted(by: newerVersionFirst) {
                let base = versions.appendingPathComponent(name)
                // fnm nests one level deeper than the others.
                found.append(base.appendingPathComponent("installation/bin/node").path)
                found.append(base.appendingPathComponent("bin/node").path)
            }
        }
        return found
    }

    /// `v22.1.0` before `v10.3.0` before `v9.0.0`.
    static func newerVersionFirst(_ a: String, _ b: String) -> Bool {
        let av = numbers(in: a), bv = numbers(in: b)
        for index in 0..<max(av.count, bv.count) {
            let x = index < av.count ? av[index] : 0
            let y = index < bv.count ? bv[index] : 0
            if x != y { return x > y }
        }
        return a > b
    }

    private static func numbers(in name: String) -> [Int] {
        name.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    }

    static func locate(bundledAt bundled: URL?, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL? {
        if let bundled, FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        return candidates(home: home).first { FileManager.default.isExecutableFile(atPath: $0) }.map(URL.init(fileURLWithPath:))
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

/// What the child process has said so far, behind a lock.
///
/// The pipe handlers run on their own queue while `start` waits on this thread,
/// so everything they touch is shared between threads. Gathering it here makes
/// that one small, obvious place instead of four captured locals.
private final class Collected {
    private let lock = NSLock()
    private var out = ""
    private var errors = ""
    private var address: ServerAddress?

    /// Returns true the first time the ready line is recognised.
    func absorbOutput(_ text: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        out += text
        guard address == nil else { return false }
        for line in out.split(separator: "\n") where line.hasPrefix("{") {
            guard let data = String(line).data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(ServerAddress.self, from: data) else { continue }
            address = decoded
            return true
        }
        return false
    }

    func absorbErrors(_ text: String) {
        lock.lock()
        errors += text
        lock.unlock()
    }

    /// What was found, and what to complain about if nothing was.
    func result() -> (ServerAddress?, String) {
        lock.lock()
        defer { lock.unlock() }
        return (address, errors.isEmpty ? out : errors)
    }
}

/// The `node server/index.mjs` child process.
final class SyncServer {
    private var process: Process?
    /// Held open for as long as the server should live. See `start`.
    private var leashes: [Pipe] = []

    /// A token for this launch: 32 random bytes, URL-safe.
    ///
    /// Generated here and handed to the server, so it lives in memory and in
    /// the page the app opened, and nowhere on disk. Without one the server
    /// would create and reuse `~/.spacefore/server.json` — the token of the
    /// sync server a person runs by hand, which this app is not.
    static func freshToken() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Start the server and wait for it to say where it is listening.
    ///
    /// `port` is a request, not a promise: 0 lets the system choose, and the
    /// ready line says what was actually got. The app asks for the port it had
    /// last time, because the web origin — scheme, host *and port* — is what
    /// the page's settings and vault choice are stored under, and a new port
    /// every launch would be a new, empty origin every launch.
    ///
    /// - Throws: if the server exits, or never reports, within `timeout`.
    func start(node: URL, entry: URL, vault: URL, token: String = SyncServer.freshToken(), port: Int = 0, timeout: TimeInterval = 30) throws -> ServerAddress {
        let task = Process()
        task.executableURL = node
        task.arguments = [
            entry.path, "--vault", vault.path, "--port", String(port), "--host", "127.0.0.1",
            "--token", token, "--print-ready",
        ]
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
        //
        // A reference type rather than captured local `var`s, so the sharing is
        // something the compiler can see and reason about — Swift 6's
        // concurrency checking rejects the latter outright.
        let collected = Collected()
        let arrived = DispatchSemaphore(value: 0)

        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            if collected.absorbOutput(String(decoding: chunk, as: UTF8.self)) { arrived.signal() }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            collected.absorbErrors(String(decoding: chunk, as: UTF8.self))
        }
        // A server that dies before reporting must not leave us waiting.
        task.terminationHandler = { _ in arrived.signal() }

        try task.run()
        process = task
        leashes.append(leash)

        _ = arrived.wait(timeout: .now() + timeout)

        let (found, complaint) = collected.result()

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
