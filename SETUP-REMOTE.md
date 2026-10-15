# Using Quizlet 2.0 from outside your home (private, just you)

You chose **only you**, so we do **not** open anything to the public internet.
Instead we use a free tool called **Tailscale** that links your own devices
together into a private network of your own. Your phone/laptop and the wardrobe
computer can see each other anywhere, and nobody else can.

Why this and not DuckDNS: DuckDNS plus opening a port on your router makes the
site **public** — anyone on the internet could find it and post junk decks. For
"just me", Tailscale is simpler *and* safer: no router changes, no exposed port,
and it still works if your internet provider hides your address. You can keep
using DuckDNS for your other projects.

You'll do this **on the wardrobe computer**, not on this laptop.

---

## Step 1 — Put the app on the wardrobe computer

Copy this whole folder there, for example to `/opt/quizlet`, and make it start
automatically on boot by following the "systemd" part of `HOW-TO-RUN.md`.
Test it once by hand first:

```
cd /opt/quizlet
node server.mjs
```

You should see it print `http://localhost:8787/`. Press **Ctrl+C** to stop.

## Step 2 — Install Tailscale on the wardrobe computer

Run this one line (works on most Linux):

```
curl -fsSL https://tailscale.com/install.sh | sh
```

*(On an Arch/Omarchy computer, `sudo pacman -S tailscale` does the same.)*

Then start it and sign in:

```
sudo systemctl enable --now tailscaled
sudo tailscale up
```

It prints a web link. Open it, create a free Tailscale account (or sign in), and
approve. That's you signing into *the network*, not into Quizlet — Quizlet
itself still needs no login.

Check it worked:

```
tailscale status
tailscale ip -4
```

## Step 3 — Give the app a private web address

Make Tailscale hand out a proper `https://…` address for Quizlet:

```
sudo tailscale serve --bg 8787
```

It prints something like:

```
Available within your tailnet:
https://wardrobe-computer.your-name.ts.net
```

That address works only for devices signed into *your* Tailscale account.

## Step 4 — Sign in on your phone and laptop

Install the Tailscale app on each device you want to use:
- iPhone/Android: from the app store.
- This laptop (Omarchy): `sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up`.

Sign in with the **same account** you used in Step 2.

## Step 5 — Use it

On any of those devices, open the `https://…ts.net` address from Step 3.
It behaves exactly like the local site — create decks, publish, vote.

To stop sharing later: `sudo tailscale serve off`.
To see what's being shared: `sudo tailscale serve status`.

---

## If you change your mind and want it public

Swap one word — `serve` becomes `funnel`:

```
sudo tailscale funnel --bg 8787
```

That exposes it to everyone on the internet at the same `https://…ts.net`
address, still with no port-forwarding. Remember there is **no password** on the
app, so if you do this, ask me to add a simple gate first.

## Notes

- The app keeps binding to port 8787 on the computer itself; Tailscale is what
  makes it reachable from elsewhere. Nothing about the app changes.
- If `tailscale serve` complains about certificates, just follow the link it
  prints — it's a one-time "enable HTTPS in your tailnet" click.
- Your data still lives in `/opt/quizlet/data/db.json` on the wardrobe computer.
  Back that file up now and then.
