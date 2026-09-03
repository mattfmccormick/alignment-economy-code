# Running a node

Every machine runs the **same command**. What differs between machines lives in
a config file, not in the command you type.

```
npm run dev -- --config=./node-config.json
```

That replaces the twelve-environment-variable line that setup used to require.
That line was the single biggest source of setup failures: it is PowerShell-only
syntax, it embeds the keystore filename and a peer's IP address, and both of
those differ per machine and change over time.

---

## First time on a machine

**1. Prerequisites** — Node.js 22+ and Git.

```powershell
node --version; git --version
```

**2. Clone and build.** SDK first: the apps import it and fail to resolve
otherwise.

```powershell
cd $HOME
git clone https://github.com/mattfmccormick/alignment-economy-code.git
cd $HOME\alignment-economy-code\sdk;     npm install; npm run build
cd $HOME\alignment-economy-code\ae-node; npm install; npm run build
```

**3. Network files.** Two files, from an operator who already has them:

```
ae-node\testnet\genesis.json                    <- public, same on every machine
ae-node\testnet\keys\<your-account-id>.json     <- private, unique to you
```

Do not rename either. The node matches the keystore by exact filename.

```powershell
New-Item -ItemType Directory -Force $HOME\alignment-economy-code\ae-node\testnet\keys
```

**4. Config file.** Copy the example and edit the four marked fields.

```powershell
cd $HOME\alignment-economy-code\ae-node
Copy-Item ..\docs\node-config.example.json .\node-config.json
notepad .\node-config.json
```

- `nodeKeyPath` — path to YOUR keystore
- `bftLocalAccountId` and `nodeId` — your account id (the keystore filename
  without `.json`)
- `seedNodes` — the IP and port of a node already on the network. Leave `[]` if
  you are the first.

**5. Start.**

```powershell
npm run dev -- --config=./node-config.json
```

Wait for `Node fully started`. Leave the window alone — that window *is* the
node.

---

## Every time after that

```powershell
cd $HOME\alignment-economy-code\ae-node
npm run dev -- --config=./node-config.json
```

That is the whole thing, on every machine, forever.

Wallet and miner, each in their own window:

```powershell
cd $HOME\alignment-economy-code\ae-app;   npm run dev   # localhost:5173
cd $HOME\alignment-economy-code\ae-miner; npm run dev   # localhost:5174
```

---

## Before you debug anything, check these four

Every multi-machine failure so far has been one of them. None were consensus
bugs, and all four are silent.

**1. Same commit on every machine.** Mismatched code computes different block
hashes, so peers reject each other's blocks and ban them.

```powershell
git log --oneline -1     # must match on all machines
```

**2. Network profile is Private, not Public.** Windows blocks inbound
connections on Public networks, and a firewall rule scoped to Private silently
does not apply. The node looks perfectly healthy and no peer ever connects.

```powershell
Get-NetConnectionProfile | Select-Object Name,NetworkCategory
```

Fix in Settings > Network & internet > Wi-Fi > (your network) > Private.

**3. Port 9000 allowed inbound**, on the machine others dial:

```powershell
New-NetFirewallRule -DisplayName "AE Node P2P 9000" -Direction Inbound `
  -Protocol TCP -LocalPort 9000 -Action Allow -Profile Private
