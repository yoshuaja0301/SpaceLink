# Running SpaceFore as a sync server

One machine holds your notes. Every device you own opens that machine's address,
installs the app, and reads and writes the same folder.

There is no account system and no cloud service. The machine that holds the
folder is the whole of it.

```
   iPhone ─┐
  iPad ────┼──▶  your Mac  ──▶  ~/Notes  (ordinary .md files)
  laptop ──┘      port 4899        ▲
                                   └── Time Machine, git, Dropbox — anything
                                       that backs up a folder still works
```

---

## Quick start

On the machine that will hold the notes:

```bash
npm install
npm run build                       # the server serves this build
npm run server -- --vault ~/Notes
```

It prints something like:

```
  SpaceFore sync server
  vault    /Users/you/Notes
  token    /Users/you/.spacefore/server.json

  this Mac       http://localhost:4899/
  (bound to loopback — pass --host 0.0.0.0 to reach it from other devices)

  Connect a device: open the address above, choose "Connect to a server",
  and paste this token:

    9f3c1a…
```

The vault folder is created if it is not there. Point it at a folder you already
have and it will pick up every `.md` file in it — nothing is converted, moved or
rewritten on the way in.

**It binds to loopback by default.** Until you pass `--host`, nothing outside the
machine can reach it. That is deliberate: exposing a folder of your writing to a
network should be a decision, not an accident.

### Try it on a copy first

Before pointing the server at notes you care about, spend five minutes proving
to yourself that it only touches what you touch.

```bash
cp -R ~/Notes ~/Notes-trial                       # work on a copy
cd ~/Notes && find . -type f -exec shasum -a 256 {} \; | sort -k2 > /tmp/before.txt

npm run server -- --vault ~/Notes-trial           # open it, edit a few notes, quit
```

Then check that the folder you care about never moved:

```bash
cd ~/Notes && find . -type f -exec shasum -a 256 {} \; | sort -k2 > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "untouched"
```

And see exactly what the trial run did change:

```bash
diff -rq ~/Notes ~/Notes-trial
```

You should see only the notes you actually edited, plus any you created.
Attachments, `.obsidian`, and anything else in the folder should be absent from
that list.

This was rehearsed against a deliberately awkward vault — folder names with
spaces and an em dash, four levels of nesting, an 800 KB note, CRLF line
endings, binary attachments, an existing `.obsidian` — and it is what turned up
the line-ending bug described below.

### Large vaults

A device opens a vault by fetching every note's text in a single streamed
response, so the number of notes costs bandwidth rather than round trips. Five
thousand notes — about 4 MB of Markdown — arrive in a few seconds over a local
network, and the app counts them onto the splash as they land rather than
freezing until the last one.

Reading them is not the slow part; parsing them is. That work is done in batches
with the main thread handed back between them, so the window stays responsive
throughout.

### Line endings

A vault written on Windows, or shared through git with CRLF, keeps its line
endings. The app normalises to `\n` internally, because that is what the
parser's offsets and the editor assume, and restores the file's own separator on
the way back to disk. Opening a CRLF note and typing one character does not
rewrite every line in the file.

### Other devices on the same Wi-Fi

```bash
npm run server -- --vault ~/Notes --host 0.0.0.0
```

Now the banner also lists the addresses your Mac answers on:

```
  same network   http://192.168.1.20:4899/
```

Open that on the other device, choose **Connect to a server**, paste the address
and the token, and press Connect. macOS may ask you to allow incoming
connections the first time — say yes.

---

## Installing it on a device

Once a device is connected, install the app so it opens like anything else on
the machine:

- **iPhone / iPad** — Safari, Share, *Add to Home Screen*.
- **Android** — Chrome, menu, *Install app*.
- **macOS / Windows / Linux** — Chrome or Edge, the install icon in the address
  bar, or menu → *Cast, save and share* → *Install page as app*.

The installed app remembers which server it is paired with, so it reconnects on
its own. It still needs to reach the server: your notes live there, not on the
device.

### Installing needs `localhost` or HTTPS

Browsers only treat a page as an app — and only run a service worker for it — on
what they call a secure context: `https://`, or `http://localhost`. That is not
a SpaceFore rule, and there is no way around it.

What that means in practice, measured rather than assumed:

| Opened at | Installable | Works offline |
| --- | --- | --- |
| `http://localhost:4899` — the host machine itself | yes | yes |
| `http://192.168.1.20:4899` — another device on the Wi-Fi | **no** | **no** |
| `https://…ts.net` — through Tailscale, below | yes | yes |

The middle row still *works*: the app opens in the browser, reads and writes the
vault, and syncs live. It just stays a page rather than becoming an app, and it
needs the server every time it loads.

So: to install on the machine that holds the notes, use its `localhost` address.
To install on your phone or your laptop, put HTTPS in front of the server first
— which is what the next section is for, and is worth doing anyway.

---

## Reaching it from anywhere

Two ways, both of which give you HTTPS and neither of which requires opening a
port on your router.

> **Do not forward a port from your router to this server.** It would put a
> folder of your writing on the public internet behind nothing but a token, with
> no TLS unless you add it yourself. The two options below are safer and no
> harder.

### Tailscale (recommended)

A private network between your own devices. Nothing is exposed publicly.

