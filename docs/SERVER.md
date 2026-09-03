# Running SpaceLink as a sync server

One machine holds your notes. Every device you own opens that machine's address,
installs the app, and reads and writes the same folder.

There is no cloud service. The machine that holds the folder is the whole of it
— and you make the accounts on it yourself, with a command, because a sign-up
page on a machine in your house is a door nobody asked for.

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
  SpaceLink sync server
  vault    /Users/you/Notes
  token    /Users/you/.spacelink/server.json

  this Mac       http://localhost:4899/
  (bound to loopback — pass --host 0.0.0.0 to reach it from other devices)

  Connect a device: open the address above, choose "Connect to a server",
  and paste this token:

    9f3c1a…
```

That token is one way in. An account — an email and a password that work from
every device you own — is the other, and is what
[Accounts](#accounts-one-login-every-device) below is for.

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

Open that on the other device, choose **Connect to a server**, enter the
address, and either sign in with an account or paste the token. macOS may ask
you to allow incoming connections the first time — say yes.

---

## Accounts: one login, every device

Pasting a 43-character token into a phone once is tolerable. Doing it on every
device, and again whenever the token is rotated, is not. An account is an email
and a password that reach the same notes from anywhere:

```bash
npm run server -- --vault ~/Notes --add-account you@example.com
```

It asks for the password twice, without echoing it, and says:

```
  Made an account for you@example.com
    notes  /Users/you/Notes

  Sign in from any device with that email and password.
```

Then start the server as usual — accounts need no flag to switch on:

```bash
npm run server -- --vault ~/Notes --host 0.0.0.0
```

On each device, open the server's address, choose **Connect to a server**, leave
it on **Sign in**, and enter that email and password. The Mac, the Windows
laptop and the iPhone end up looking at the same folder, live.

Each device gets its own session, good for 30 days. **Sign out** in the same
form ends that one on the server — not merely in that browser, which is what a
laptop being handed back needs. `--set-password` on the host ends every session
at once.

### Accounts are made here and nowhere else

**There is no sign-up endpoint.** Not a hidden one, not one behind a flag — the
HTTP API has no way to create an account at all, and a test asserts that several
plausible spellings of one are refused and change nothing. The only way an
account comes to exist is somebody typing the command above on the machine that
holds the notes.

That is the point rather than an omission. This server is likely sitting on a
home network with your writing on it, and the smallest attack surface is no
surface.

### The commands

| | |
| --- | --- |
| `--add-account <email>` | make one; it gets `--vault` as its folder of notes |
| `--set-password <email>` | change a password — every device signed in on that account is signed out |
| `--list-accounts` | who exists, where their notes are, and which devices are signed in |
| `--password <value>` | give the password instead of being asked, for a script. It lands in your shell history |
| `--accounts <file>` | where accounts live (default `~/.spacelink/accounts.json`) |

`--add-account` insists on `--vault` rather than defaulting it: a default would
write whichever folder you happened to be standing in into the account record,
permanently. It also refuses an address carrying control characters or spaces —
this listing is what you read to see who has access, and an address holding a
newline prints a second `notes` line under its own entry, while one holding a
terminal escape rewrites the line it is on. The command that answers "who can
reach my notes?" must not be something an address can lie to. Device labels,
which the device itself chooses, are stripped the same way.

```
$ npm run server -- --list-accounts

  Accounts in /Users/you/.spacelink/accounts.json

    you@example.com
      notes  /Users/you/Notes
      signed in  a Mac — 2026-09-01
      signed in  an iPhone or iPad — 2026-09-02