```

Administrator PowerShell. Once per machine.

**4. Seed IPs still correct.** LAN addresses change when you move network or the
router reassigns them. Nothing logs "the address you were told to dial no longer
exists" — the node just never peers.

```powershell
ipconfig | Select-String 'IPv4'
```

Set a DHCP reservation for each node in your router and this stops happening.

---

## When something is actually wrong

**`EADDRINUSE`** — an old node is still running.

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

Careful: that kills every Node process on the machine, including the wallet and
miner dev servers.

**`Genesis mismatch`** — the database was built under a different
`genesis.json`. They are a matched pair. Delete the database and restart; it
re-syncs.

```powershell
Remove-Item .\data\ae-node.db* -Force
```

**`reason=banned`** — a peer rejected one of your blocks and banned you. The ban
is in memory only, so restarting the *banning* node clears it. Almost always
caused by check 1 above.

**Block height not moving** — BFT needs a quorum. With two validators that means
both; with three, any two. Check the other machines are actually up.

**Never delete a database to "start fresh" on a node that has state you care
about.** It holds the chain.

---

## Joining a chain that already has history

A new node replays every block from genesis. That is correct and fully
trustless, and it is O(chain length): at a 10-second block interval the chain
grows by 8,640 blocks a day, so the wait grows without bound. Bringing a machine
online at five thousand blocks already took hours.

**Snapshot sync skips the replay.** An existing operator exports their database,
you check it against the network, you import it, and the node syncs forward only
from that height.

**On a machine that is already on the network:**

```powershell
cd $HOMEalignment-economy-codeae-node
node scripts/snapshot.mjs export
```

Safe while the node is running. It prints the file path, its height, and its
state root. Send the file across (USB, LAN share, whatever — it is not secret,
it is public chain state).

**On the joining machine, verify BEFORE importing:**

```powershell
node scripts/snapshot.mjs verify <file> --peer http://<a-node>:3000
```

Two different checks happen here, and the difference matters:

- Without `--peer`, all it proves is that the file is internally consistent —
  not truncated, not a torn copy. Anyone who can hand you a file can hand you a
  consistent fake.
- With `--peer`, it asks that node for the state root it recorded at the
  snapshot's height and requires them to match. **That** is the check with teeth.
  Repeat `--peer` for each independent node you want to ask. Trust the snapshot
  as far as you trust the peers you checked it against; asking one node run by
  the person who gave you the file proves nothing.

**Then import and start:**

```powershell
node scripts/snapshot.mjs import <file>
npm run dev -- --config=./node-config.json
```

Import keeps a timestamped backup of any existing database, and refuses to run
while a node is using it. Your keystore is a separate file and is not touched,
so the machine keeps its own identity.

This is operator-assisted, the same model as Bitcoin's `assumeutxo` and
Solana's snapshot download — not trustless peer-to-peer state sync. The state
root is not yet folded into the block hash (see `core/state-root.ts` for why
doing that today deadlocks the chain), so cross-checking peers is what makes it
sound rather than the file checking itself.

**Comparing two machines** without moving anything:

```powershell
curl http://<node-a>:3000/api/v1/network/state-root?height=5000
curl http://<node-b>:3000/api/v1/network/state-root?height=5000
```

Same 64 hex characters means the two nodes hold identical account state at that
height. Different, persistently, means real drift — usually a direct SQL write
such as `scripts/dev-bump-ph.mjs` run on some nodes and not others.

---

## Adding another node

**A machine that is not a validator** can sync and serve reads: clone, build,
copy `genesis.json`, leave `nodeKeyPath` unset, point `seedNodes` at an existing
node. Use snapshot sync above rather than waiting out a full replay.

**A new validator** takes three steps.

**1. Generate an identity** on the new machine:

```powershell
cd $HOMEalignment-economy-codeae-node
npm run validator:setup -- --network-id <network> --output $HOMEae-validator
```

This writes a keystore and a config. Copy `genesis.json` in beside them, then
start the node so it syncs.

**2. Fund the account.** Registration stakes *earned* points, so the account has
to exist on-chain and hold them. Daily active, supportive and ambient points
expire nightly and cannot be staked.

**3. Register on-chain:**

```powershell
npm run validator:register -- --keystore $HOMEae-validatorkeystore.json --node http://<existing-validator>:3000 --stake <points>
```

**`--node` must be a node that is ALREADY an active validator, and it is
usually not your own.** A validator change is not gossiped like a transaction:
it goes into a local queue on the node that received it, and that queue is
drained in exactly one place — when *that* node proposes a block. A candidate
node is not in the set yet, so it never proposes, so the change would sit in its
queue forever. The POST returns 200 and nothing anywhere reports an error. The
CLI checks the target's `/status` and refuses rather than let that happen.

If you are scripting this by hand rather than using the CLI, POST to
`/api/v1/validators/propose-register`, **not** `/api/v1/validators/register`.
The names differ by one word and the behaviour differs completely: the second
one applies the change to that single node's database and never puts it on the
chain, which silently diverges that node's validator set from everyone else's
and halts the chain. The CLI shipped pointing at the wrong one on September 3
and was fixed the same day.

Confirm it landed:

```powershell
curl http://<existing-validator>:3000/api/v1/validators
```

Look for your account id with `isActive` true, then restart the new node.

Three validators is meaningfully better than two: quorum becomes 2 of 3, so one
machine can go down without halting the chain. With two, either one stopping
halts everything.
