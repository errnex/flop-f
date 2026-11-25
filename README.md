# FLOP Testnet Agent Faucet Claim

Small local Node.js script that claims **10 test FLOP** from the official FLOP Testnet agent faucet (`POST https://faucet.flop.network/v1/testnet/agent-claims`) and checks your balance on `wss://testnet.flop.network/`.

Claim format follows the official `@flop-labs/sdk` / `flop.network/llms.txt`:
sign `flop-faucet-agent/v1|<genesis>|<address>|<nonce>` with your sr25519 wallet key.

## Safety
- Your seed phrase is typed into a hidden prompt, used **only locally** to sign, never saved or sent anywhere.
- The script only talks to `faucet.flop.network` and `testnet.flop.network`.
- It aborts if the seed doesn't derive the address you passed.
- Read the code before running. Never paste your seed into scripts from unknown sources. Use a dedicated farming wallet.
- Testnet FLOP has no monetary value.

## Run (Windows PowerShell / macOS / Linux)
```powershell
winget install OpenJS.NodeJS.LTS   # if Node.js isn't installed (Windows)
cd flop-claim
npm install
node claim.mjs --address 5YOUR_TALISMAN_ADDRESS --check-only   # faucet status + balance, no seed
node claim.mjs --address 5YOUR_TALISMAN_ADDRESS                # paste seed, press Enter
```
If the faucet reports `indexer_unavailable`, wait and retry, or add `--force`.

Note: the faucet has `rolloverRequiresSpend=true`, so your next daily claim needs the previous grant spent on Testnet inference.
