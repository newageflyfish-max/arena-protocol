import { ethers } from 'ethers';
import { config } from './config.js';

// ─── ABIs (ethers v6 human-readable) ─────────────────────────────────────────

const ARENA_CORE_ABI = [
  'function taskCount() view returns (uint256)',
  'function getTask(uint256 _taskId) view returns (tuple(address poster, address token, uint256 bounty, uint256 deadline, uint256 slashWindow, uint256 createdAt, uint256 bidDeadline, uint256 revealDeadline, uint8 requiredVerifiers, uint8 status, bytes32 criteriaHash, string taskType))',
  'function getAssignment(uint256 _taskId) view returns (tuple(address agent, uint256 stake, uint256 price, uint256 assignedAt, uint256 deliveredAt, bytes32 outputHash))',
  'function agentReputation(address) view returns (uint256)',
  'function agentTasksCompleted(address) view returns (uint256)',
  'function agentTasksFailed(address) view returns (uint256)',
  'function agentActiveStake(address) view returns (uint256)',
  'function agentBanned(address) view returns (bool)',
  'function createTask(uint256 _bounty, uint256 _deadline, uint256 _slashWindow, uint256 _bidDuration, uint256 _revealDuration, uint8 _requiredVerifiers, bytes32 _criteriaHash, string _taskType, address _token) returns (uint256)',
  'function verifierPoolLength() view returns (uint256)',
  'function protocolTreasury(address token) view returns (uint256)',
  'event TaskCreated(uint256 indexed taskId, address indexed poster, uint256 bounty, string taskType, uint256 deadline, uint8 requiredVerifiers)',
  'event AgentAssigned(uint256 indexed taskId, address indexed agent, uint256 stake, uint256 price)',
  'event TaskDelivered(uint256 indexed taskId, address indexed agent, bytes32 outputHash)',
  'event TaskCompleted(uint256 indexed taskId, address indexed agent, uint256 payout)',
  'event AgentSlashed(uint256 indexed taskId, address indexed agent, uint256 amount, uint8 severity)',
  'event TaskCancelled(uint256 indexed taskId)',
];

const ARENA_PROFILES_ABI = [
  'function getProfile(address _user) view returns (tuple(bool exists, uint8 profileType, bytes32 avatarHash, string displayName, string bio, string websiteUrl, uint256 createdAt, uint256 updatedAt))',
  'function hasProfile(address _user) view returns (bool)',
  'function profileCount() view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ─── Provider & Contracts ────────────────────────────────────────────────────

export const provider = new ethers.JsonRpcProvider(config.rpcUrl);

export const signer = config.privateKey
  ? new ethers.Wallet(config.privateKey, provider)
  : null;

export const arenaCore = new ethers.Contract(
  config.arenaCoreAddress,
  ARENA_CORE_ABI,
  signer ?? provider,
);

export const arenaProfiles = new ethers.Contract(
  config.arenaProfilesAddress,
  ARENA_PROFILES_ABI,
  provider,
);

export const usdcToken = new ethers.Contract(
  config.usdcAddress,
  ERC20_ABI,
  signer ?? provider,
);

// ─── Profile type labels ─────────────────────────────────────────────────────

export const PROFILE_TYPE_LABELS: Record<number, string> = {
  0: 'poster',
  1: 'agent',
  2: 'verifier',
  3: 'insurer',
};

// ─── Helper: format USDC (6 decimals) ────────────────────────────────────────

export function formatUsdc(raw: bigint): string {
  return ethers.formatUnits(raw, 6);
}