```

A device in that list you no longer recognise is a reason to run
`--set-password`, which ends every session at once.

### Several people, several vaults

Each account names its own folder, so one server can hold more than one person's
notes without them meeting:

```bash
npm run server -- --vault ~/Notes  --add-account you@example.com
npm run server -- --vault ~/Shared --add-account them@example.com
npm run server -- --vault ~/Notes --host 0.0.0.0
```

Two accounts may also name the *same* folder, which is how two people share one
set of notes. A folder is opened once however many accounts reach it, so it is
watched once and a save is announced once, to everyone reading it — named with
who made it rather than noticed anonymously by the filesystem a moment later.

Signed in as accounts with *different* folders, the other's notes are not
listed, cannot be opened by name, and — the part that is easy to get wrong —
its live change feed never reaches you. The server keeps one change stream per folder rather than one for
the whole process, and a test signs two accounts in at once to prove that a
write by one is not announced to the other.

### What is stored, and what is not

`~/.spacelink/accounts.json` is written owner-only (`0600`) and holds:

- the email, and the folder that account's notes live in;
- the password as a salted **scrypt** hash — 32 MiB of memory per attempt, which
  is what makes a stolen file expensive to guess against rather than merely
  encoded. The cost is stored per record, so raising it later does not lock
  anyone out;
- each session as the **SHA-256 of the token the device holds**, never the token
  itself.

So that file in a backup, or over your shoulder in a screenshot, is not a way
in: neither the password nor any device's session appears in it, and a test
reads the file back after signing in to check.

Every change to it is made under a lock, and that is not belt-and-braces. A
change is a read, an edit and a write, and two of those overlapping keeps only
one — which is exactly what happens when several devices sign in at the same
moment, and when `--add-account` is run while the server is up. Measured before
it was fixed: six simultaneous sign-ins left three sessions, and one terminal
command signed every device out. The lock covers other processes too, since the
command is one.

Repeated wrong passwords are slowed down — five free attempts, then a doubling
wait up to fifteen minutes — because a password, unlike 256 bits of random data,
is guessable. A correct password clears the run at once, so mistyping yours is a
pause and not a lockout.

Two things about that counter are worth stating, because both were wrong once
and each was measured rather than reasoned about:

- **An attempt is counted when it starts, not when it fails.** Checking the
  count and *then* spending 90 ms on a hash before recording anything is a race:
  twenty sign-ins sent at the same moment all read the same count and all get
  through. Measured, that was exactly what happened — twenty guesses, nothing
  slowed. Counting first makes sending them at once count against the sender.
- **It counts the caller as well as the address being guessed at.** Every
  attempt names its own email, so a caller who never repeats one would never be
  counted — while each miss still costs that deliberate 90 ms and 32 MiB. Two
  hundred sign-ins for two hundred made-up addresses used to sail through; now
  the caller's own address is counted too, with a wider budget so a household
  behind one tunnel is not locked out by one person's typo.

The counter is bounded, for the same reason: the key is text from the request,
and a map that grew whenever an anonymous caller invented a new address would be
somewhere to put things. Runs nobody is still making are dropped.

A refusal takes the same ~90 ms whether or not the address has an account: the
miss is hashed against a decoy record rather than answered immediately. Wording
two refusals identically while one of them returns ninety times faster is an
oracle with extra steps, and a test times both to keep it closed.

### The token still works

Accounts were added beside the access token, not in front of it. A server
started without an account behaves exactly as it always did, the macOS app still
pairs itself with `--token` at launch, and a device already paired keeps working
across the upgrade.

The two fail differently, and the app says which: a token was rotated and has to
be copied again; a sign-in expired, or was ended from another device, and needs
the password.

---

## Installing it on a device

Once a device is connected, install the app so it opens like anything else on
the machine:

- **iPhone / iPad** — Safari, Share, *Add to Home Screen*.
- **Android** — Chrome, menu, *Install app*.
- **macOS / Windows / Linux** — Chrome or Edge, the install icon in the address
  bar, or menu → *Cast, save and share* → *Install page as app*.

The installed app remembers which server it is paired with — and, if you signed
in, which account — so it reconnects on its own without asking for the password
again. It still needs to reach the server: your notes live there, not on the
device.

### On the Mac that holds the notes, there is an app

`./macos/build.sh --install` builds `SpaceLink.app`, which starts a server like
this one against a folder you pick and shows it in its own window. It serves
loopback only, so it is for that machine alone — the server described here is
still what your other devices connect to. See [../macos/README.md](../macos/README.md).

### Installing needs `localhost` or HTTPS

Browsers only treat a page as an app — and only run a service worker for it — on
what they call a secure context: `https://`, or `http://localhost`. That is not
a SpaceLink rule, and there is no way around it.

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
`~/Library/LaunchAgents/com.spacelink.server.plist` — adjusting both paths — and
run `launchctl load ~/Library/LaunchAgents/com.spacelink.server.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spacelink.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/SpaceLink/server/index.mjs</string>
    <string>--vault</string><string>/Users/you/Notes</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/spacelink.log</string>
  <key>StandardErrorPath</key><string>/tmp/spacelink.log</string>
</dict>
</plist>
```

