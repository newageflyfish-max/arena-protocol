/**
 * The Arena — Custom Hooks for Contract Interaction
 *
 * Provides React hooks for reading/writing ArenaCore contract data.
 * All data comes from on-chain reads. No mock data in hooks.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAccount, useChainId, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits, formatUnits, keccak256, encodePacked, stringToHex } from 'viem';
import { ARENA_ABI, ERC20_ABI, CONTRACTS } from './wagmi';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ═══════════════════════════════════════════════════
// IPFS / PINATA INTEGRATION
// ═══════════════════════════════════════════════════

async function pinCriteriaToIPFS(criteria) {
  const apiKey = process.env.NEXT_PUBLIC_PINATA_API_KEY;
  const apiSecret = process.env.NEXT_PUBLIC_PINATA_SECRET;
  if (!apiKey || !apiSecret) return null;

  try {
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'pinata_api_key': apiKey,
        'pinata_secret_api_key': apiSecret,
      },
      body: JSON.stringify({
        pinataContent: criteria,
        pinataMetadata: { name: `arena-criteria-${criteria.taskType || 'unknown'}` },
      }),
    });
    if (!response.ok) return null;
    const result = await response.json();
    return result.IpfsHash;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════
// CONTRACT ADDRESS HELPER
// ═══════════════════════════════════════════════════

export function useContracts() {
  const chainId = useChainId();
  const contracts = CONTRACTS[chainId] || CONTRACTS[84532];
  return {
    arenaAddress: contracts.arenaCore,
    auctionAddress: contracts.arenaCoreAuction,
    usdcAddress: contracts.usdc,
    isConfigured: contracts.arenaCore !== ZERO_ADDRESS,
  };
}

// ═══════════════════════════════════════════════════
// STATUS HELPERS
// ═══════════════════════════════════════════════════

const STATUS_MAP = ['open', 'bid_reveal', 'assigned', 'delivered', 'verifying', 'completed', 'failed', 'disputed', 'cancelled'];

function mapStatus(statusNum) {
  return STATUS_MAP[Number(statusNum)] || 'open';
}

// ═══════════════════════════════════════════════════
// TASK READING HOOKS
// ═══════════════════════════════════════════════════

export function useTaskCount() {
  const { arenaAddress } = useContracts();
  const { data, isLoading, refetch } = useReadContract({
    address: arenaAddress,
    abi: [{ name: 'taskCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'taskCount',
  });
  return { count: data ? Number(data) : 0, isLoading, refetch };
}

/**
 * Read tasks enriched with bid counts, assignment data, and verification counts.
 * Batches 4 calls per task (getTask, getTaskBidders, getAssignment, getTaskVerifiers).
 */
export function useTasks(limit = 20) {
  const { arenaAddress, isConfigured } = useContracts();
  const { count } = useTaskCount();
  const [tasks, setTasks] = useState([]);
  const { isConnected } = useAccount();

  const CALLS_PER_TASK = 4;
  const start = Math.max(0, count - limit);
  const taskIds = useMemo(() => {
    const ids = [];
    for (let i = start; i < count; i++) ids.push(i);
    return ids;
  }, [start, count]);

  const allCalls = useMemo(() => {
    const calls = [];
    for (const id of taskIds) {
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getTask', args: [BigInt(id)] });
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getTaskBidders', args: [BigInt(id)] });
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getAssignment', args: [BigInt(id)] });
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getTaskVerifiers', args: [BigInt(id)] });
    }
    return calls;
  }, [arenaAddress, taskIds]);

  const enabled = isConnected && isConfigured && allCalls.length > 0;
  const { data: batchResults, isLoading: loading, error: batchError } = useReadContracts({ contracts: allCalls, query: { enabled } });

  useEffect(() => {
    if (!batchResults) return;
    const formatted = [];
    for (let i = 0; i < taskIds.length; i++) {
      const taskResult = batchResults[i * CALLS_PER_TASK];
      const biddersResult = batchResults[i * CALLS_PER_TASK + 1];
      const assignmentResult = batchResults[i * CALLS_PER_TASK + 2];
      const verifiersResult = batchResults[i * CALLS_PER_TASK + 3];
      if (!taskResult || taskResult.status !== 'success') continue;

      const t = taskResult.result;
      let bidCount = 0;
      if (biddersResult && biddersResult.status === 'success' && Array.isArray(biddersResult.result)) {
        bidCount = biddersResult.result.length;
      }

      let agentDisplay = null, agentAddress = null, agentStake = null;
      if (assignmentResult && assignmentResult.status === 'success') {
        const a = assignmentResult.result;
        if (a[0] && a[0] !== ZERO_ADDRESS) {
          agentAddress = a[0];
          agentDisplay = `${a[0].slice(0, 6)}...${a[0].slice(-4)}`;
          agentStake = formatUnits(a[1] ?? 0n, 6);
        }
      }

      let verifiedCount = 0;
      if (verifiersResult && verifiersResult.status === 'success' && Array.isArray(verifiersResult.result)) {
        verifiedCount = verifiersResult.result.length;
      }

      const numericId = taskIds[i];
      formatted.push({
        id: `0x${numericId.toString(16).padStart(2, '0')}`,
        _numericId: numericId,
        poster: `${t[0].slice(0, 6)}...${t[0].slice(-4)}`,
        posterFull: t[0],
        type: t[11],
        bounty: formatUnits(t[2], 6),
        status: mapStatus(t[9]),
        deadline: Number(t[3]) * 1000,
        bids: bidCount,
        agent: agentDisplay,
        agentAddress,
        stake: agentStake,
        verifiers: Number(t[8]),
        verified: verifiedCount,
        created: Number(t[5]) * 1000,
        bidDeadline: Number(t[6]),
        revealDeadline: Number(t[7]),
        criteriaHash: t[10],
      });
    }
    formatted.reverse();
    setTasks(formatted);
  }, [batchResults, taskIds]);

  return { tasks, loading, isLive: isConnected && isConfigured, error: batchError };
}

