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

## Adding another node

**A machine that is not a validator** can sync and serve reads: clone, build,
copy `genesis.json`, leave `nodeKeyPath` unset, point `seedNodes` at an existing
node.

**A new validator** has to be registered on-chain — the change rides in a
committed block, so the existing validators must be up and producing at the
time. It also needs earned points to stake. See `POST /api/v1/validators/register`.

Three validators is meaningfully better than two: quorum becomes 2 of 3, so one
machine can go down without halting the chain. With two, either one stopping
halts everything.

**Known limitation:** joining today means replaying the entire chain from
genesis, and that gets slower as the chain grows. See "Sync does not scale" in
CLAUDE.md — snapshot sync is the fix and the groundwork exists.
