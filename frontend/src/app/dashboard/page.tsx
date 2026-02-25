'use client';

import { useState, useEffect } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import Link from 'next/link';
import { ADDRESSES, ARENA_CORE_MAIN_ABI } from '@/lib/contracts';
import { StatCard } from '@/components/StatCard';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable } from '@/components/DataTable';
import { formatUSDC, truncateAddress } from '@/lib/utils';

interface PostedTask {
  taskId: number;
  bounty: bigint;
  taskType: string;
  status: number;
}

interface AssignedTask {
  taskId: number;
  bounty: bigint;
  taskType: string;
  status: number;
}

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  const [postedTasks, setPostedTasks] = useState<PostedTask[]>([]);
  const [assignedTasks, setAssignedTasks] = useState<AssignedTask[]>([]);
  const [reputation, setReputation] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);
  const [activeStake, setActiveStake] = useState(BigInt(0));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDashboardData() {
      if (!publicClient || !address) return;
      setLoading(true);

      try {
        // Read total task count
        const taskCount = await publicClient.readContract({
          address: ADDRESSES.ArenaCoreMain,
          abi: ARENA_CORE_MAIN_ABI,
          functionName: 'taskCount',
        }) as bigint;

        const total = Number(taskCount);
        const posted: PostedTask[] = [];
        const assigned: AssignedTask[] = [];

        // Read all tasks in batches and filter by poster/agent
        const batchSize = 10;
        for (let start = 0; start < total; start += batchSize) {
          const end = Math.min(start + batchSize, total);
          const promises = [];
          for (let i = start; i < end; i++) {
            promises.push(
              Promise.all([
                publicClient.readContract({
                  address: ADDRESSES.ArenaCoreMain,
                  abi: ARENA_CORE_MAIN_ABI,
                  functionName: 'getTask',
                  args: [BigInt(i)],
                }),
                publicClient.readContract({
                  address: ADDRESSES.ArenaCoreMain,
                  abi: ARENA_CORE_MAIN_ABI,
                  functionName: 'getAssignment',
                  args: [BigInt(i)],
                }),
              ]).then(([task, assignment]) => ({ taskId: i, task, assignment }))
                .catch(() => null)
            );
          }

          const results = await Promise.all(promises);

          for (const result of results) {
            if (!result) continue;
            const t = result.task as {
              poster: string;
              bounty: bigint;
              taskType: string;
              status: number;
            };
            const a = result.assignment as { agent: string };

            // Tasks posted by this user
            if (t.poster.toLowerCase() === address.toLowerCase()) {
              posted.push({
                taskId: result.taskId,
                bounty: t.bounty,
                taskType: t.taskType,
                status: Number(t.status),
              });
            }

            // Tasks assigned to this user (as agent)
            if (
              a.agent &&
              a.agent !== '0x0000000000000000000000000000000000000000' &&
              a.agent.toLowerCase() === address.toLowerCase()
            ) {
              assigned.push({
                taskId: result.taskId,
                bounty: t.bounty,
                taskType: t.taskType,
                status: Number(t.status),
              });
            }
          }
        }

        setPostedTasks(posted.reverse());
        setAssignedTasks(assigned.reverse());

        // Read agent stats
        const [rep, done, fail, stake] = await Promise.all([
          publicClient.readContract({
            address: ADDRESSES.ArenaCoreMain,
            abi: ARENA_CORE_MAIN_ABI,
            functionName: 'agentReputation',
            args: [address],
          }),
          publicClient.readContract({
            address: ADDRESSES.ArenaCoreMain,
            abi: ARENA_CORE_MAIN_ABI,
            functionName: 'agentTasksCompleted',
            args: [address],
          }),
          publicClient.readContract({
            address: ADDRESSES.ArenaCoreMain,
            abi: ARENA_CORE_MAIN_ABI,
            functionName: 'agentTasksFailed',
            args: [address],
          }),
          publicClient.readContract({
            address: ADDRESSES.ArenaCoreMain,
            abi: ARENA_CORE_MAIN_ABI,
            functionName: 'agentActiveStake',
            args: [address],
          }),
        ]);

        setReputation(Number(rep as bigint));
        setCompleted(Number(done as bigint));
        setFailed(Number(fail as bigint));
        setActiveStake(stake as bigint);
      } catch {
        // Silently handle RPC errors
      } finally {
        setLoading(false);
      }
    }

    fetchDashboardData();
  }, [publicClient, address]);

  // ---- Not connected ----
  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">
            Connect Wallet to view dashboard
          </p>
        </div>
      </div>
    );
  }

  // ---- Stats ----
  const totalPosted = postedTasks.length;
  const totalSpent = postedTasks.reduce(
    (sum, t) => sum + (t.bounty ?? BigInt(0)),
    BigInt(0),
  );
  const total = completed + failed;
  const winRate = total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : '--';

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-2 uppercase tracking-wide">
        My Dashboard
      </h1>
      <p className="text-sm font-mono text-zinc-500 mb-6">
        {truncateAddress(address ?? '')}
      </p>

      {/* My Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard
          label="Tasks Posted"
          value={loading ? '...' : totalPosted.toString()}
          sub="As task poster"
        />
        <StatCard
          label="Total Spent"
          value={loading ? '...' : formatUSDC(totalSpent)}
          sub="USDC in bounties"
        />
        <StatCard
          label="Reputation"
          value={loading ? '...' : reputation.toString()}
          sub="Agent reputation"
        />
        <StatCard
          label="Win Rate"
          value={loading ? '...' : winRate}
          sub="Tasks completed / total"
        />
        <StatCard
          label="Active Stake"
          value={loading ? '...' : formatUSDC(activeStake)}
          sub="USDC locked"
        />
      </div>

      {/* My Posted Tasks */}
      <div className="bg-navy-900 border border-zinc-800 rounded mb-6">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            My Posted Tasks
          </h2>
        </div>
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-10 bg-navy-800 rounded animate-pulse"
              />
            ))}
          </div>
        ) : postedTasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 text-sm">
            No tasks posted
          </div>
        ) : (
          <DataTable
            headers={['Task ID', 'Type', 'Bounty', 'Status']}
            rows={postedTasks.map((t) => [
              <Link key="id" href={`/tasks/${t.taskId}`} className="font-mono text-arena-blue hover:underline">
                #{t.taskId.toString()}
              </Link>,
              <span
                key="type"
                className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-navy-800 text-zinc-300"
              >
                {t.taskType}
              </span>,
              <span key="bounty" className="font-mono text-arena-green">
                {formatUSDC(t.bounty)}
              </span>,
              <StatusBadge key="status" status={t.status} />,
            ])}
          />
        )}
      </div>

      {/* My Assigned Tasks (as agent) */}
      <div className="bg-navy-900 border border-zinc-800 rounded mb-6">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            My Assigned Tasks
          </h2>
        </div>
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-10 bg-navy-800 rounded animate-pulse"
              />
            ))}
          </div>
        ) : assignedTasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 text-sm">
            No assigned tasks
          </div>
        ) : (
          <DataTable
            headers={['Task ID', 'Type', 'Bounty', 'Status']}
            rows={assignedTasks.map((t) => [
              <Link key="id" href={`/tasks/${t.taskId}`} className="font-mono text-arena-blue hover:underline">
                #{t.taskId.toString()}
              </Link>,
              <span
                key="type"
                className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-navy-800 text-zinc-300"
              >
                {t.taskType}
              </span>,
              <span key="bounty" className="font-mono text-arena-green">
                {formatUSDC(t.bounty)}
              </span>,
              <StatusBadge key="status" status={t.status} />,
            ])}
          />
        )}
      </div>
    </div>
  );
}