`which node` gives you the right path for the first string. The Mac still has to
be awake for other devices to sync — check *Energy Saver* if it sleeps.

On a Linux host, a `systemd` user service with the same command line does the
same job. Linux has no folder watch that covers subfolders, so the server watches
each folder of the vault on its own; a vault with tens of thousands of folders
can run past the kernel's default allowance, in which case the server says so on
stderr and `sysctl fs.inotify.max_user_watches=524288` raises it.

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

- **Two credentials open the API, and nothing else does.** The access token is
  256 bits of random data, generated on first run and kept in
  `~/.spacelink/server.json` with owner-only permissions. An account's password
  is checked against a salted scrypt hash and exchanged for a per-device session
  that expires after 30 days. Treat both like passwords.
- **Whichever it is, it is stored on the device**, in the browser's local
  storage, so the device can reconnect by itself. The password itself is never
  stored — only the session it was exchanged for. A shared or borrowed device
  should be signed out (**Connect to a server → Sign out**), which ends the
  session on the server rather than only forgetting it locally.
- **An account reaches its own folder and no other.** Not in the listing, not by
  path, and not through the change feed.
- **Only `/api/health` and `/api/auth/login` are open**, and health answers
  nothing but "yes, this is a SpaceLink server" — no vault name, no file list.
  A refused login says the same thing whether or not the address has an account,
  and takes the same time to say it: an address nobody has still pays for a full
  hash, so the delay cannot be read as an answer either.
- **There is no way to create an account over HTTP.** Accounts come from
  `--add-account` on the host, and nothing else.
- **Plain HTTP on a local network is readable by anything else on that network.**
  For a home Wi-Fi that is usually acceptable; on a café or office network it is
  not. Both tunnel options above give you HTTPS.
- **Rotate the token** by deleting `~/.spacelink/server.json` and restarting;
  **change a password** with `--set-password`. Either signs every device out,
  which is exactly what you want if one has been lost — including a device that
  is connected right now: an open change stream is asked again every few seconds
  whether its credential still holds, and is closed within seconds of the answer
  becoming no, rather than staying open until the reader happens to close the
  app.
- **Hidden files and folders, `node_modules`, and anything behind a symlink are
  never listed, served, announced or written to.** A `.obsidian` folder in the
  same vault is left alone, and a link inside the vault is not followed — not
  even one that points back into it — so the listing and the file API always
  agree on what the vault holds, and a link cannot lead a request outside it.

---

## Backups

The vault is a folder of Markdown files. Time Machine already covers it. So does
`git init` inside it, or any sync service you already use — the server reads the
folder fresh, so a file restored or changed by something else shows up on every
device within moments.

The server itself holds no state worth backing up beyond `~/.spacelink` — the
token, and the accounts file if you made accounts. If you ran this server when
it was called SpaceFore, `~/.spacefore` is still read when it is the only one
there, so the token and the accounts survive the rename; back up whichever of
the two you have. Losing that file loses the
passwords, not the notes: the folders are still there, and `--add-account`
against the same folder puts the account back.

---

## If something is wrong

**Every device is suddenly turned away after the rename to SpaceLink.** It
should not happen — `~/.spacefore` is read when `~/.spacelink` does not exist —
but if both are there, the new one wins and holds a different token. Move the
old files across (`mv ~/.spacefore/*.json ~/.spacelink/`) and restart.

