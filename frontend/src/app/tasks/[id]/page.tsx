'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { keccak256, encodePacked, toHex } from 'viem';
import {
  ADDRESSES,
  ARENA_CORE_MAIN_ABI,
  ARENA_CORE_AUCTION_ABI,
  ARENA_CORE_VRF_ABI,
  ERC20_ABI,
  TASK_STATUS_LABELS,
  VERIFIER_VOTES,
  VERIFIER_VOTE_LABELS,
} from '@/lib/contracts';
import { StatusBadge } from '@/components/StatusBadge';
import {
  truncateAddress,
  formatUSDC,
  formatTimestamp,
  timeRemaining,
} from '@/lib/utils';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

interface TimelineStep {
  label: string;
  reached: boolean;
  timestamp?: string;
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const taskId = BigInt(params.id as string);

  const { data: taskData, isLoading: loadingTask } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'getTask',
    args: [taskId],
  });

  const { data: assignmentData, isLoading: loadingAssignment } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'getAssignment',
    args: [taskId],
  });

  const task = taskData as
    | {
        poster: string;
        token: string;
        bounty: bigint;
        deadline: bigint;
        slashWindow: bigint;
        createdAt: bigint;
        bidDeadline: bigint;
        revealDeadline: bigint;
        requiredVerifiers: number;
        status: number;
        criteriaHash: string;
        taskType: string;
      }
    | undefined;

  const assignment = assignmentData as
    | {
        agent: string;
        stake: bigint;
        price: bigint;
        assignedAt: bigint;
        deliveredAt: bigint;
        outputHash: string;
      }
    | undefined;

  const status = task ? Number(task.status) : 0;
  const hasAssignment =
    assignment && assignment.agent !== ZERO_ADDRESS;

  // Build timeline steps
  const buildTimeline = (): TimelineStep[] => {
    if (!task) return [];

    const steps: TimelineStep[] = [
      {
        label: 'Created',
        reached: true,
        timestamp: formatTimestamp(task.createdAt),
      },
      {
        label: 'Bid Phase',
        reached: status >= 1,
        timestamp:
          status >= 1
            ? formatTimestamp(task.bidDeadline)
            : undefined,
      },
      {
        label: 'Assigned',
        reached: status >= 2,
        timestamp:
          hasAssignment
            ? formatTimestamp(assignment.assignedAt)
            : undefined,
      },
      {
        label: 'Delivered',
        reached: status >= 3,
        timestamp:
          hasAssignment && assignment.deliveredAt > BigInt(0)
            ? formatTimestamp(assignment.deliveredAt)
            : undefined,
      },
      {
        label: 'Verified',
        reached: status >= 4,
      },
      {
        label: status === 6 ? 'Failed' : status === 8 ? 'Cancelled' : 'Completed',
        reached: status >= 5,
      },
    ];

    return steps;
  };

  const timeline = buildTimeline();

  if (loadingTask) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="space-y-4">
          <div className="h-8 w-48 bg-navy-800 rounded animate-pulse" />
          <div className="h-64 bg-navy-800 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <p className="text-zinc-400">Task not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Back button + Title */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => router.push('/tasks')}
          className="text-sm text-zinc-400 hover:text-white transition-colors"
        >
          &larr; Back to Tasks
        </button>
        <h1 className="text-xl font-mono font-bold text-white uppercase tracking-wide">
          Task #{params.id as string}
        </h1>
        <StatusBadge status={status} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Left: Task Details */}
        <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-4">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
            Task Details
          </h2>

          <DetailRow label="Task ID" value={`#${taskId.toString()}`} mono />
          <DetailRow label="Type" value={task.taskType} />
          <DetailRow label="Bounty" value={formatUSDC(task.bounty)} mono green />
          <DetailRow label="Poster" value={truncateAddress(task.poster)} mono />
          <DetailRow
            label="Status"
            value={TASK_STATUS_LABELS[status] ?? 'Unknown'}
          />
          <DetailRow
            label="Criteria Hash"
            value={truncateAddress(task.criteriaHash)}
            mono
          />
          <DetailRow
            label="Created"
            value={formatTimestamp(task.createdAt)}
            mono
          />
          <DetailRow
            label="Deadline"
            value={`${formatTimestamp(task.deadline)} (${timeRemaining(task.deadline)})`}
            mono
          />
          <DetailRow
            label="Bid Deadline"
            value={formatTimestamp(task.bidDeadline)}
            mono
          />
          <DetailRow
            label="Reveal Deadline"
            value={formatTimestamp(task.revealDeadline)}
            mono
          />
          <DetailRow
            label="Required Verifiers"
            value={task.requiredVerifiers.toString()}
            mono
          />
          <DetailRow
            label="Slash Window"
            value={`${Number(task.slashWindow) / 3600}h`}
            mono
          />
        </div>

        {/* Right: Assignment */}
        <div className="bg-navy-900 border border-zinc-800 rounded p-6">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
            Assignment
          </h2>

          {loadingAssignment ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-6 bg-navy-800 rounded animate-pulse"
                />
              ))}
            </div>
          ) : hasAssignment ? (
            <div className="space-y-4">
              <DetailRow
                label="Agent"
                value={truncateAddress(assignment.agent)}
                mono
              />
              <DetailRow
                label="Stake"
                value={formatUSDC(assignment.stake)}
                mono
              />
              <DetailRow
                label="Price"
                value={formatUSDC(assignment.price)}
                mono
                green
              />
              <DetailRow
                label="Assigned At"
                value={formatTimestamp(assignment.assignedAt)}
                mono
              />
              <DetailRow
                label="Delivered At"
                value={
                  assignment.deliveredAt > BigInt(0)
                    ? formatTimestamp(assignment.deliveredAt)
                    : '--'
                }
                mono
              />
              <DetailRow
                label="Output Hash"
                value={
                  assignment.outputHash !== ZERO_BYTES32
                    ? truncateAddress(assignment.outputHash)
                    : '--'
                }
                mono
              />
            </div>
          ) : (
            <p className="text-zinc-500 text-sm">
              No agent assigned yet.
            </p>
          )}
        </div>
      </div>

      {/* Lifecycle Timeline */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6">
        <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-6">
          Lifecycle Timeline
        </h2>

        <div className="relative">
          {timeline.map((step, idx) => (
            <div key={step.label} className="flex items-start gap-4 mb-6 last:mb-0">
              {/* Dot + Line */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-3 h-3 rounded-full border-2 ${
                    step.reached
                      ? 'bg-arena-green border-arena-green'
                      : 'bg-navy-950 border-zinc-600'
                  }`}
                />
                {idx < timeline.length - 1 && (
                  <div
                    className={`w-0.5 h-8 ${
                      step.reached ? 'bg-arena-green/40' : 'bg-zinc-700'
                    }`}
                  />
                )}
              </div>

              {/* Content */}
              <div className="-mt-0.5">
                <p
                  className={`text-sm font-medium ${
                    step.reached ? 'text-white' : 'text-zinc-600'
                  }`}
                >
                  {step.label}
                </p>
                {step.timestamp && (
                  <p className="text-xs font-mono text-zinc-500 mt-0.5">
                    {step.timestamp}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Action Panels ── */}
      {isConnected && (
        <div className="mt-8 space-y-6">
          {/* Commit Bid (status 0 = Open) */}
          {status === 0 && <CommitBidPanel taskId={taskId} />}

          {/* Reveal Bid (status 1 = BidReveal) */}
          {status === 1 && <RevealBidPanel taskId={taskId} />}

          {/* Resolve Auction (status 1, after reveal deadline) */}
          {status === 1 && task && Number(task.revealDeadline) * 1000 < Date.now() && (
            <ResolveAuctionPanel taskId={taskId} />
          )}

          {/* Deliver Task (status 2 = Assigned, only for assigned agent) */}
          {status === 2 && hasAssignment && address === assignment.agent && (
            <DeliverTaskPanel taskId={taskId} />
          )}

          {/* Register Verifier (status 3 = Delivered) */}
          {status === 3 && <RegisterVerifierPanel taskId={taskId} />}

          {/* Submit Verification (status 4 = Verifying) */}
          {status === 4 && <SubmitVerificationPanel taskId={taskId} />}

          {/* Enforce Deadline */}
          {(status === 2 || status === 3) && task && Number(task.deadline) * 1000 < Date.now() && (
            <EnforceDeadlinePanel taskId={taskId} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: detail row
// ---------------------------------------------------------------------------
function DetailRow({
  label,
  value,
  mono,
  green,
}: {
  label: string;
  value: string;
  mono?: boolean;
  green?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs uppercase tracking-wider text-zinc-500 shrink-0">
        {label}
      </span>
      <span
        className={`text-sm text-right break-all ${mono ? 'font-mono' : ''} ${
          green ? 'text-arena-green' : 'text-zinc-200'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action Panel wrapper
// ---------------------------------------------------------------------------
function ActionPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-navy-900 border border-arena-blue/30 rounded p-6">
      <h2 className="text-sm font-mono font-semibold text-arena-blue uppercase tracking-wide mb-4">
        {title}
      </h2>
      {children}
    </div>
  );
}

function ActionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mt-3 bg-arena-red/10 border border-arena-red/30 rounded p-3">
      <p className="text-arena-red text-xs break-all">{error}</p>
    </div>
  );
}

function ActionSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-3 bg-arena-green/10 border border-arena-green/30 rounded p-3">
      <p className="text-arena-green text-xs">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit Bid Panel
// ---------------------------------------------------------------------------
function CommitBidPanel({ taskId }: { taskId: bigint }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [stake, setStake] = useState('');
  const [price, setPrice] = useState('');
  const [eta, setEta] = useState('24');
  const [salt, setSalt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleCommit = async () => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const stakeWei = BigInt(Math.round(parseFloat(stake) * 1e6));
      const priceWei = BigInt(Math.round(parseFloat(price) * 1e6));
      const etaSeconds = BigInt(Math.round(parseFloat(eta) * 3600));
      const saltBytes = salt
        ? (salt as `0x${string}`)
        : toHex(crypto.getRandomValues(new Uint8Array(32)));

      // commitHash = keccak256(abi.encodePacked(msg.sender, stake, price, eta, salt))
      const commitHash = keccak256(
        encodePacked(
          ['address', 'uint256', 'uint256', 'uint256', 'bytes32'],
          [address as `0x${string}`, stakeWei, priceWei, etaSeconds, saltBytes as `0x${string}`]
        )
      );

      // criteriaAckHash — just hash the task's criteria hash for acknowledgment
      const criteriaAckHash = keccak256(
        encodePacked(['uint256'], [taskId])
      );

      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'commitBid',
        args: [taskId, commitHash, criteriaAckHash],
      });

      setSuccess(`Bid committed! Save your salt: ${saltBytes}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Commit Bid (Agent)">
      <p className="text-xs text-zinc-500 mb-4">
        Submit a sealed bid. You will reveal it in the next phase.
      </p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Stake (USDC)</label>
          <input
            type="number"
            step="0.01"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder="10.00"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Price (USDC)</label>
          <input
            type="number"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="50.00"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">ETA (hours)</label>
          <input
            type="number"
            step="1"
            value={eta}
            onChange={(e) => setEta(e.target.value)}
            placeholder="24"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
          />
        </div>
      </div>
      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1">Salt (auto-generated if empty)</label>
        <input
          type="text"
          value={salt}
          onChange={(e) => setSalt(e.target.value)}
          placeholder="0x... (optional)"
          className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
        />
      </div>
      <button
        onClick={handleCommit}
        disabled={submitting || !stake || !price}
        className="w-full bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Committing...' : 'Commit Bid'}
      </button>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Reveal Bid Panel
// ---------------------------------------------------------------------------
function RevealBidPanel({ taskId }: { taskId: bigint }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [stake, setStake] = useState('');
  const [price, setPrice] = useState('');
  const [eta, setEta] = useState('');
  const [salt, setSalt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const stakeWei = stake ? BigInt(Math.round(parseFloat(stake) * 1e6)) : BigInt(0);

  // Check allowance
  const { data: allowance } = useReadContract({
    address: ADDRESSES.MockUSDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, ADDRESSES.ArenaCoreAuction] : undefined,
    query: { enabled: !!address },
  });

  const needsApproval = allowance !== undefined && stakeWei > (allowance as bigint);

  const handleApprove = async () => {
    setApproving(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.MockUSDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.ArenaCoreAuction, stakeWei],
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  const handleReveal = async () => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const stakeVal = BigInt(Math.round(parseFloat(stake) * 1e6));
      const priceVal = BigInt(Math.round(parseFloat(price) * 1e6));
      const etaVal = BigInt(Math.round(parseFloat(eta) * 3600));

      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'revealBid',
        args: [taskId, stakeVal, priceVal, etaVal, salt as `0x${string}`],
      });

      setSuccess('Bid revealed successfully!');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Reveal Bid (Agent)">
      <p className="text-xs text-zinc-500 mb-4">
        Reveal your sealed bid with the original values and salt. USDC stake will be transferred.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Stake (USDC)</label>
          <input type="number" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="10.00"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Price (USDC)</label>
          <input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="50.00"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">ETA (hours)</label>
          <input type="number" step="1" value={eta} onChange={(e) => setEta(e.target.value)} placeholder="24"
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none" />
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Salt</label>
          <input type="text" value={salt} onChange={(e) => setSalt(e.target.value)} placeholder="0x..."
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none" />
        </div>
      </div>
      <div className="flex gap-3">
        {needsApproval && (
          <button
            onClick={handleApprove}
            disabled={approving}
            className="flex-1 bg-arena-amber text-black font-medium py-2.5 rounded text-sm hover:bg-arena-amber/90 transition-colors disabled:opacity-50"
          >
            {approving ? 'Approving...' : 'Approve USDC'}
          </button>
        )}
        <button
          onClick={handleReveal}
          disabled={submitting || !stake || !price || !salt || needsApproval}
          className="flex-1 bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
        >
          {submitting ? 'Revealing...' : 'Reveal Bid'}
        </button>
      </div>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Resolve Auction Panel
// ---------------------------------------------------------------------------
function ResolveAuctionPanel({ taskId }: { taskId: bigint }) {
  const { writeContractAsync } = useWriteContract();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleResolve = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'resolveAuction',
        args: [taskId],
      });
      setSuccess('Auction resolved! Agent assigned.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Resolve Auction">
      <p className="text-xs text-zinc-500 mb-4">
        Reveal phase is over. Resolve the auction to assign the winning agent.
      </p>
      <button
        onClick={handleResolve}
        disabled={submitting}
        className="w-full bg-arena-green text-black font-medium py-2.5 rounded text-sm hover:bg-arena-green/90 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Resolving...' : 'Resolve Auction'}
      </button>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Deliver Task Panel
// ---------------------------------------------------------------------------
function DeliverTaskPanel({ taskId }: { taskId: bigint }) {
  const { writeContractAsync } = useWriteContract();
  const [outputHash, setOutputHash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleDeliver = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const hash = outputHash.startsWith('0x')
        ? (outputHash as `0x${string}`)
        : keccak256(toHex(outputHash));

      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'deliverTask',
        args: [taskId, hash],
      });
      setSuccess('Task delivered! Awaiting verification.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Deliver Task (Assigned Agent)">
      <p className="text-xs text-zinc-500 mb-4">
        Submit your output hash to deliver this task. Enter a bytes32 hash or plain text (will be hashed).
      </p>
      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1">Output Hash / Content</label>
        <input
          type="text"
          value={outputHash}
          onChange={(e) => setOutputHash(e.target.value)}
          placeholder="0x... or plain text"
          className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
        />
      </div>
      <button
        onClick={handleDeliver}
        disabled={submitting || !outputHash}
        className="w-full bg-purple-600 text-white font-medium py-2.5 rounded text-sm hover:bg-purple-700 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Delivering...' : 'Deliver Task'}
      </button>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Register Verifier Panel
// ---------------------------------------------------------------------------
function RegisterVerifierPanel({ taskId }: { taskId: bigint }) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [stake, setStake] = useState('5');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const stakeWei = BigInt(Math.round(parseFloat(stake || '0') * 1e6));

  const { data: allowance } = useReadContract({
    address: ADDRESSES.MockUSDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, ADDRESSES.ArenaCoreAuction] : undefined,
    query: { enabled: !!address },
  });

  const needsApproval = allowance !== undefined && stakeWei > (allowance as bigint);

  const handleApprove = async () => {
    setApproving(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.MockUSDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.ArenaCoreAuction, stakeWei],
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  const handleRegister = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'registerVerifier',
        args: [taskId, stakeWei],
      });
      setSuccess('Registered as verifier for this task!');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Register as Verifier">
      <p className="text-xs text-zinc-500 mb-4">
        Stake USDC to register as a verifier for this task.
      </p>
      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1">Verification Stake (USDC)</label>
        <input
          type="number" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="5.00"
          className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
        />
      </div>
      <div className="flex gap-3">
        {needsApproval && (
          <button onClick={handleApprove} disabled={approving}
            className="flex-1 bg-arena-amber text-black font-medium py-2.5 rounded text-sm hover:bg-arena-amber/90 transition-colors disabled:opacity-50">
            {approving ? 'Approving...' : 'Approve USDC'}
          </button>
        )}
        <button onClick={handleRegister} disabled={submitting || !stake || needsApproval}
          className="flex-1 bg-arena-amber text-black font-medium py-2.5 rounded text-sm hover:bg-arena-amber/90 transition-colors disabled:opacity-50">
          {submitting ? 'Registering...' : 'Register Verifier'}
        </button>
      </div>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Submit Verification Panel
// ---------------------------------------------------------------------------
function SubmitVerificationPanel({ taskId }: { taskId: bigint }) {
  const { writeContractAsync } = useWriteContract();
  const [vote, setVote] = useState<number>(VERIFIER_VOTES.Approve);
  const [reportHash, setReportHash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const hash = reportHash.startsWith('0x')
        ? (reportHash as `0x${string}`)
        : keccak256(toHex(reportHash || 'verification-report'));

      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'submitVerification',
        args: [taskId, vote, hash],
      });
      setSuccess('Verification submitted!');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Submit Verification">
      <p className="text-xs text-zinc-500 mb-4">
        Review the delivered work and submit your verification vote.
      </p>
      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1">Vote</label>
        <div className="flex gap-2">
          {Object.entries(VERIFIER_VOTE_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setVote(Number(key))}
              className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                vote === Number(key)
                  ? Number(key) === 0
                    ? 'bg-arena-green text-black'
                    : Number(key) === 1
                      ? 'bg-arena-red text-white'
                      : 'bg-zinc-600 text-white'
                  : 'bg-navy-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3">
        <label className="block text-xs text-zinc-500 mb-1">Report Hash (optional)</label>
        <input
          type="text" value={reportHash} onChange={(e) => setReportHash(e.target.value)}
          placeholder="0x... or plain text"
          className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full bg-arena-amber text-black font-medium py-2.5 rounded text-sm hover:bg-arena-amber/90 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Submitting...' : 'Submit Verification'}
      </button>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Enforce Deadline Panel
// ---------------------------------------------------------------------------
function EnforceDeadlinePanel({ taskId }: { taskId: bigint }) {
  const { writeContractAsync } = useWriteContract();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleEnforce = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreAuction,
        abi: ARENA_CORE_AUCTION_ABI,
        functionName: 'enforceDeadline',
        args: [taskId],
      });
      setSuccess('Deadline enforced. Agent slashed.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionPanel title="Enforce Deadline">
      <p className="text-xs text-zinc-500 mb-4">
        The task deadline has passed. Enforce it to slash the agent and return the bounty.
      </p>
      <button
        onClick={handleEnforce}
        disabled={submitting}
        className="w-full bg-arena-red text-white font-medium py-2.5 rounded text-sm hover:bg-arena-red/90 transition-colors disabled:opacity-50"
      >
        {submitting ? 'Enforcing...' : 'Enforce Deadline'}
      </button>
      <ActionError error={error} />
      <ActionSuccess message={success} />
    </ActionPanel>
  );
}
