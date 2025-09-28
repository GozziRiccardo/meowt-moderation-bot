export const CONFIG = {
  // Perspective attribute thresholds (tune to taste)
  thresholds: {
    SEVERE_TOXICITY: 0.85,
    THREAT: 0.80,
    SEXUAL_EXPLICIT: 0.85,
    IDENTITY_ATTACK: 0.80,
    INSULT: 0.90,
    TOXICITY: 0.92
  },
  maxBytesToFetch: 16_000, // cap remote fetch
  ipfsGateway: process.env.IPFS_GATEWAY || "https://cloudflare-ipfs.com/ipfs/",
  dryRun: (process.env.DRY_RUN || "").toLowerCase() === "true"
};
