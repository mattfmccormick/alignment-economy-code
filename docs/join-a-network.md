# Join an Alignment Economy network

Walks one invitee through joining a network the founder already created. About 5 minutes.

## What you'll need from the founder

Two things, in two messages:
1. **An invite link** (or a `genesis.json` file). Either contains the public network spec. The link looks like `https://invite.alignmenteconomy.org/v1#...` and is long.
2. **Your personal keystore** (a `.json` file). This is private. The founder sent this to you and only you. If you can't find it, ask them to resend.

If you also got a **spec hash** (a 64-char fingerprint), keep it handy. You'll compare yours against the founder's at the end as a sanity check.

## Joining

1. **Open the Alignment Economy Wallet, click "Create Account."**
2. On the network choice screen, pick **"Join an existing network."**
3. Paste the **invite link** into the textarea at the top, or upload the `genesis.json` file in the section below it. Either works.
4. Upload **your keystore** (the `.json` file the founder sent you privately) in the section below.
5. The wallet checks that your keystore matches one of the validators in the spec. If it does, you'll see a green **"Match confirmed"** banner with the network ID and your accountId.
   - If you see a red **"Keystore not in this network"** warning, the keystore and spec don't go together. Double-check that both came from the same founder for the same network.
6. Click **"Join network."**

## Confirming you're on the same network

The wallet's "Network saved" screen shows the network ID and your accountId. Compare the **spec hash** with the founder's. If they match, you're on the right network.

Click **"Apply now (restart app)"**. The app relaunches and your node boots as a validator on the founder's network.

## After the restart

You're now a validator on the network. You can:
- See the chain advancing as other validators (including the founder) commit blocks.
- Send and receive points with everyone else on the network.
- Vouch for other people on the network to raise their percent-human scores.

If your node never sees other validators (no blocks advance, peer count stays at 0), the founder's node is unreachable from yours. Possible reasons:
- The founder isn't running their wallet right now. Ask them to open it.
- You're on different home networks and NAT is blocking peering. For now you'll need to be on the same LAN, both on Tailscale (or similar), or have one of you port-forward.
- The founder's node has a different `genesis.json` than yours. Re-check the spec hash with them.

## Recovery

The keystore the founder sent you IS your recovery file. Lose it, lose the account. There's no mnemonic backup for joiner identities yet. Keep it somewhere safe (password manager, backup drive).

If you reinstall the wallet, you can rejoin the network by repeating the flow above with the same invite link + keystore.

## Where things live (Windows)

- Wallet config + DB: `%AppData%\Alignment Economy Wallet\`
- Network config (spec + your keystore): `%AppData%\Alignment Economy Wallet\ae-network\`