/**
 * Protocol stats derived from on-chain data.
 * Reads every task + assignment to compute totalSettled, totalSlashed, activeAgents.
 */
export function useProtocolStats() {
  const { arenaAddress, isConfigured } = useContracts();
  const { count } = useTaskCount();
  const { isConnected } = useAccount();

  const { data: treasury } = useReadContract({
    address: arenaAddress,
    abi: [{ name: 'protocolTreasury', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
    functionName: 'protocolTreasury',
    query: { enabled: isConnected && isConfigured },
  });

  // Batch: getTask + getAssignment for each task
  const taskIds = useMemo(() => { const ids = []; for (let i = 0; i < count; i++) ids.push(i); return ids; }, [count]);
  const batchCalls = useMemo(() => {
    const calls = [];
    for (const id of taskIds) {
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getTask', args: [BigInt(id)] });
      calls.push({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getAssignment', args: [BigInt(id)] });
    }
    return calls;
  }, [arenaAddress, taskIds]);
  const { data: batchResults } = useReadContracts({ contracts: batchCalls, query: { enabled: isConnected && isConfigured && batchCalls.length > 0 } });

  const stats = useMemo(() => {
    if (!isConnected || !isConfigured) return null;
    let activeTasks = 0;
    let totalSettledWei = 0n;
    let totalSlashedWei = 0n;
    const activeStatuses = new Set([0, 1, 2, 3, 4]); // Open, BidReveal, Assigned, Delivered, Verifying
    const uniqueAgents = new Set();

    if (batchResults) {
      for (let i = 0; i < taskIds.length; i++) {
        const taskRes = batchResults[i * 2];
        const assignRes = batchResults[i * 2 + 1];
        if (!taskRes || taskRes.status !== 'success') continue;

        const t = taskRes.result;
        const status = Number(t[9]);
        const bounty = t[2]; // uint256

        if (activeStatuses.has(status)) activeTasks++;

        // Track unique assigned agents
        if (assignRes && assignRes.status === 'success') {
          const agentAddr = assignRes.result[0];
          const price = assignRes.result[2];
          if (agentAddr && agentAddr !== ZERO_ADDRESS) {
            if (activeStatuses.has(status)) uniqueAgents.add(agentAddr.toLowerCase());
            // Completed (5): agent was paid their price
            if (status === 5) totalSettledWei += price;
          }
        }

        // Failed (6): bounty was redistributed/slashed
        if (status === 6) totalSlashedWei += bounty;
      }
    }
    return {
      totalTasks: count,
      activeTasks,
      totalSettled: formatUnits(totalSettledWei, 6),
      totalSlashed: formatUnits(totalSlashedWei, 6),
      protocolRevenue: treasury ? formatUnits(treasury, 6) : '0',
      activeAgents: uniqueAgents.size,
    };
  }, [isConnected, isConfigured, count, batchResults, treasury, taskIds]);

  return stats;
}

// ═══════════════════════════════════════════════════
// AGENT PROFILE HOOK
// ═══════════════════════════════════════════════════

export function useAgentProfile() {
  const { arenaAddress, isConfigured } = useContracts();
  const { address, isConnected } = useAccount();

  const { data: stats, isLoading: statsLoading, error: statsError } = useReadContract({
    address: arenaAddress, abi: ARENA_ABI, functionName: 'getAgentStats',
    args: address ? [address] : undefined,
    query: { enabled: isConnected && isConfigured && !!address },
  });

  if (!isConnected || !isConfigured || !stats) return { profile: null, isLoading: statsLoading, error: statsError || null };

  const completed = Number(stats[1] || 0);
  const failed = Number(stats[2] || 0);
  return {
    profile: {
      address,
      displayAddress: `${address.slice(0, 6)}...${address.slice(-4)}`,
      reputation: Number(stats[0] || 0),
      completed,
      failed,
      activeStake: formatUnits(stats[3] || 0n, 6),
      banned: stats[4] || false,
      successRate: (completed + failed) > 0 ? ((completed / (completed + failed)) * 100).toFixed(1) : '0.0',
    },
    isLoading: statsLoading,
    error: statsError || null,
  };
}

/**
 * Read tasks assigned to the connected wallet
 */
export function useMyTasks() {
  const { arenaAddress, isConfigured } = useContracts();
  const { address, isConnected } = useAccount();
  const { count } = useTaskCount();
  const [myTasks, setMyTasks] = useState([]);

  const taskIds = useMemo(() => { const ids = []; for (let i = 0; i < count; i++) ids.push(i); return ids; }, [count]);
  const assignmentCalls = useMemo(() => taskIds.map(id => ({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getAssignment', args: [BigInt(id)] })), [arenaAddress, taskIds]);
  const taskCalls = useMemo(() => taskIds.map(id => ({ address: arenaAddress, abi: ARENA_ABI, functionName: 'getTask', args: [BigInt(id)] })), [arenaAddress, taskIds]);

  const { data: assignmentResults, isLoading: assignmentsLoading } = useReadContracts({ contracts: assignmentCalls, query: { enabled: isConnected && isConfigured && assignmentCalls.length > 0 } });
  const { data: taskResults, isLoading: tasksLoading } = useReadContracts({ contracts: taskCalls, query: { enabled: isConnected && isConfigured && taskCalls.length > 0 } });

  useEffect(() => {
    if (!assignmentResults || !taskResults || !address) return;
    const assigned = [];
    for (let i = 0; i < assignmentResults.length; i++) {
      const aR = assignmentResults[i], tR = taskResults[i];
      if (aR.status !== 'success' || tR.status !== 'success') continue;
      const a = aR.result, t = tR.result;
      if (a[0] && a[0].toLowerCase() === address.toLowerCase() && a[0] !== ZERO_ADDRESS) {
        assigned.push({
          id: `0x${i.toString(16).padStart(2, '0')}`, _numericId: i,
          type: t[11], bounty: formatUnits(t[2], 6), status: mapStatus(t[9]),
          deadline: Number(t[3]) * 1000, stake: formatUnits(a[1] ?? 0n, 6),
          price: formatUnits(a[2] ?? 0n, 6), assignedAt: Number(a[3] ?? 0) * 1000,
          deliveredAt: Number(a[4] ?? 0) * 1000, poster: `${t[0].slice(0, 6)}...${t[0].slice(-4)}`,
        });
      }
    }
    setMyTasks(assigned.reverse());
  }, [assignmentResults, taskResults, address]);

  return { myTasks, isLive: isConnected && isConfigured, loading: assignmentsLoading || tasksLoading };
}

// ═══════════════════════════════════════════════════
// WRITE HOOKS
// ═══════════════════════════════════════════════════

/**
 * Create a task: approve → createTask (two-step)
 */
export function useCreateTask() {
  const { arenaAddress, usdcAddress } = useContracts();
  const { writeContract: writeApprove, data: approveHash, isPending: approvePending, error: approveError } = useWriteContract();
  const { writeContract: writeCreate, data: createHash, isPending: createPending, error: createError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: createConfirming, isSuccess: createSuccess } = useWaitForTransactionReceipt({ hash: createHash });
  const [step, setStep] = useState('idle');
  const pendingTaskRef = useRef(null);

  const createTask = useCallback(async ({ bounty, deadline, slashWindow, bidDuration, revealDuration, requiredVerifiers, taskType, criteria }) => {
    const bountyWei = parseUnits(bounty, 6);
    const now = Math.floor(Date.now() / 1000);
    const criteriaJSON = { version: 1, ...criteria };
    const criteriaHash = keccak256(stringToHex(JSON.stringify(criteriaJSON)));
    // Pin to IPFS in background (non-blocking on failure)
    const cid = await pinCriteriaToIPFS(criteriaJSON);
    if (cid) {
      localStorage.setItem(`arena-cid-${criteriaHash}`, cid);
    }
    pendingTaskRef.current = {
      bountyWei,
      deadlineTs: BigInt(now + parseDurationSeconds(deadline)),
      slashWindowSec: BigInt(parseDurationSeconds(slashWindow)),
      bidDurationSec: BigInt(parseDurationSeconds(bidDuration || '1h')),
      revealDurationSec: BigInt(parseDurationSeconds(revealDuration || '30m')),
      numVerifiers: requiredVerifiers || 2,
      criteriaHash,
      taskType: taskType || 'custom',
    };
    try {
      setStep('approving');
      writeApprove({ address: usdcAddress, abi: ERC20_ABI, functionName: 'approve', args: [arenaAddress, bountyWei] });
    } catch { setStep('error'); }
  }, [arenaAddress, usdcAddress, writeApprove]);

  useEffect(() => {
    if (approveSuccess && step === 'approving' && pendingTaskRef.current) {
      const p = pendingTaskRef.current;
      setStep('creating');
      try {
        writeCreate({ address: arenaAddress, abi: ARENA_ABI, functionName: 'createTask',
          args: [p.bountyWei, p.deadlineTs, p.slashWindowSec, p.bidDurationSec, p.revealDurationSec, p.numVerifiers, p.criteriaHash, p.taskType, usdcAddress] });
      } catch { setStep('error'); }
    }
  }, [approveSuccess, step, arenaAddress, usdcAddress, writeCreate]);

  useEffect(() => { if (createSuccess && step === 'creating') { setStep('done'); pendingTaskRef.current = null; } }, [createSuccess, step]);
  useEffect(() => { if (approveError && step === 'approving') setStep('error'); }, [approveError, step]);
  useEffect(() => { if (createError && step === 'creating') setStep('error'); }, [createError, step]);

  return { createTask, step, isPending: approvePending || createPending, isConfirming: approveConfirming || createConfirming, isSuccess: createSuccess, error: approveError || createError, hash: createHash || approveHash };
}

/**
 * Full commit-reveal bid flow: commitBid → approve → revealBid
 * Note: Approval moved to reveal step. Commit is gasless (no token transfer),
 * so approving at commit time leaves a dangling allowance if reveal never happens.
 * Approve only the exact stake amount right before revealBid pulls the tokens.
 */
export function useBidFlow() {
  const { arenaAddress, auctionAddress, usdcAddress } = useContracts();
  const { address } = useAccount();
  const { writeContract: writeApprove, data: approveHash, isPending: approvePending, error: approveError } = useWriteContract();
  const { writeContract: writeCommit, data: commitHashTx, isPending: commitPending, error: commitError } = useWriteContract();
  const { writeContract: writeReveal, data: revealHash, isPending: revealPending, error: revealError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: commitConfirming, isSuccess: commitSuccess } = useWaitForTransactionReceipt({ hash: commitHashTx });
  const { isLoading: revealConfirming, isSuccess: revealSuccess } = useWaitForTransactionReceipt({ hash: revealHash });
  const [step, setStep] = useState('idle');
  const pendingRevealRef = useRef(null);
  const STORAGE_KEY = 'arena-bids';

  const getStoredBids = useCallback(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } }, []);
  const storeBid = useCallback((taskId, bidData) => { const bids = getStoredBids(); bids[`${taskId}-${address}`] = bidData; localStorage.setItem(STORAGE_KEY, JSON.stringify(bids)); }, [address, getStoredBids]);
  const getStoredBid = useCallback((taskId) => { const bids = getStoredBids(); return bids[`${taskId}-${address}`] || null; }, [address, getStoredBids]);

  // Step 1: Commit bid (no token transfer, no approval needed)
  // criteriaAckHash proves agent read & accepted the task criteria before bidding
  const commitBid = useCallback(({ taskId, stake, price, eta, criteriaAckHash }) => {
    if (!address) return;
    const stakeWei = parseUnits(stake, 6);
    const salt = keccak256(stringToHex(`${Date.now()}-${Math.random()}-${address}`));
    const commitHashValue = keccak256(encodePacked(['address', 'uint256', 'uint256', 'uint256', 'bytes32'], [address, stakeWei, parseUnits(price, 6), BigInt(Math.floor(parseDurationSeconds(eta))), salt]));
    storeBid(taskId, { taskId, stake, price, eta, salt, commitHash: commitHashValue, criteriaAckHash, committedAt: Date.now(), revealed: false });
    try { setStep('committing'); writeCommit({ address: auctionAddress, abi: ARENA_ABI, functionName: 'commitBid', args: [BigInt(taskId), commitHashValue, criteriaAckHash] }); } catch { setStep('error'); }
  }, [address, arenaAddress, writeCommit, storeBid]);

  useEffect(() => { if (commitSuccess && step === 'committing') { setStep('committed'); } }, [commitSuccess, step]);

  const submitCommit = useCallback((taskId) => {
    const bid = getStoredBid(taskId);
    if (!bid) return;
    try { setStep('committing'); writeCommit({ address: auctionAddress, abi: ARENA_ABI, functionName: 'commitBid', args: [BigInt(taskId), bid.commitHash, bid.criteriaAckHash] }); } catch { setStep('error'); }
  }, [arenaAddress, writeCommit, getStoredBid]);

  // Step 2: Reveal bid (approve exact stake amount → then reveal)
  const revealBid = useCallback((taskId) => {
    const bid = getStoredBid(taskId);
    if (!bid) return;
    const stakeWei = parseUnits(bid.stake, 6);
    pendingRevealRef.current = { taskId, bid };
    try { setStep('approving'); writeApprove({ address: usdcAddress, abi: ERC20_ABI, functionName: 'approve', args: [auctionAddress, stakeWei] }); } catch { setStep('error'); }
  }, [auctionAddress, usdcAddress, writeApprove, getStoredBid]);

  // After approval succeeds, submit the reveal transaction
  useEffect(() => {
    if (approveSuccess && step === 'approving' && pendingRevealRef.current) {
      const { taskId, bid } = pendingRevealRef.current;
      setStep('revealing');
      try { writeReveal({ address: auctionAddress, abi: ARENA_ABI, functionName: 'revealBid', args: [BigInt(taskId), parseUnits(bid.stake, 6), parseUnits(bid.price, 6), BigInt(Math.floor(parseDurationSeconds(bid.eta))), bid.salt] }); } catch { setStep('error'); }
    }
  }, [approveSuccess, step, auctionAddress, writeReveal]);

  useEffect(() => { if (revealSuccess && step === 'revealing') { setStep('revealed'); pendingRevealRef.current = null; } }, [revealSuccess, step]);
  useEffect(() => { if (approveError && step === 'approving') setStep('error'); }, [approveError, step]);
  useEffect(() => { if (commitError && step === 'committing') setStep('error'); }, [commitError, step]);
  useEffect(() => { if (revealError && step === 'revealing') setStep('error'); }, [revealError, step]);

  return {
    commitBid, submitCommit, revealBid, getStoredBid, step, setStep,
    isPending: approvePending || commitPending || revealPending,
    isConfirming: approveConfirming || commitConfirming || revealConfirming,
    isSuccess: commitSuccess || revealSuccess,
    error: approveError || commitError || revealError,
    hash: revealHash || commitHashTx || approveHash,
  };
}

// ═══════════════════════════════════════════════════
// CRITERIA RETRIEVAL FROM IPFS
// ═══════════════════════════════════════════════════

export function useCriteriaFromIPFS(criteriaHash) {
  const [criteria, setCriteria] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!criteriaHash) { setLoading(false); return; }

    const cid = localStorage.getItem(`arena-cid-${criteriaHash}`);
    if (!cid) { setLoading(false); return; }

    const gateway = process.env.NEXT_PUBLIC_IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';
    fetch(`${gateway}${cid}`)
      .then(r => r.ok ? r.json() : Promise.reject('IPFS fetch failed'))
      .then(data => { setCriteria(data); setLoading(false); })
      .catch(e => { setError(e); setLoading(false); });
  }, [criteriaHash]);

  return { criteria, loading, error };
}

// ═══════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════

function parseDurationSeconds(duration) {
  const match = duration.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) return 3600;
  const value = parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return Math.floor(value);
    case 'm': return Math.floor(value * 60);
    case 'h': return Math.floor(value * 3600);
    case 'd': return Math.floor(value * 86400);
    default: return 3600;
  }
}
