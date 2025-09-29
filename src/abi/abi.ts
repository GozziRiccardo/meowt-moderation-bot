export const GAME_ABI = [
  // views
  "function activeMessageId() view returns (uint256)",
  "function endTime(uint256 id) view returns (uint256)",
  "function modFlagged(uint256 id) view returns (bool)",
  `function messages(uint256 id) view returns (
      uint256 id_,
      address author,
      uint256 stake,
      uint256 startTime,
      uint256 B0,
      string uri,
      bytes32 contentHash,
      uint256 likes,
      uint256 dislikes,
      uint256 feePot,
      bool resolved,
      bool nuked,
      uint8 winnerSide,
      uint256 sharePerVote,
      uint256 seedFromStake
   )`,
  // action
  "function setModerationFlag(uint256 id, bool flagged_)"
] as const;
