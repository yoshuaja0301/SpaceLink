# SpaceFore.app

A real Mac application: double-click it, choose the folder your notes live in,
and there they are. No terminal, no browser tab, no `npm` anything after the
first build.

Two ways to build it, which produce the same app:

```bash
open macos/SpaceFore.xcodeproj      # then ⌘R
```

```bash
./macos/build.sh --install          # no Xcode needed, just swiftc
open /Applications/SpaceFore.app
```

Either takes about a minute the first time and produces an 8 MB app. Both call
`copy-resources.sh` to fill the bundle, so neither can quietly drift from the
other — and `pbxproj.test.mjs` fails if one of them tries.

---

## What has been checked, and what has not

This was written in a Linux container with no Mac. That shaped the whole
design: the app is split so that the half which can be tested anywhere is
tested, and the half that needs a Mac is as small as possible.

### `SyncServer.swift` — compiled and run

It imports nothing but Foundation, so a Swift compiler on any platform will
build it. `macos/Tests/run.sh` does exactly that, then launches the real
`server/index.mjs` against a real folder and checks what comes back:

```
  ok    prefers a copy inside the app bundle over anything on the system
  ok    falls back to the system when the bundle has no copy
  ok    returns nothing rather than a wrong guess when there is no Node
  ok    orders versions by number, so v22 beats v9 and v10
  ok    nvm: the newest installed version is the one chosen
  ok    Volta's shim is found, and outranks a version directory as PATH would
  ok    fnm's nested layout is found
  ok    a fresh token is 32 random bytes, URL-safe, and different every time
  ok    starts the server and reads back where it is listening
  ok    reports the vault it was actually given
  ok    the server is genuinely answering at that address
  ok    the token is the one this launch made up, and it never touched the disk
  ok    the token it reported is the one the server actually wants
  ok    stopping it releases the port
  ok    asked for the port it had last time, it gets the same port again
  ok    a port somebody else holds is refused rather than silently swapped
  ok    says so, rather than hanging, when the server cannot start
  ok    says so when Node itself is not where it was told
```

Confirmed to be worth something by breaking it six ways — the wrong
`--print-ready` argument, an impossible port, the stdin leash removed, the
version sort made lexicographic again, `--token` dropped, the requested port
ignored — and watching each one fail.

This is the half where a mistake is expensive: it is what makes the app open
to your notes rather than to an error.

### `SpaceForeApp.swift` — typechecked against the documented API

The AppKit and WebKit half. Nothing off a Mac can resolve `NSOpenPanel` or
`WKWebView`, so it is typechecked against stubs instead — and the stubs were
not written from memory. Every declaration in them was fetched from Apple's own
documentation for that symbol, and each one carries the path it came from:

```swift
/// appkit/nssavepanel/runmodal()
open func runModal() -> NSApplication.ModalResponse { .OK }
```

That makes it a check against an independent description of the API rather than
against itself. A wrong property name, a wrong enum case, a missing argument, a
delegate signature that does not match — none of them compile. Confirmed by
breaking eight of them on purpose:

```
  nama                                                  caught
  ----------------------------------------------------  ------
  canChooseDirectory instead of canChooseDirectories       yes
  .ok instead of .OK                                       yes
  wrong type on a delegate parameter                       yes
  WKWebsiteDataStore.standard() instead of .default()      yes
  makeKeyAndOrderFront() with no argument                  yes
  .fatal instead of .critical on NSAlert.Style             yes
  .titleBar instead of .titled on StyleMask                yes
  NSWorkspace.openURL(_:) instead of open(_:)              yes
```

**What this still cannot tell you.** That a symbol exists at all beyond the ones
declared — anything the app uses has to be in the stub, and that is where a
wrong memory could slip back in, which is why each declaration cites its source.
Nor, of course, whether the window looks right.

### Every API checked against the version the app promises

Typechecking says a symbol exists. It does not say *when* it arrived, and an
API newer than `MACOSX_DEPLOYMENT_TARGET` stops the first ⌘R with "is only
available in macOS 13.3 or newer". Swift would normally catch that itself —
but only when it is compiling for macOS. On Linux `@available(macOS …)` is
inert, which was confirmed rather than assumed: a stub property marked
`@available(macOS 13.3, *)` compiles here with no guard at all.

So the versions are checked separately. A stub declaration newer than the
target carries the version from the page it was copied from:

```swift
/// webkit/wkwebview/isinspectable — macOS 13.3+, default false
@available(macOS 13.3, *)
open var isInspectable: Bool { get { false } set {} }
```

`availability.test.mjs` reads those, finds every use in the app, and insists
each one sits inside an `#available` guard for at least that version. It
refuses a guard shape it cannot place — `guard #available`, whose scope runs to
the end of the block — rather than passing it. Today one API is above the
12.0 target, `isInspectable`, and it is guarded; taking the guard away, or
weakening it to 12.0, fails the check. Every version was read off
developer.apple.com: `WKDownload` and its delegate 11.3, `shouldPerformDownload`
11.3, `runOpenPanelWith` 10.12, `activate(ignoringOtherApps:)` 10.0.

