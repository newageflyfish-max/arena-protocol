// ---------------------------------------------------------------------------
// Arena Protocol -- Contract addresses & ABIs
// ---------------------------------------------------------------------------
// Addresses are loaded from NEXT_PUBLIC_ env vars with placeholder defaults.
// In production, set these env vars to match your deployment.
//
// 3-contract split architecture:
//   ArenaCoreMain    -- view functions, createTask, TaskCreated, TaskCancelled
//   ArenaCoreAuction -- auction lifecycle (commitBid, revealBid, resolveAuction,
//                       deliverTask) + events: AgentAssigned, TaskDelivered,
//                       TaskCompleted, AgentSlashed
//   ArenaCoreVRF     -- VRF coordinator callback (no direct frontend usage)
// ---------------------------------------------------------------------------

const _ArenaCoreMain = (process.env.NEXT_PUBLIC_ARENA_CORE_MAIN_ADDRESS ??
  process.env.NEXT_PUBLIC_ARENA_CORE_ADDRESS ??
  '0x0000000000000000000000000000000000000001') as `0x${string}`;

export const ADDRESSES = {
  /** Primary entry-point: views + createTask */
  ArenaCoreMain: _ArenaCoreMain,

  /** Auction contract: bid/reveal/resolve/deliver lifecycle */
  ArenaCoreAuction: (process.env.NEXT_PUBLIC_ARENA_CORE_AUCTION_ADDRESS ??
    '0x0000000000000000000000000000000000000005') as `0x${string}`,

  /** VRF contract: verifier pool + randomness */
  ArenaCoreVRF: (process.env.NEXT_PUBLIC_ARENA_CORE_VRF_ADDRESS ??
    '0x0000000000000000000000000000000000000006') as `0x${string}`,

  /** @deprecated Backward-compatible alias for ArenaCoreMain */
  ArenaCore: _ArenaCoreMain,

  MockUSDC: (process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS ??
    '0x0000000000000000000000000000000000000002') as `0x${string}`,
  ArenaProfiles: (process.env.NEXT_PUBLIC_ARENA_PROFILES_ADDRESS ??
    '0x0000000000000000000000000000000000000003') as `0x${string}`,
  ArenaCompliance: (process.env.NEXT_PUBLIC_ARENA_COMPLIANCE_ADDRESS ??
    '0x0000000000000000000000000000000000000004') as `0x${string}`,
  ArenaArbitration: (process.env.NEXT_PUBLIC_ARENA_ARBITRATION_ADDRESS ??
    '0x0000000000000000000000000000000000000007') as `0x${string}`,
  ArenaOutcomes: (process.env.NEXT_PUBLIC_ARENA_OUTCOMES_ADDRESS ??
    '0x0000000000000000000000000000000000000008') as `0x${string}`,
  ArenaInsurance: (process.env.NEXT_PUBLIC_ARENA_INSURANCE_ADDRESS ??
    '0x0000000000000000000000000000000000000009') as `0x${string}`,
  ArenaSyndicates: (process.env.NEXT_PUBLIC_ARENA_SYNDICATES_ADDRESS ??
    '0x000000000000000000000000000000000000000a') as `0x${string}`,
  ArenaDelegation: (process.env.NEXT_PUBLIC_ARENA_DELEGATION_ADDRESS ??
    '0x000000000000000000000000000000000000000b') as `0x${string}`,
  ArenaReputation: (process.env.NEXT_PUBLIC_ARENA_REPUTATION_ADDRESS ??
    '0x000000000000000000000000000000000000000c') as `0x${string}`,
  ArenaConsensus: (process.env.NEXT_PUBLIC_ARENA_CONSENSUS_ADDRESS ??
    '0x000000000000000000000000000000000000000d') as `0x${string}`,
  ArenaRecurring: (process.env.NEXT_PUBLIC_ARENA_RECURRING_ADDRESS ??
    '0x000000000000000000000000000000000000000e') as `0x${string}`,
} as const;

