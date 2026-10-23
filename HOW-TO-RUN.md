# Running Memoria on your own computer

You have **two** ways to use this folder. They do not conflict.

1. **GitHub Pages** (`logg8-f.github.io`) — just the website, no shared
   database. Publishing and voting are switched off there.
2. **Your own server** (this is the new part) — the website *and* a small
   shared database, so people can publish decks and vote, with no login.

This file explains how to run option 2. Same steps here and on the computer in
your wardrobe; the only thing that changes is the address people type.

---

## Try it here first

Open a terminal in this folder and run:

```
node server.mjs
```

It prints something like:

```
Memoria server running
  On this computer:   http://localhost:8787/
```

Open that link in your browser. Everything should work exactly as before, and
now the **Publish** button works too. Stop the server with **Ctrl+C**.

If you want a different port (the number after the colon), do:

```
PORT=8080 node server.mjs
```

## Where the data is kept

Everything people publish goes into **`data/db.json`**, and a small companion
file **`data/owners.json`** records the secret key each document belongs to (see
"What keeps it from being abused"). The second file protects the first.

- To back them up, copy the whole `data/` folder.
- To wipe everything and start fresh, delete the `data/` folder.
- Neither is uploaded to GitHub (see `.gitignore`).

## Moving it to the computer in your wardrobe

1. Copy this **whole folder** to the other computer, including the `data/`
   folder, e.g. to `/opt/quizlet`.
2. On that computer, run `node server.mjs` once to check it starts.
3. Create an unprivileged user for it (so the server never runs as root):

   ```
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin quizlet
   sudo chown -R quizlet:quizlet /opt/quizlet
   ```

4. Install the service:

   ```
   sudo cp deploy/quizlet.service /etc/systemd/system/quizlet.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now quizlet
   ```

   Then check it with `systemctl status quizlet`, and watch the logs with
   `journalctl -u quizlet -f`.

   If you copied the folder somewhere other than `/opt/quizlet`, edit the paths
   at the top of `quizlet.service` first.

5. Turn on the daily backup of the `data/` folder (keeps the last 14 days):

   ```
   sudo cp deploy/quizlet-backup.sh /usr/local/bin/quizlet-backup.sh
   sudo chmod +x /usr/local/bin/quizlet-backup.sh
   sudo cp deploy/quizlet-backup.service deploy/quizlet-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now quizlet-backup.timer
   ```

   Snapshots land in `/opt/quizlet/backups/`. To test it right away:
   `sudo systemctl start quizlet-backup.service` and then
   `ls /opt/quizlet/backups/`.

## How it is reached

By default the server listens **only on the machine it runs on** (`127.0.0.1`),
so it is never exposed directly. Something in front of it does the public-facing
work and passes requests inward:

- **Public:** the web server on the wardrobe computer (Caddy) answers
  `https://logg8.duckdns.org/` and forwards to this server on `127.0.0.1:8787`.
  Caddy also handles the padlock certificate and reports each visitor's real
  address to the app.
- **Private:** Tailscale can still reach the same server on its own address — see
  `SETUP-REMOTE.md`. Handy for checking the app without going through the public
  door.

If you ever want plain local-network access instead (for example a tablet on your
wifi without Tailscale), start it with `HOST=0.0.0.0`, and make sure the
firewall allows the port:

```
HOST=0.0.0.0 node server.mjs
```

Note the trade-off: that also makes it reachable by anything else on that network.

## What keeps it from being abused

The server itself enforces the important limits, so nobody can get around them
by editing the web page:

- at most **15** public decks per person,
- at least **4** cards in a public deck,
- a size cap on each write,
- a speed limit on how fast one address can write,
- **only the writer may change what they wrote.** Each browser quietly keeps a
  secret key; the server remembers the key that created a document and refuses to
  let anyone else overwrite or delete it. Reading stays open — the key is
  invisible to the person using the site. (When Google sign-in is switched on,
  below, publishing and voting need a signed-in account instead.)

Decks that get more downvotes than upvotes past a threshold are hidden
automatically, which already works in the app.

Behind a public web server in front (Caddy), the speed limit counts each visitor
separately, using the address the front server reports.

