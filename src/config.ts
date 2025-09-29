export const CONFIG = {
  rpcUrl: process.env.RPC_URL || "",
  privateKey: (process.env.BOT_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim(),
  gameAddress: (process.env.GAME_ADDRESS || process.env.CONTRACT_ADDRESS || "").trim(),
  chainId: Number(process.env.CHAIN_ID || "0"),
  rateLimitMs: Number(process.env.RATE_LIMIT_MS || "800"),
  // Optional off-chain content resolver for meow:text hashes:
  modApiUrl: (process.env.MOD_API_URL || "").trim(),
  modApiKey: (process.env.MOD_API_KEY || "").trim()
};

function req(name: string, val: string) {
  if (!val) throw new Error(`Missing required env: ${name}`);
}
req("RPC_URL", CONFIG.rpcUrl);
req("BOT_PRIVATE_KEY/PRIVATE_KEY", CONFIG.privateKey);
req("GAME_ADDRESS/CONTRACT_ADDRESS", CONFIG.gameAddress);
