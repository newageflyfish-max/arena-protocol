'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useReadContract, usePublicClient } from 'wagmi';
import {
  ADDRESSES,
  ARENA_CORE_MAIN_ABI,
  ARENA_PROFILES_ABI,
  PROFILE_TYPE_LABELS,
  PROFILE_TYPE_COLORS,
} from '@/lib/contracts';
import { StatCard } from '@/components/StatCard';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable } from '@/components/DataTable';
import {
  truncateAddress,
  formatUSDC,
  formatTimestamp,
  getReputationTier,
} from '@/lib/utils';

interface TaskEntry {
  taskId: number;
  bounty: bigint;
  taskType: string;
  status: number;
  role: 'poster' | 'agent';
}

export default function ProfilePage() {
  const params = useParams();
  const addr = params.address as string;
  const publicClient = usePublicClient();

  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // ---- Read profile ----
  const { data: profileData } = useReadContract({
    address: ADDRESSES.ArenaProfiles,
    abi: ARENA_PROFILES_ABI,
    functionName: 'getProfile',
    args: [addr as `0x${string}`],
  });

  const profile = profileData as
    | {
        exists: boolean;
        profileType: number;
        avatarHash: string;
        displayName: string;
        bio: string;
        websiteUrl: string;
        createdAt: bigint;
        updatedAt: bigint;
      }
    | undefined;

  // ---- Read on-chain stats ----
  const { data: reputation } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'agentReputation',
    args: [addr as `0x${string}`],
  });

  const { data: tasksCompleted } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'agentTasksCompleted',
    args: [addr as `0x${string}`],
  });

  const { data: tasksFailed } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'agentTasksFailed',
    args: [addr as `0x${string}`],
  });

  const { data: activeStake } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'agentActiveStake',
    args: [addr as `0x${string}`],
  });

  // ---- Fetch task history by iterating on-chain data (no events) ----
  useEffect(() => {
    async function fetchHistory() {
      if (!publicClient || !addr) return;
      setLoading(true);

      try {
        const taskCount = await publicClient.readContract({
          address: ADDRESSES.ArenaCoreMain,
          abi: ARENA_CORE_MAIN_ABI,
          functionName: 'taskCount',
        }) as bigint;

        const total = Number(taskCount);
        const found: TaskEntry[] = [];
        const addrLower = addr.toLowerCase();

        // Read all tasks in batches
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

            if (t.poster.toLowerCase() === addrLower) {
              found.push({
                taskId: result.taskId,
                bounty: t.bounty,
                taskType: t.taskType,
                status: Number(t.status),
                role: 'poster',
              });
            }

            if (
              a.agent &&
              a.agent !== '0x0000000000000000000000000000000000000000' &&
              a.agent.toLowerCase() === addrLower
            ) {
              found.push({
                taskId: result.taskId,
                bounty: t.bounty,
                taskType: t.taskType,
                status: Number(t.status),
                role: 'agent',
              });
            }
          }
        }

        setTasks(found.reverse());
      } catch {
        // silently handle
      } finally {
        setLoading(false);
      }
    }

    fetchHistory();
  }, [publicClient, addr]);

  // ---- Computed stats ----
  const repScore = Number(reputation ?? 0);
  const completedNum = Number(tasksCompleted ?? 0);
  const failedNum = Number(tasksFailed ?? 0);
  const total = completedNum + failedNum;
  const winRate = total > 0 ? ((completedNum / total) * 100).toFixed(1) : '--';
  const stake = (activeStake as bigint) ?? BigInt(0);
  const tier = getReputationTier(repScore);

  const postedTasks = tasks.filter((t) => t.role === 'poster');
  const agentTasks = tasks.filter((t) => t.role === 'agent');

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Profile Header */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
        <div className="flex items-start gap-6">
          {/* Avatar placeholder */}
          <div className="w-16 h-16 rounded-full bg-navy-800 border border-zinc-700 flex items-center justify-center text-zinc-500 text-lg font-mono shrink-0">
            {profile?.exists
              ? profile.displayName.charAt(0).toUpperCase()
              : '?'}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-mono font-bold text-white truncate">
                {profile?.exists ? profile.displayName : truncateAddress(addr)}
              </h1>
              {profile?.exists && (
                <span
                  className={`inline-flex px-2 py-0.5 rounded text-xs font-medium bg-navy-800 ${
                    PROFILE_TYPE_COLORS[Number(profile.profileType)] ??
                    'text-zinc-300'
                  }`}
                >
                  {PROFILE_TYPE_LABELS[Number(profile.profileType)] ??
                    'Unknown'}
                </span>
              )}
              <span className={`text-xs font-medium ${tier.color}`}>
                {tier.label}
              </span>
            </div>

            <p className="text-sm font-mono text-zinc-500 mb-2">
              {truncateAddress(addr)}
            </p>

            {profile?.exists && profile.bio && (
              <p className="text-sm text-zinc-400 mb-2">{profile.bio}</p>
            )}

            <div className="flex items-center gap-4 text-xs text-zinc-500">
              {profile?.exists && profile.websiteUrl && (
                <span className="text-arena-blue">{profile.websiteUrl}</span>
              )}
              {profile?.exists && profile.createdAt > BigInt(0) && (
                <span>
                  Joined {formatTimestamp(profile.createdAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard
          label="Reputation"
          value={repScore.toString()}
          sub={tier.label}
        />
        <StatCard
          label="Completed"
          value={completedNum.toString()}
          sub="Tasks completed"
        />
        <StatCard
          label="Failed"
          value={failedNum.toString()}
          sub="Tasks failed"
        />
        <StatCard
          label="Win Rate"
          value={winRate === '--' ? '--' : `${winRate}%`}
          sub="Success rate"
        />
        <StatCard
          label="Active Stake"
          value={formatUSDC(stake)}
          sub="USDC locked"
        />
      </div>

      {/* Posted Tasks */}
      <div className="bg-navy-900 border border-zinc-800 rounded mb-6">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            Posted Tasks ({postedTasks.length})
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

      {/* Agent Tasks */}
      <div className="bg-navy-900 border border-zinc-800 rounded">
        <div className="px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide">
            Agent Tasks ({agentTasks.length})
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
        ) : agentTasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 text-sm">
            No agent tasks
          </div>
        ) : (
          <DataTable
            headers={['Task ID', 'Type', 'Bounty', 'Status']}
            rows={agentTasks.map((t) => [
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
