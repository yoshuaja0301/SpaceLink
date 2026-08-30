# SpaceFore.app

A real Mac application: double-click it, choose the folder your notes live in,
and there they are. No terminal, no browser tab, no `npm` anything after the
first build.

```bash
./macos/build.sh --install
open /Applications/SpaceFore.app
```

That takes about a minute the first time and produces an 8 MB app.

---

## Please read this before you build it

**The Swift in this folder has never been compiled.** It was written in a Linux
container with no Swift toolchain, no AppKit, no WebKit and no Mac — so the
first time it is compiled will be on your machine, and it may well not compile
on the first try.

That is why the app is built the way it is. Everything that could quietly do the
wrong thing to your notes lives in code that *is* tested — the sync server and
the web app in the rest of this repository, covered by 1,300 unit tests and ten
end-to-end suites. This folder is only a window and a launcher.

What was verified, on Linux, before writing any of it:

| | |
| --- | --- |
| the bundle layout the app expects | assembled it exactly, `Resources/{dist,server}` |
| the server starting on a system-chosen port and reporting back | real child process, real `--print-ready` line |
| the app being served from inside that bundle | fetched `index.html` and its JS out of it |
| opening with the token in the fragment, nobody typing anything | real Chromium, real vault, paired with no picker |
| the token not being left in the address afterwards | asserted on the live URL |
| an edit reaching the folder on disk | read the file back with `fs` |
| the server dying when the app does — **including a crash** | `SIGKILL`ed the parent; server was gone in 2 s, port released |

What was **not** verified, and cannot be from here: that `swiftc` accepts the
file, that the AppKit calls are spelled correctly, that the window looks right,
and that `iconutil` produces a usable icon. Those are the things to expect
trouble from. If the compiler complains, the complaint is almost certainly
right — the shape of the program is sound, the API spellings are from memory.

---

## What it does

1. Asks which folder holds your notes (`⌘O` to change it later), and remembers.
2. Starts `server/index.mjs` from inside the app bundle, against that folder, on
   a port the system picks, bound to `127.0.0.1`.
3. Opens `http://127.0.0.1:<that port>` in a `WKWebView`, with the access token
   in the URL fragment so nothing has to be typed.
4. Shuts the server down when you quit.

Your notes stay ordinary Markdown files in the folder you chose. The app reads
and writes them and nothing else — no library, no database, no copy.

### Why `localhost` and not a file:// page

Browsers only grant a page storage, a service worker and the rest of the modern
web on what they call a secure context, and `http://localhost` is one while
`file://` is not. Serving from loopback also means the app is the *same* app
your phone reaches over the network, running the same code, rather than a second
implementation that could drift.

---

## Requirements

- **Xcode or the Command Line Tools**, for `swiftc`. `xcode-select --install`
  is enough; the full Xcode is not needed.
- **Node.js**, which the app runs. It looks in the usual places — Homebrew on
  either architecture, `/usr/bin`, MacPorts, and whatever `nvm` currently has —
  because a GUI app inherits none of your shell's `PATH`.

  To make an app that works on a Mac with no Node at all, build it with
  `--embed-node`, which copies your `node` binary into the bundle. That adds
  about 110 MB.

---

## Options

```bash
./macos/build.sh                 # build into macos/build/SpaceFore.app
./macos/build.sh --embed-node    # ...with Node inside, so it stands alone
./macos/build.sh --install       # ...and move it to /Applications
```

---

## Things worth knowing

**It is not sandboxed.** A sandboxed app is not allowed to run Node, and this
one has to. That rules out the App Store, which is the right trade for something
whose whole job is opening a folder on your own machine.

**It is signed ad-hoc**, which is enough to run on the Mac that built it.
Handing the `.app` to someone else needs a Developer ID and notarisation;
without those, macOS will refuse it on their machine.

**The token is per-launch.** It is generated when the app starts, lives only in
memory and in the page it opened, and is gone when you quit. It never touches
`~/.spacefore/server.json`, which is for the sync server you run yourself.

**Other devices are a separate thing.** This app serves loopback only, so
nothing else can reach it. To read the same notes from a phone, run the sync
server the ordinary way — see [../docs/SERVER.md](../docs/SERVER.md).

---

## iOS

Not possible in this shape. An iOS app may not spawn a process, so there is no
Node to run and no server to talk to. The realistic paths are to reimplement the
server's API natively in Swift, or to have the iOS app connect to a Mac that is
already running one — which is what the sync server is for, and works today
through Safari.
