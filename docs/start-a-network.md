# Start an Alignment Economy network

Walks one founder through standing up a fresh AE network and inviting a small group. About 10 minutes if everyone is in the same room or chat.

## What you're doing

Generating a **genesis ceremony**: a public network spec everyone shares, plus one private keystore per validator. The spec defines who the founding validators are, their starting balances, and the network ID. Each keystore holds one validator's secret keys.

The founder runs the ceremony, distributes keystores privately to invitees, and shares the spec publicly. Each invitee installs the wallet, joins the network with their keystore, and starts validating.

## What you need

- The Alignment Economy Wallet installed on each machine (download links in the project README).
- A way to send each invitee a small file privately (DM, encrypted email, signal message). Don't put keystores in a public channel.
- A network ID to identify your network. Lowercase, 3 to 32 characters, letters/numbers/hyphens. Examples: `ae-friends-2026`, `ae-mom-house`.
- A list of who's joining. The founder counts as one validator.

## Founder flow

1. **Open the wallet, click "Create Account."**
2. On the network choice screen, pick **"Start a new network."**
3. Fill in the form:
   - **Network ID** as above.
   - **Number of validators**: how many people will be in this network including you. Minimum 1. Practical max for a friend group: under 10.
   - **Names**: short labels per validator. The first name is yours; the rest label each invitee's keystore so you don't mix them up. Names like `matt`, `kira`, `josh` work.
4. Click **"Generate genesis."**
5. The result screen shows a **spec hash** (a 64-character fingerprint), an **invite link**, a **Download genesis.json** button, and one keystore download per validator.

## Distributing the keystores

> **Each keystore is a private secret. Anyone who has it can validate as that person and sign their transactions. Treat it like a password file.**

For each invitee:
- Download their keystore (the one labeled with their name).
- Send it to them through a private channel: DM, signal, encrypted email, or a USB stick if they're nearby.
- Send them the invite link in the same message. The link contains the public spec; it doesn't need to be private.

Don't email keystores. Don't post them in a group chat. One keystore per recipient.

## Confirming everyone got the same spec

After invitees paste the invite link in their wallets, ask them to read the spec hash off their result screen and compare it with yours. If the hashes match, you're all on the same network. If they don't match, somebody got the wrong file.

## Continuing as the founder

After downloading everything, click **"I've saved everything, continue."** The wallet saves your keystore as your validator identity, then shows a "Network saved" screen. Click **"Apply now (restart app)"**. The app relaunches and your node boots in BFT mode for the new network.

Until at least one other validator is online, your node holds the chain alone. Once invitees are running, the validators peer up and produce blocks together.

## Network state at this point

You and your invitees can:
- See the chain growing block by block.
- Send each other points (subject to verification status).
- Vouch for each other to raise percent-human scores.
- File court cases.

What you can't do yet:
- Reach validators on different home networks without help. NAT traversal (over the internet) is the next milestone. For now this works on a shared LAN, on Tailscale, or with port forwarding to a server.

## Recovery

The keystore IS the recovery file for a validator account. Lose it, lose the account. There's no mnemonic backup for founder/joiner identities yet. Keep the keystore somewhere safe.

## Where things live (Windows)

- Wallet config + DB: `%AppData%\Alignment Economy Wallet\`
- Network config (spec + keystore): `%AppData%\Alignment Economy Wallet\ae-network\`
- Logs: ae-node prints to the wallet's stdout. Run the wallet from a terminal to see them.
