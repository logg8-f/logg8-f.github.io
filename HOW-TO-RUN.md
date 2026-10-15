# Running Quizlet 2.0 on your own computer

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
Quizlet 2.0 server running
  On this computer:   http://localhost:8787/
```

Open that link in your browser. Everything should work exactly as before, and
now the **Publish** button works too. Stop the server with **Ctrl+C**.

If you want a different port (the number after the colon), do:

```
PORT=8080 node server.mjs
```

## Where the data is kept

Everything people publish goes into one file: **`data/db.json`**.

- To back it up, copy that file.
- To wipe it and start fresh, delete it.
- It is deliberately **not** uploaded to GitHub (see `.gitignore`).

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

5. Turn on the daily backup of `data/db.json` (keeps the last 14 days):

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

## Letting other people use it

People reach your server at `http://<the-wardrobe-computer-ip>:8787/`.
Find that computer's IP address (on Linux: `ip addr`), and make sure its
firewall allows port 8787.

If you want a normal address like `http://something.local/` (no port number)
or want it reachable from outside your home, that needs a reverse proxy
(for example Caddy or nginx) — ask when you're ready and we'll set it up.

## What keeps it from being abused

The server itself enforces the important limits, so nobody can get around them
by editing the web page:

- at most **15** public decks per person,
- at least **4** cards in a public deck,
- a size cap on each write,
- a speed limit on how fast one address can write.

Decks that get more downvotes than upvotes past a threshold are hidden
automatically, which already works in the app.
