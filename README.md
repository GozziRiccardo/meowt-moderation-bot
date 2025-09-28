# MEOWT Moderation Bot (GitHub Actions)

Simple cron job that:
1) Reads the current `activeMessageId` from the BillboardGame contract.
2) Fetches the post text (supports `meow:text:`, `data:text/plain;base64,`, `ipfs://`, `https://`).
3) Sends the text to Google Perspective API.
4) If any score crosses configured thresholds, calls `setModerationFlag(id, true)` as your bot (the same address you set via `setModeration(...)` in the contract).

## What you need
- Contract already deployed.
- `setModeration(<BOT_ADDRESS>, false)` already called from the owner.
- A Base Sepolia (or your target chain) RPC URL.
- Google Perspective API key (free to request).
- The bot wallet's **private key** (the same address you set as moderation signer).

## Configure (GitHub Secrets)
Go to: **Repo → Settings → Secrets and variables → Actions → New repository secret** and add:

- `GAME_ADDRESS` — your BillboardGame contract address.
- `RPC_URL` — your node endpoint (e.g. Base Sepolia from Alchemy/Infura/QuickNode).
- `BOT_PRIVATE_KEY` — private key of the moderation bot (no 0x prefix or with 0x, both fine).
- `PERSPECTIVE_API_KEY` — Google Perspective key.
- (optional) `IPFS_GATEWAY` — default `https://cloudflare-ipfs.com/ipfs/`.
- (optional) `DRY_RUN` — set to `true` to test without sending transactions.

## Run
- It runs every 5 minutes automatically.
- You can also run on demand: **Actions → moderate-billboard → Run workflow**.

## Notes
- The bot only flags **if** the message is not already flagged **and** thresholds are exceeded.
- If there is no active message, it exits quietly.
- Thresholds are set in `src/config.ts`. Tweak them to taste.