// ---------------------------------------------------------------------------
// ArenaCoreMain ABI (viem typed const)
// Contains: all view/passthrough functions, createTask, TaskCreated, TaskCancelled
// ---------------------------------------------------------------------------
export const ARENA_CORE_MAIN_ABI = [
  // ---- View functions ----
  {
    type: 'function',
    name: 'taskCount',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTask',
    inputs: [{ name: '_taskId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'poster', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'bounty', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'slashWindow', type: 'uint256' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'bidDeadline', type: 'uint256' },
          { name: 'revealDeadline', type: 'uint256' },
          { name: 'requiredVerifiers', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'criteriaHash', type: 'bytes32' },
          { name: 'taskType', type: 'string' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAssignment',
    inputs: [{ name: '_taskId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'agent', type: 'address' },
          { name: 'stake', type: 'uint256' },
          { name: 'price', type: 'uint256' },
          { name: 'assignedAt', type: 'uint256' },
          { name: 'deliveredAt', type: 'uint256' },
          { name: 'outputHash', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'agentReputation',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'agentTasksCompleted',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'agentTasksFailed',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'agentActiveStake',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'agentBanned',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'defaultToken',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tokenWhitelist',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'posterActiveTasks',
    inputs: [{ name: 'poster', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'maxPosterActiveTasks',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifierPoolLength',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'protocolTreasury',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // ---- Write functions ----
  {
    type: 'function',
    name: 'createTask',
    inputs: [
      { name: '_bounty', type: 'uint256' },
      { name: '_deadline', type: 'uint256' },
      { name: '_slashWindow', type: 'uint256' },
      { name: '_bidDuration', type: 'uint256' },
      { name: '_revealDuration', type: 'uint256' },
      { name: '_requiredVerifiers', type: 'uint8' },
      { name: '_criteriaHash', type: 'bytes32' },
      { name: '_taskType', type: 'string' },
      { name: '_token', type: 'address' },
    ],
    outputs: [{ name: 'taskId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  // ---- Events emitted by Main ----
  {
    type: 'event',
    name: 'TaskCreated',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'poster', type: 'address', indexed: true },
      { name: 'bounty', type: 'uint256', indexed: false },
      { name: 'taskType', type: 'string', indexed: false },
      { name: 'deadline', type: 'uint256', indexed: false },
      { name: 'requiredVerifiers', type: 'uint8', indexed: false },
    ],
  },

  {
    type: 'event',
    name: 'TaskCancelled',
    inputs: [{ name: 'taskId', type: 'uint256', indexed: true }],
  },
] as const;

// ---------------------------------------------------------------------------
// ArenaCoreAuction ABI (viem typed const)
// Contains: events emitted by the Auction contract
// (write functions like commitBid, revealBid, resolveAuction, deliverTask
//  are NOT called directly by the frontend -- agents use off-chain tooling)
// ---------------------------------------------------------------------------
export const ARENA_CORE_AUCTION_ABI = [
  // ---- Write functions ----
  {
    type: 'function',
    name: 'commitBid',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_commitHash', type: 'bytes32' },
      { name: '_criteriaAckHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revealBid',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_stake', type: 'uint256' },
      { name: '_price', type: 'uint256' },
      { name: '_eta', type: 'uint256' },
      { name: '_salt', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'resolveAuction',
    inputs: [{ name: '_taskId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'deliverTask',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_outputHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'submitVerification',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_vote', type: 'uint8' },
      { name: '_reportHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registerVerifier',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_stake', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'enforceDeadline',
    inputs: [{ name: '_taskId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // ---- View functions ----
  {
    type: 'function',
    name: 'bids',
    inputs: [
      { name: '_taskId', type: 'uint256' },
      { name: '_agent', type: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'commitHash', type: 'bytes32' },
          { name: 'stake', type: 'uint256' },
          { name: 'price', type: 'uint256' },
          { name: 'eta', type: 'uint256' },
          { name: 'revealed', type: 'bool' },
          { name: 'criteriaAckHash', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  // ---- Events emitted by Auction ----
  {
    type: 'event',
    name: 'BidCommitted',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'commitHash', type: 'bytes32', indexed: false },
      { name: 'criteriaAckHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BidRevealed',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
      { name: 'eta', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentAssigned',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'price', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TaskDelivered',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'outputHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TaskCompleted',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentSlashed',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'severity', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VerificationSubmitted',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'verifier', type: 'address', indexed: true },
      { name: 'vote', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VerifierAssigned',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'verifier', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// ArenaCoreVRF ABI (verifier pool management)
// ---------------------------------------------------------------------------
export const ARENA_CORE_VRF_ABI = [
  {
    type: 'function',
    name: 'joinVerifierPool',
    inputs: [{ name: '_stake', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'leaveVerifierPool',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'verifierPool',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifierPoolLength',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'verifierRegistry',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'stake', type: 'uint256' },
          { name: 'isActive', type: 'bool' },
          { name: 'taskCount', type: 'uint256' },
          { name: 'approvalCount', type: 'uint256' },
          { name: 'rejectionCount', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// @deprecated -- Backward-compatible combined ABI alias
// Prefer ARENA_CORE_MAIN_ABI + ARENA_CORE_AUCTION_ABI in new code.
// ---------------------------------------------------------------------------
export const ARENA_CORE_ABI = [
  ...ARENA_CORE_MAIN_ABI,
  ...ARENA_CORE_AUCTION_ABI,
] as const;

// ---------------------------------------------------------------------------
// ERC-20 ABI (minimal)
// ---------------------------------------------------------------------------
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// ArenaProfiles ABI
// ---------------------------------------------------------------------------
export const ARENA_PROFILES_ABI = [
  // ---- View functions ----
  {
    type: 'function',
    name: 'getProfile',
    inputs: [{ name: '_user', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'exists', type: 'bool' },
          { name: 'profileType', type: 'uint8' },
          { name: 'avatarHash', type: 'bytes32' },
          { name: 'displayName', type: 'string' },
          { name: 'bio', type: 'string' },
          { name: 'websiteUrl', type: 'string' },
          { name: 'createdAt', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hasProfile',
    inputs: [{ name: '_user', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'profileCount',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // ---- Write functions ----
  {
    type: 'function',
    name: 'createProfile',
    inputs: [
      { name: '_profileType', type: 'uint8' },
      { name: '_displayName', type: 'string' },
      { name: '_bio', type: 'string' },
      { name: '_websiteUrl', type: 'string' },
      { name: '_avatarHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateProfile',
    inputs: [
      { name: '_displayName', type: 'string' },
      { name: '_bio', type: 'string' },
      { name: '_websiteUrl', type: 'string' },
      { name: '_avatarHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // ---- Events emitted by Main ----
  {
    type: 'event',
    name: 'ProfileCreated',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'profileType', type: 'uint8', indexed: false },
      { name: 'displayName', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ProfileUpdated',
    inputs: [{ name: 'user', type: 'address', indexed: true }],
  },
] as const;

// ---------------------------------------------------------------------------
// ArenaCompliance ABI (subset for onboarding)
// ---------------------------------------------------------------------------
export const ARENA_COMPLIANCE_ABI = [
  {
    type: 'function',
    name: 'tosHash',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'acceptTermsOfService',
    inputs: [{ name: '_tosHash', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'hasAcceptedTos',
    inputs: [{ name: '_user', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hasAcceptedCurrentTos',
    inputs: [{ name: '_user', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------
export const PROFILE_TYPES = ['poster', 'agent', 'verifier', 'insurer'] as const;

export type ProfileType = (typeof PROFILE_TYPES)[number];

export const PROFILE_TYPE_LABELS: Record<number, string> = {
  0: 'Poster',
  1: 'Agent',
  2: 'Verifier',
  3: 'Insurer',
};

export const PROFILE_TYPE_COLORS: Record<number, string> = {
  0: 'text-arena-blue',
  1: 'text-arena-green',
  2: 'text-arena-amber',
  3: 'text-purple-400',
};

// ---------------------------------------------------------------------------
// Task status helpers
// ---------------------------------------------------------------------------
export const TASK_STATUS_LABELS: Record<number, string> = {
  0: 'Open',
  1: 'Bid Reveal',
  2: 'Assigned',
  3: 'Delivered',
  4: 'Verifying',
  5: 'Completed',
  6: 'Failed',
  7: 'Disputed',
  8: 'Cancelled',
};

export const TASK_STATUS_COLORS: Record<number, string> = {
  0: 'text-arena-blue',
  1: 'text-arena-amber',
  2: 'text-cyan-400',
  3: 'text-purple-400',
  4: 'text-arena-amber',
  5: 'text-arena-green',
  6: 'text-arena-red',
  7: 'text-orange-400',
  8: 'text-zinc-500',
};

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------
export const TASK_TYPES = [
  'audit',
  'risk_validation',
  'credit_scoring',
  'treasury_execution',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

// ---------------------------------------------------------------------------
// Verifier vote enum (matches VerifierVote in ArenaTypes.sol)
// ---------------------------------------------------------------------------
export const VERIFIER_VOTES = {
  Approve: 0,
  Reject: 1,
  Abstain: 2,
} as const;

export const VERIFIER_VOTE_LABELS: Record<number, string> = {
  0: 'Approve',
  1: 'Reject',
  2: 'Abstain',
};