**"The folder this vault lives in is not there."** Exactly what it says: that
account's folder has been moved, renamed, or is on a drive that is not mounted.
The server answers `503` rather than reporting an empty vault, because "I cannot
see your notes" and "you have no notes" are not the same sentence. Put the folder
back, or point the account at where it went with a new `--add-account`, and it
starts working again by itself — no restart. Its live change feed comes back
too: a folder that is not there when the server tries to watch it is checked
for again every few seconds. Changes made while it was away are not announced,
since nothing was watching to see them; a device's next listing reconciles
those, the same as for a device that was simply offline.

**A device says it cannot reach the server.** Check the server is running, that
it was started with `--host 0.0.0.0` if the device is not the same machine, and
that macOS is not blocking incoming connections (*System Settings → Network →
Firewall*).

**"That token was not accepted."** Copy it again from the server's output. If you
have deleted `~/.spacelink/server.json` at some point, the token changed and
every device needs pairing again.

**"That sign-in is no longer valid."** The session expired, or somebody ran
`--set-password` on that account, which ends every session. Sign in again.

**"That email and password do not match an account."** The same answer covers a
wrong password and an address with no account, on purpose. `--list-accounts` on
the host says which addresses exist; `--set-password` sets a new one.

**"Too many attempts. Try again in 60s."** A run of wrong passwords is slowed
down. Wait the seconds it names — a correct password clears the run, and nothing
is locked. It counts the address being signed in to *and* where the attempt came
from, so behind a tunnel — where every device shares one address — a housemate
guessing at their own password can use up part of the same budget.

**"This server does not use accounts."** It was started without any, so the
access token is the way in. Make one with `--add-account` and restart if you
would rather sign in.

**Changes are not appearing on the other device.** Each device holds an open
connection for changes. Phones drop it when the screen is off and reconnect on
wake, so give it a moment after unlocking. If it persists, reload the page.

**The app will not load at all.** The server serves the build in `dist/`. Run
`npm run build` and start it again.

---

## The API, briefly

For anything you might want to script against. Every endpoint but `/api/health`
and `/api/auth/login` needs `Authorization: Bearer <token>` — either the
server's access token or a session from signing in. Which one it is decides
which vault the request reaches.

| | |
| --- | --- |
| `GET /api/health` | `{ ok, service }` — open, and says nothing else |
| `POST /api/auth/login` | `{ email, password }` → `{ token, email, vault }`. The token is this device's session. `401` for a wrong password *and* for an address with no account — identical byte for byte, and deliberately identical in how long it takes, so neither the message nor the delay says which addresses exist. `429` after a run of wrong guesses, with `Retry-After`. `404` on a server that has no accounts |
| `POST /api/auth/logout` | end the session in the `Authorization` header — that device only, not the account's others. Always `200`, whether or not there was one |
| `GET /api/auth/me` | `{ signedIn, email, vault }` for whatever credential was presented |
| `GET /api/vault` | the vault's name |
| `GET /api/files` | every file with size, mtime and a SHA-256 of its contents |
| `GET /api/bundle` | every note's text in one streamed response, as newline-delimited JSON. This is what a device uses to open the vault — one request rather than one per note |
| `GET /api/file?path=…` | the file; `ETag` is its hash |
| `PUT /api/file?path=…` | write it. `If-Match: "<hash>"` makes it conditional; `If-Match: *` means create-only. A mismatch is `409` with the current hash. Writes to one file run one at a time, so two devices saving against the same hash at the same moment get one `200` and one `409`, never two `200`s |
| `DELETE /api/file?path=…` | remove it |
| `POST /api/rename` | `{ from, to }` |
| `GET /api/events` | server-sent events as the vault changes. Takes `?token=` because `EventSource` cannot send headers. The credential is re-checked every five seconds while the stream is open, so revoking it closes the stream rather than only refusing the next request |

Writes are atomic: the file is written beside the target and moved into place, so
an interrupted save leaves the previous version whole rather than a truncated
file.

Content hashes are remembered against each file's size and mtime, so listing a
vault does not re-read every byte of it. A file whose size and mtime both match
what was seen last time keeps its hash; anything else is read again.
