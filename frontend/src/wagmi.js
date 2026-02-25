/**
 * The Arena — Wagmi + RainbowKit Configuration
 */

import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { base, baseSepolia, hardhat } from 'wagmi/chains';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Popular',
      wallets: [injectedWallet, metaMaskWallet, coinbaseWallet],
    },
  ],
  {
    appName: 'The Arena',
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'placeholder',
  }
);

export const config = createConfig({
  connectors,
  chains: [baseSepolia, base, hardhat],
  transports: {
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined),
    [base.id]: http(),
    [hardhat.id]: http('http://127.0.0.1:8545'),
  },
  ssr: false,
});

// ArenaCore combined ABI (backward-compatible: Main + Auction)
// In the 3-contract split, views & createTask live on Main,
// auction write functions & events live on Auction.
// Note: tuple fields must be unnamed for viem/abitype compatibility
export const ARENA_ABI = [
  // Read functions
  "function taskCount() view returns (uint256)",
  "function getTask(uint256) view returns ((address, address, uint256, uint256, uint256, uint256, uint256, uint256, uint8, uint8, bytes32, string))",
  "function getAssignment(uint256) view returns ((address, uint256, uint256, uint256, uint256, bytes32))",
  "function getAgentStats(address) view returns (uint256, uint256, uint256, uint256, bool)",
  "function getTaskBidders(uint256) view returns (address[])",
  "function getTaskVerifiers(uint256) view returns (address[])",
  "function getBid(uint256, address) view returns ((bytes32, bool, address, uint256, uint256, uint256))",
  "function getVerifications(uint256) view returns ((address, uint256, uint8, bytes32)[])",
  "function protocolTreasury() view returns (uint256)",

  // Write functions
  "function createTask(uint256, uint256, uint256, uint256, uint256, uint8, bytes32, string, address) returns (uint256)",
  "function cancelTask(uint256)",
  "function commitBid(uint256, bytes32, bytes32)",
  "function revealBid(uint256, uint256, uint256, uint256, bytes32)",
  "function resolveAuction(uint256)",
  "function deliverTask(uint256, bytes32)",

  // Events
  "event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)",
  "event BidCommitted(uint256 indexed taskId, address indexed agent, bytes32 commitHash, bytes32 criteriaAckHash)",
  "event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price)",
  "event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)",
  "event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)",
  "event TaskCancelled(uint256 indexed taskId)",
];

// ERC20 ABI for token approval
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Contract addresses — update after deployment
// 3-contract split: arenaCore (Main) + arenaCoreAuction
export const CONTRACTS = {
  // Base Sepolia testnet
  84532: {
    arenaCore: process.env.NEXT_PUBLIC_ARENA_CORE_MAIN_ADDRESS || process.env.NEXT_PUBLIC_ARENA_CORE_ADDRESS || '0x0000000000000000000000000000000000000000',
    arenaCoreAuction: process.env.NEXT_PUBLIC_ARENA_CORE_AUCTION_ADDRESS || '0x0000000000000000000000000000000000000000',
    usdc: process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS || '0x0000000000000000000000000000000000000000',
  },
  // Base mainnet
  8453: {
    arenaCore: '0x0000000000000000000000000000000000000000',
    arenaCoreAuction: '0x0000000000000000000000000000000000000000',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  },
  // Hardhat local
  31337: {
    arenaCore: process.env.NEXT_PUBLIC_ARENA_CORE_MAIN_ADDRESS || process.env.NEXT_PUBLIC_ARENA_CORE_ADDRESS || '0x0000000000000000000000000000000000000000',
    arenaCoreAuction: process.env.NEXT_PUBLIC_ARENA_CORE_AUCTION_ADDRESS || '0x0000000000000000000000000000000000000000',
    usdc: process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS || '0x0000000000000000000000000000000000000000',
  },
};