## Optional: signing in with Google

By default the app has no login at all: anyone can publish and vote, and each
browser's secret key stops them touching anyone else's deck. If you want a
stronger guarantee — that only real people with a Google account can publish and
vote, and that a deck or a vote always belongs to an account rather than to one
browser — you can switch on Google sign-in.

It is **off by default**. When it is off, nothing changes. When it is on:

- the header shows a **Sign in with Google** button;
- **publishing and voting need a signed-in account** (the server enforces this,
  not just the page);
- a deck or vote is owned by the account's stable Google id, so a stranger can
  never publish or vote as someone else;
- **browsing and studying stay open**;
- when you **do** sign in, your own saved decks and your study progress (review
  history, and a Learn run left half-finished) follow the **account**, so the
  same decks meet you on every device. The first time you sign in on a device,
  whatever was already saved there is merged in, so nothing is lost — and once a
  deck is deleted on one device it is gone on the others too;
- signed out, your personal decks stay private to the browser and need no
  account.

What you need: an OAuth **client ID** from Google (a free, one-time setup).

1. Go to https://console.cloud.google.com/apis/credentials (create a project if
   you don't have one).
2. **Create credentials → OAuth client ID → Web application.**
3. Under **Authorized JavaScript origins**, add every address the page is served
   from — exactly, with scheme and port and no trailing slash. For this server
   that is typically:

   ```
   https://gaderob.tail2714bf.ts.net:8443
   https://logg8.duckdns.org
   http://localhost:8787
   ```

   You do **not** need an "Authorized redirect URI" — Google returns the sign-in
   directly to the page.
4. Copy the client ID (it looks like
   `1234567890-abc123.apps.googleusercontent.com`). It is **public**, so it is
   fine to keep it in a config file; it is not a secret.

Then tell the server, exactly as with the Groq key. Put it in
`/etc/quizlet.env`:

```
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
```

and restart:

```
sudo systemctl restart quizlet
```

To try it locally, run the server with it in the environment:

```
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com node server.mjs
```

After restarting, `GET /api/health` reports `"auth": true` and the button appears.
You can check the enforcement with `node deploy/smoke-test.mjs` against the running
server (it will confirm publishing and voting are refused without signing in).
To sign everyone out, delete `data/sessions.json` and restart.

A note if you enable this on a server people have already used: decks they
published *before* sign-in was on belonged to a browser, not an account. They stay
visible, but the old anonymous owner can no longer update or remove them — the
person can simply sign in and publish again. Decks and votes made from then on
belong to their account.

Your own (personal) decks live under `data/` too: signed out they belong to the
browser (`data/users/<browser-id>/`), signed in they belong to the account
(`data/users/<account-id>/`), which is what lets them follow you between
devices. Copying the `data/` folder is therefore a full backup of the app.

## Optional: AI grading and hints

In **Write** and **Test** you normally have to type an answer close to the stored
one (small spelling slips are already forgiven). If you want the app to also
accept *paraphrases* — saying the same thing in different words — you can switch
on optional AI grading. In **Write** the same key also adds an **AI hint** button
that describes the meaning without giving the answer away. It is **off by
default**, costs nothing unless you add a key, and if the key is missing or the
service is unreachable the app simply falls back to the normal matching (and the
letter hint), so studying never breaks.

To turn it on, give the server a free Groq API key (get one at
https://console.groq.com):

```
GROQ_API_KEY=your-key-here node server.mjs
```

Optional settings:

- `GROQ_MODEL` — which model to use (default `openai/gpt-oss-120b`).
- AI checks are also speed-limited (about 20 per minute per visitor).

**Never put the key in the code or commit it to the repository** — it belongs only
in the environment of the running server.

If Memoria runs as a systemd service (as it does on the wardrobe computer), set the
key on the service instead of the shell. Create `/etc/quizlet.env` containing:

```
GROQ_API_KEY=your-key-here
```

then add `EnvironmentFile=/etc/quizlet.env` to `quizlet.service` and reload:

```
sudo systemctl daemon-reload && sudo systemctl restart quizlet
```

