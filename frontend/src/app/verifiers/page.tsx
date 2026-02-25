'use client';

import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import {
  ADDRESSES,
  ARENA_CORE_MAIN_ABI,
  ARENA_CORE_VRF_ABI,
  ERC20_ABI,
} from '@/lib/contracts';
import { formatUSDC, truncateAddress } from '@/lib/utils';

export default function VerifiersPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [stake, setStake] = useState('10');
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Pool length from Main (passthrough)
  const { data: poolLength } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'verifierPoolLength',
  });

  // Verifier registry entry for current user
  const { data: verifierInfo, refetch: refetchVerifier } = useReadContract({
    address: ADDRESSES.ArenaCoreVRF,
    abi: ARENA_CORE_VRF_ABI,
    functionName: 'verifierRegistry',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const vInfo = verifierInfo as
    | { stake: bigint; isActive: boolean; taskCount: bigint; approvalCount: bigint; rejectionCount: bigint }
    | undefined;

  const isInPool = vInfo?.isActive ?? false;
  const stakeWei = BigInt(Math.round(parseFloat(stake || '0') * 1e6));

  // Check allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: ADDRESSES.MockUSDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, ADDRESSES.ArenaCoreVRF] : undefined,
    query: { enabled: !!address },
  });

  const needsApproval = !isInPool && allowance !== undefined && stakeWei > (allowance as bigint);

  const handleApprove = async () => {
    setApproving(true);
    setError(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.MockUSDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.ArenaCoreVRF, stakeWei],
      });
      await refetchAllowance();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  const handleJoin = async () => {
    setJoining(true);
    setError(null);
    setSuccess(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreVRF,
        abi: ARENA_CORE_VRF_ABI,
        functionName: 'joinVerifierPool',
        args: [stakeWei],
      });
      setSuccess('Joined the verifier pool!');
      await refetchVerifier();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    setLeaving(true);
    setError(null);
    setSuccess(null);
    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreVRF,
        abi: ARENA_CORE_VRF_ABI,
        functionName: 'leaveVerifierPool',
      });
      setSuccess('Left the verifier pool. Stake returned.');
      await refetchVerifier();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-2 uppercase tracking-wide">
        Verifier Pool
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        Join the verifier pool to be randomly assigned to verify task deliveries. Earn fees for honest verification.
      </p>

      {/* Pool Stats */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Pool Size</p>
          <p className="text-2xl font-mono font-bold text-white">
            {poolLength !== undefined ? Number(poolLength).toString() : '--'}
          </p>
        </div>
        <div className="bg-navy-900 border border-zinc-800 rounded p-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Your Status</p>
          <p className={`text-2xl font-mono font-bold ${isInPool ? 'text-arena-green' : 'text-zinc-500'}`}>
            {isInPool ? 'Active' : 'Inactive'}
          </p>
        </div>
      </div>

      {/* Verifier Stats */}
      {isConnected && vInfo && isInPool && (
        <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
            Your Verifier Stats
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-zinc-500">Staked</p>
              <p className="text-sm font-mono text-white">{formatUSDC(vInfo.stake)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Tasks Verified</p>
              <p className="text-sm font-mono text-white">{Number(vInfo.taskCount)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Approvals</p>
              <p className="text-sm font-mono text-arena-green">{Number(vInfo.approvalCount)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Rejections</p>
              <p className="text-sm font-mono text-arena-red">{Number(vInfo.rejectionCount)}</p>
            </div>
          </div>
        </div>
      )}

      {/* Join / Leave */}
      {isConnected ? (
        <div className="bg-navy-900 border border-zinc-800 rounded p-6">
          {!isInPool ? (
            <>
              <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
                Join Pool
              </h2>
              <div className="mb-4">
                <label className="block text-xs text-zinc-500 mb-1">Stake Amount (USDC)</label>
                <input
                  type="number"
                  step="0.01"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  placeholder="10.00"
                  className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:border-arena-blue focus:outline-none"
                />
              </div>
              <div className="flex gap-3">
                {needsApproval && (
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="flex-1 bg-arena-amber text-black font-medium py-2.5 rounded text-sm disabled:opacity-50"
                  >
                    {approving ? 'Approving...' : 'Approve USDC'}
                  </button>
                )}
                <button
                  onClick={handleJoin}
                  disabled={joining || !stake || needsApproval}
                  className="flex-1 bg-arena-green text-black font-medium py-2.5 rounded text-sm disabled:opacity-50"
                >
                  {joining ? 'Joining...' : 'Join Verifier Pool'}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
                Leave Pool
              </h2>
              <p className="text-xs text-zinc-500 mb-4">
                Leave the verifier pool to withdraw your stake.
              </p>
              <button
                onClick={handleLeave}
                disabled={leaving}
                className="w-full bg-arena-red text-white font-medium py-2.5 rounded text-sm disabled:opacity-50"
              >
                {leaving ? 'Leaving...' : 'Leave Pool & Withdraw Stake'}
              </button>
            </>
          )}

          {error && (
            <div className="mt-3 bg-arena-red/10 border border-arena-red/30 rounded p-3">
              <p className="text-arena-red text-xs break-all">{error}</p>
            </div>
          )}
          {success && (
            <div className="mt-3 bg-arena-green/10 border border-arena-green/30 rounded p-3">
              <p className="text-arena-green text-xs">{success}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">Connect your wallet to join the verifier pool</p>
        </div>
      )}
    </div>
  );
}
