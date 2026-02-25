'use client';

import { useReadContract } from 'wagmi';
import { useRouter } from 'next/navigation';
import { ADDRESSES, ARENA_CORE_MAIN_ABI } from '@/lib/contracts';
import { StatCard } from '@/components/StatCard';
import { DataTable } from '@/components/DataTable';
import Link from 'next/link';
import { truncateAddress, formatUSDC } from '@/lib/utils';
import { useState, useEffect } from 'react';
import { usePublicClient } from 'wagmi';

interface RecentTask {
  taskId: number;
  poster: string;
  bounty: bigint;
  taskType: string;
  status: number;
  requiredVerifiers: number;
}

export function StatsView() {
  const publicClient = usePublicClient();
  const router = useRouter();
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [totalGMV, setTotalGMV] = useState(BigInt(0));

  // ---- Contract reads ----
  const { data: taskCount, isLoading: loadingTaskCount } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'taskCount',
  });

  const { data: verifierCount, isLoading: loadingVerifiers } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'verifierPoolLength',
  });

  const { data: treasury, isLoading: loadingTreasury } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'protocolTreasury',
    args: [ADDRESSES.MockUSDC],
  });

  // ---- Fetch recent tasks by reading on-chain state (no events) ----
  useEffect(() => {
    async function fetchRecentTasks() {
      if (!publicClient || taskCount === undefined) return;

      try {
        const total = Number(taskCount);
        // Read the last 10 tasks (or fewer if not enough)
        const startIdx = Math.max(0, total - 10);
        const tasks: RecentTask[] = [];
        let gmv = BigInt(0);

        const promises = [];
        for (let i = startIdx; i < total; i++) {
          promises.push(
            publicClient.readContract({
              address: ADDRESSES.ArenaCoreMain,
              abi: ARENA_CORE_MAIN_ABI,
              functionName: 'getTask',
              args: [BigInt(i)],
            }).then((taskData) => ({ taskId: i, taskData })).catch(() => null)
          );
        }

        const results = await Promise.all(promises);

        for (const result of results) {
          if (!result) continue;
          const t = result.taskData as {
            poster: string;
            bounty: bigint;
            taskType: string;
            status: number;
            requiredVerifiers: number;
          };
          tasks.push({
            taskId: result.taskId,
            poster: t.poster,
            bounty: t.bounty,
            taskType: t.taskType,
            status: Number(t.status),
            requiredVerifiers: Number(t.requiredVerifiers),
          });
          gmv += t.bounty;
        }

        // Show newest first
        tasks.reverse();
        setRecentTasks(tasks);
        setTotalGMV(gmv);
      } catch {
        // Handle RPC errors gracefully
      } finally {
        setLoadingRecent(false);
      }
    }

    fetchRecentTasks();
  }, [publicClient, taskCount]);

  // ---- Skeleton helper ----
  const Skeleton = () => (
    <div className="h-8 bg-navy-800 rounded animate-pulse w-24" />
  );

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Page title */}
      <h1 className="text-xl font-mono font-bold text-white mb-6 uppercase tracking-wide">
        Protocol Overview
      </h1>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Tasks"
          value={
            loadingTaskCount
              ? '...'
              : taskCount !== undefined
                ? taskCount.toString()
                : '0'
          }
          sub="All-time tasks created"
        />
        <StatCard
          label="Total GMV"
          value={
            loadingRecent ? '...' : formatUSDC(totalGMV)
          }
          sub="Sum of recent bounties"
        />
        <StatCard
          label="Active Verifiers"
          value={
            loadingVerifiers
              ? '...'
              : verifierCount !== undefined
                ? verifierCount.toString()
                : '0'
          }
          sub="Registered in pool"
        />
        <StatCard
          label="Protocol Treasury"
          value={
            loadingTreasury
              ? '...'
              : treasury !== undefined
                ? formatUSDC(treasury)
                : '$0.00'
          }
          sub="USDC accumulated"
        />
      </div>

      {/* Recent Activity */}
      <div className="bg-navy-900 border border-zinc-800 rounded">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            Recent Activity
          </h2>
        </div>
        {loadingRecent ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-4">
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            ))}
          </div>
        ) : (
          <DataTable
            headers={['Task ID', 'Poster', 'Bounty', 'Type', 'Verifiers']}
            onRowClick={(idx) => {
              const task = recentTasks[idx];
              if (task) router.push(`/tasks/${task.taskId}`);
            }}
            rows={recentTasks.map((t) => [
              <Link key="id" href={`/tasks/${t.taskId}`} className="font-mono text-arena-blue hover:underline" onClick={(e) => e.stopPropagation()}>
                #{t.taskId.toString()}
              </Link>,
              <Link key="poster" href={`/profile/${t.poster}`} className="font-mono text-zinc-400 hover:text-arena-blue" onClick={(e) => e.stopPropagation()}>
                {truncateAddress(t.poster)}
              </Link>,
              <span key="bounty" className="font-mono text-arena-green">
                {formatUSDC(t.bounty)}
              </span>,
              <span
                key="type"
                className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-navy-800 text-zinc-300"
              >
                {t.taskType}
              </span>,
              <span key="verifiers" className="font-mono text-zinc-400">
                {t.requiredVerifiers}
              </span>,
            ])}
          />
        )}
      </div>
    </div>
  );
}