The two checks compose. An API that is too new fails here; one that does not
exist at all — `NSApp.activate()`, macOS 14 — is not in the stub, so the
typecheck fails instead.

Objective-C interop does not exist off Apple's platforms, so `#selector` and
`@objc` are rewritten before the typecheck — and only those; the rest is the
real source. That gap is smaller than it sounds: on a Mac `#selector` is checked
by the compiler, so a wrong one will not build. All ten the app uses point at
methods confirmed to exist (`NSApplication.terminate(_:)`, `NSText.cut(_:)`,
`NSWindow.toggleFullScreen(_:)`, and so on). The two written as strings —
`undo:` and `redo:` — are the standard responder-chain names and are not
checked by anything.

### Three real bugs this found

**The icon.** `copy-resources.sh` fed `iconutil` an `icon_64x64.png`. Apple's
iconset format has five sizes — 16, 32, 128, 256, 512, each with an `@2x` twin —
and no 64. A file iconutil does not recognise is a reason for it to refuse the
set, so the app would have shipped with a blank icon. The one part of the script
that could not run here was the one part nobody had checked; it now runs here,
with `sips` and `iconutil` replaced by two shims that record what they were
asked for, and the set is compared against Apple's list
(`copy-resources.test.mjs`).

**Export did nothing.** "Export vault as JSON" is an `<a download>` on a `blob:`
URL. In a browser that saves a file; in a `WKWebView` it is a *navigation*, and
the app answered "allow" — which navigates to the blob, saves nothing, and says
nothing. WebKit flags the intent on the navigation action; the app now answers
`.download`, takes the resulting `WKDownload`, and asks where to put it with an
`NSSavePanel`. Anything WebKit cannot display — a PDF attachment opened directly
— takes the same path instead of a blank page. All of it is macOS 11.3+ API
(deployment target is 12.0), and every declaration was fetched from Apple's
documentation into the stub, which is how the typecheck confirmed it — a wrong
argument label on the delegate method fails the build here, as it would there.

**The entry point.** The first version had its entry point as statements at the
bottom of the file.
That compiles as a single-file `swiftc` invocation — which is what `build.sh`
did — and fails under `-parse-as-library`, which is what **Xcode** passes for an
application target:

```
error: expressions are not allowed at the top level
```

So `build.sh` would have worked and ⌘R would not have, which is the worst shape
a bug like that can take. The entry point is `@main` now and `build.sh` passes
`-parse-as-library` too, so both paths compile the same thing. Verified against
a real compiler, both before and after.

### What a seven-lens pre-flight found

Before anyone had built it, seven independent reviewers — one each for AppKit,
WebKit, the Xcode project, the process lifecycle, the shell scripts, a
step-by-step first ⌘R, and the web app inside a `WKWebView` — went over
`macos/` against Apple's documentation and, where it mattered, WebKit's source.
Each finding was checked here before it was acted on; every one below is either
reproduced, or confirmed from the documentation it cites.

| would have happened on the Mac | now |
| --- | --- |
| the server never started from a path with a space (`My Apps/`): its "am I the program?" guard compared a percent-encoded URL against the raw path | compares paths; `server.test.mjs` launches it from such a path |
| **Import notes from JSON** did nothing: on macOS file uploads are off unless the UI delegate implements `runOpenPanelWith` | implemented; an `NSOpenPanel` |
| every launch got a new port, so a new web origin, so the page's settings and vault choice were gone each time | the port is remembered and asked for again; only a taken port falls back |
| the token was the one in `~/.spacefore/server.json`, not per-launch as promised | generated in Swift per launch, passed as `--token`, never written |
| ⌘R while loading, or any superseded load, showed the fatal "could not reach its own server" alert | `URLError.cancelled` is not a failure |
| the window was released twice under ARC (masked today, a crash the day anything closes it) | `isReleasedWhenClosed = false` |
| the window's position was never restored: `center()` ran after the autosave name | `setFrameUsingName` first, centre only the first time |
| the traffic lights and the title were drawn over the ribbon and the tab bar | a plain title bar; the page starts below it |
| ⌘O opened the page's quick switcher, ⌘F went full screen outside the editor | ⌥⌘O and ⌃⌘F |
| the window sat empty, then beachballed, for as long as Node took to start — up to 30 s behind a folder-access prompt | the server starts off the main thread |
| a blank first launch could not be inspected | Debug builds are inspectable from Safari's Develop menu |
| Node from Volta, fnm, asdf, nodenv or `n` was "not found", and nvm's oldest version won a text sort | all of them are looked up; versions sort by number |
| the Xcode script phase could not find `npm` from nvm, fnm, Volta or asdf | `node-path.sh`, shared by the script and tested against fake homes |
| `--embed-node` copied Homebrew's node, which needs twenty of Homebrew's dylibs and dies on the Mac it was meant for | `embed-node-check.sh` refuses it and points at the nodejs.org build |

