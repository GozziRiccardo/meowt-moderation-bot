// src/abi.ts
// Minimal ABI for the keeper: reads active post, message details, and flags moderation
export const ABI = [
  {
    "type": "function",
    "name": "activeMessageId",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }]
  },
  {
    "type": "function",
    "name": "messages",
    "stateMutability": "view",
    "inputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "outputs": [
      { "internalType": "uint256", "name": "id", "type": "uint256" },
      { "internalType": "address", "name": "author", "type": "address" },
      { "internalType": "uint256", "name": "stake", "type": "uint256" },
      { "internalType": "uint256", "name": "startTime", "type": "uint256" },
      { "internalType": "uint256", "name": "B0", "type": "uint256" },
      { "internalType": "string", "name": "uri", "type": "string" },
      { "internalType": "bytes32", "name": "contentHash", "type": "bytes32" },
      { "internalType": "uint256", "name": "likes", "type": "uint256" },
      { "internalType": "uint256", "name": "dislikes", "type": "uint256" },
      { "internalType": "uint256", "name": "feePot", "type": "uint256" },
      { "internalType": "bool", "name": "resolved", "type": "bool" },
      { "internalType": "bool", "name": "nuked", "type": "bool" },
      { "internalType": "uint8", "name": "winnerSide", "type": "uint8" },
      { "internalType": "uint256", "name": "sharePerVote", "type": "uint256" },
      { "internalType": "uint256", "name": "seedFromStake", "type": "uint256" }
    ]
  },
  {
    "type": "function",
    "name": "setModerationFlag",
    "stateMutability": "nonpayable",
    "inputs": [
      { "internalType": "uint256", "name": "id", "type": "uint256" },
      { "internalType": "bool", "name": "flagged_", "type": "bool" }
    ],
    "outputs": []
  }
] as const;

export default ABI;