```bash
brew install --cask tailscale        # then sign in on every device
npm run server -- --vault ~/Notes --host 0.0.0.0
tailscale serve --bg 4899            # HTTPS, on your tailnet only
tailscale serve status               # prints the https://…ts.net address
```

Connect each device to the `https://…ts.net` address it prints. Only devices
signed into your tailnet can reach it, so the token is a second lock rather than
the only one.

### Cloudflare Tunnel

Use this if a device cannot run Tailscale.

```bash
brew install cloudflared
npm run server -- --vault ~/Notes
cloudflared tunnel --url http://localhost:4899
```

It prints a public `https://…trycloudflare.com` address. **This one is genuinely
public** — anybody with the URL reaches the login-less API and only the token
stops them. Use a named tunnel with Cloudflare Access in front if the notes
matter, and treat the quick tunnel as a temporary measure.

---

## Keeping it running

To have it start with the Mac and come back after a crash, save this as
`~/Library/LaunchAgents/com.spacefore.server.plist` — adjusting both paths — and
run `launchctl load ~/Library/LaunchAgents/com.spacefore.server.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spacefore.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/SpaceFore/server/index.mjs</string>
    <string>--vault</string><string>/Users/you/Notes</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/spacefore.log</string>
  <key>StandardErrorPath</key><string>/tmp/spacefore.log</string>
</dict>
</plist>
```

`which node` gives you the right path for the first string. The Mac still has to
be awake for other devices to sync — check *Energy Saver* if it sleeps.

---

## When two devices edit the same note

Every save carries the version the device thought it was editing. If the note
changed in the meantime — you edited it on your phone on the train, then opened
the laptop that still had the morning's copy — the server refuses the save, and
the device writes its version alongside instead:

```
Ideas/Zettelkasten.md
Ideas/Zettelkasten (conflict 2026-08-30 14-05-11).md
```

Nothing is merged automatically and nothing is thrown away. You open both,
decide, and delete the copy. The app tells you when this happens; it does not
happen silently.

Notes edited on different devices, or the same note edited at different times,
never produce a conflict — only genuinely simultaneous edits to the same note do.

---

## Security, plainly

- **The token is the only lock on the API.** It is 256 bits of random data,
  generated on first run and kept in `~/.spacefore/server.json` with owner-only
  permissions. Treat it like a password.
- **It is stored on each device**, in the browser's local storage, so the device
  can reconnect by itself. A shared or borrowed device should be disconnected
  (switch to another vault) rather than left paired.
- **Only `/api/health` is open**, and it answers nothing but "yes, this is a
  SpaceFore server" — no vault name, no file list.
- **Plain HTTP on a local network is readable by anything else on that network.**
  For a home Wi-Fi that is usually acceptable; on a café or office network it is
  not. Both tunnel options above give you HTTPS.
- **Rotate the token** by deleting `~/.spacefore/server.json` and restarting.
  Every device will need to be paired again, which is exactly what you want if
  one has been lost.
- **Dot-directories and `node_modules` are never served, walked or written to.**
  A `.obsidian` folder in the same vault is left alone.

---

## Backups

The vault is a folder of Markdown files. Time Machine already covers it. So does
`git init` inside it, or any sync service you already use — the server reads the
folder fresh, so a file restored or changed by something else shows up on every
device within moments.

The server itself holds no state worth backing up beyond the token.

---

## If something is wrong

**A device says it cannot reach the server.** Check the server is running, that
it was started with `--host 0.0.0.0` if the device is not the same machine, and
that macOS is not blocking incoming connections (*System Settings → Network →
Firewall*).

**"That token was not accepted."** Copy it again from the server's output. If you
have deleted `~/.spacefore/server.json` at some point, the token changed and
every device needs pairing again.

**Changes are not appearing on the other device.** Each device holds an open
connection for changes. Phones drop it when the screen is off and reconnect on
wake, so give it a moment after unlocking. If it persists, reload the page.

**The app will not load at all.** The server serves the build in `dist/`. Run
`npm run build` and start it again.

---

## The API, briefly

For anything you might want to script against. Every endpoint but `/api/health`
needs `Authorization: Bearer <token>`.

| | |
| --- | --- |
| `GET /api/health` | `{ ok, service }` — open, and says nothing else |
| `GET /api/vault` | the vault's name |
| `GET /api/files` | every file with size, mtime and a SHA-256 of its contents |
| `GET /api/bundle` | every note's text in one streamed response, as newline-delimited JSON. This is what a device uses to open the vault — one request rather than one per note |
| `GET /api/file?path=…` | the file; `ETag` is its hash |
| `PUT /api/file?path=…` | write it. `If-Match: "<hash>"` makes it conditional; `If-Match: *` means create-only. A mismatch is `409` with the current hash |
| `DELETE /api/file?path=…` | remove it |
| `POST /api/rename` | `{ from, to }` |
| `GET /api/events` | server-sent events as the vault changes. Takes `?token=` because `EventSource` cannot send headers |

Writes are atomic: the file is written beside the target and moved into place, so
an interrupted save leaves the previous version whole rather than a truncated
file.

Content hashes are remembered against each file's size and mtime, so listing a
vault does not re-read every byte of it. A file whose size and mtime both match
what was seen last time keeps its hash; anything else is read again.