### The rest

| | |
| --- | --- |
| the Xcode project parses, and every reference in it resolves | a plist parser and a reachability walk, in `pbxproj.test.mjs` |
| the project's script phase actually fills the bundle | ran it for real with Xcode's variables faked |
| the bundle layout the app expects | assembled it exactly, `Resources/{dist,server}` |
| the app being served from inside that bundle | fetched `index.html` and its JS out of it |
| opening with the token in the fragment, nobody typing anything | real Chromium, real vault, paired with no picker |
| the token not being left in the address afterwards | asserted on the live URL |
| an edit reaching the folder on disk | read the file back with `fs` |
| the server dying when the app does — **including a crash** | `SIGKILL`ed the parent; server was gone in 2 s, port released |
| the script phase is not sandboxed | `ENABLE_USER_SCRIPT_SANDBOXING = NO`, asserted — it reads the whole repository and writes into the bundle, which a sandboxed phase may not |
| the iconset handed to `iconutil` | exactly Apple's ten names, checked through the real script with shims |
| no API newer than the 12.0 deployment target is used unguarded | `availability.test.mjs`, against versions read off Apple's own pages |
| opening the project does not dirty the repository | `xcuserdata/` and `DerivedData/` ignored, the shared scheme not |

The project file's checks were confirmed by breaking it ten different ways — a
dangling reference, the App Sandbox creeping back in, a renamed source file, the
script phase deleted, the scheme pointing at the wrong target, a deployment
target drifting from `Info.plist`, the executable bit lost, test files left in
the bundle — and confirming each one fails.

Still unverified: that the window looks right, that Xcode is happy with the
project once it opens it, that the real SDK agrees with its own documentation,
that `iconutil` accepts what it is given, and that a download actually lands
where the save panel says.

### Running the Swift checks yourself

```bash
./macos/Tests/run.sh
```

Needs `swiftc` and `node`. It skips rather than fails when Swift is absent, so
it is safe to wire into anything.

---

## What it does

1. Asks which folder holds your notes (`⌥⌘O` to change it later), and remembers.
2. Starts `server/index.mjs` from inside the app bundle, against that folder, on
   a port the system picks, bound to `127.0.0.1`.
3. Opens `http://127.0.0.1:<that port>` in a `WKWebView`, with the access token
   in the URL fragment so nothing has to be typed.
4. Saves a download — an exported vault, a PDF attachment — where you say,
   through the ordinary save panel, and shows it in the Finder.
5. Shuts the server down when you quit.

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

From Xcode, `⌘B` and `⌘R` do the same thing, minus `--embed-node` — for that,
drop a `node` binary into the target's Resources yourself, or use the script.

## What is in here

| | |
| --- | --- |
| `Sources/SpaceForeApp.swift` | the window, the folder picker, the menus — AppKit |
| `Sources/SyncServer.swift` | starting and stopping Node — Foundation only, and tested |
| `Tests/` | compiles and runs SyncServer.swift; typechecks the AppKit half |
| `Tests/Stubs/` | AppKit and WebKit as Apple documents them, for that typecheck |
| `Info.plist` | shared by both build paths |
| `copy-resources.sh` | fills the bundle; the single description of what goes in |
| `node-path.sh` | where a Mac keeps Node, for a build script that starts with no PATH |
| `embed-node-check.sh` | refuses a Node that would not run on another Mac |
| `*.test.mjs` | the checks for the three scripts above, with `sips`, `iconutil` and `otool` as shims |
| `build.sh` | builds without Xcode |
| `SpaceFore.xcodeproj` | builds with it |
| `pbxproj.test.mjs` | checks the project file, since Xcode cannot be run here |
| `availability.test.mjs` | checks no API is newer than the deployment target, since Swift will not off a Mac |
| `copy-resources.test.mjs` | checks the iconset the script builds, since `iconutil` cannot be run here |

---

## Things worth knowing

**It is not sandboxed.** A sandboxed app is not allowed to run Node, and this
one has to. That rules out the App Store, which is the right trade for something
whose whole job is opening a folder on your own machine.

**It is signed ad-hoc**, which is enough to run on the Mac that built it.
Handing the `.app` to someone else needs a Developer ID and notarisation;
without those, macOS will refuse it on their machine.

**The token is per-launch.** It is generated in the app when it starts, handed
to the server as `--token`, lives only in memory and in the page it opened, and
is gone when you quit. It never touches `~/.spacefore/server.json`, which is
for the sync server you run yourself — and a test starts the server with an
empty home directory and checks that no such file appears.

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
