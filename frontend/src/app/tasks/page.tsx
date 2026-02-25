'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useReadContract, usePublicClient } from 'wagmi';
import Link from 'next/link';
import { ADDRESSES, ARENA_CORE_MAIN_ABI, TASK_STATUS_LABELS } from '@/lib/contracts';
import { StatusBadge } from '@/components/StatusBadge';
import { DataTable } from '@/components/DataTable';
import { truncateAddress, formatUSDC, timeRemaining } from '@/lib/utils';

interface TaskData {
  id: number;
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

const FILTER_TABS = [
  { label: 'All', value: -1 },
  { label: 'Open', value: 0 },
  { label: 'Bidding', value: 1 },
  { label: 'Assigned', value: 2 },
  { label: 'Delivered', value: 3 },
  { label: 'Verifying', value: 4 },
  { label: 'Complete', value: 5 },
  { label: 'Failed', value: 6 },
];

export default function TasksPage() {
  const router = useRouter();
  const publicClient = usePublicClient();
  const [activeFilter, setActiveFilter] = useState(-1);
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [loading, setLoading] = useState(true);

  const { data: taskCount } = useReadContract({
    address: ADDRESSES.ArenaCoreMain,
    abi: ARENA_CORE_MAIN_ABI,
    functionName: 'taskCount',
  });

  useEffect(() => {
    async function fetchTasks() {
      if (!publicClient || taskCount === undefined) return;
      setLoading(true);

      const count = Number(taskCount);
      const start = Math.max(0, count - 50);
      const fetched: TaskData[] = [];

      for (let i = count - 1; i >= start; i--) {
        try {
          const result = await publicClient.readContract({
            address: ADDRESSES.ArenaCoreMain,
            abi: ARENA_CORE_MAIN_ABI,
            functionName: 'getTask',
            args: [BigInt(i)],
          });

          const task = result as {
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
          };

          fetched.push({
            id: i,
            poster: task.poster,
            token: task.token,
            bounty: task.bounty,
            deadline: task.deadline,
            slashWindow: task.slashWindow,
            createdAt: task.createdAt,
            bidDeadline: task.bidDeadline,
            revealDeadline: task.revealDeadline,
            requiredVerifiers: Number(task.requiredVerifiers),
            status: Number(task.status),
            criteriaHash: task.criteriaHash,
            taskType: task.taskType,
          });
        } catch {
          // Skip tasks that fail to load
        }
      }

      setTasks(fetched);
      setLoading(false);
    }

    fetchTasks();
  }, [publicClient, taskCount]);

  const filteredTasks = useMemo(() => {
    if (activeFilter === -1) return tasks;
    return tasks.filter((t) => t.status === activeFilter);
  }, [tasks, activeFilter]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-6 uppercase tracking-wide">
        Task Board
      </h1>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-2">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveFilter(tab.value)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap ${
              activeFilter === tab.value
                ? 'bg-arena-blue text-white'
                : 'bg-navy-800 text-zinc-400 hover:text-zinc-200 hover:bg-navy-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tasks Table */}
      <div className="bg-navy-900 border border-zinc-800 rounded">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 bg-navy-800 rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <DataTable
            headers={['Task ID', 'Type', 'Bounty', 'Poster', 'Deadline', 'Status']}
            rows={filteredTasks.map((t) => [
              <Link key="id" href={`/tasks/${t.id}`} className="font-mono text-arena-blue hover:underline" onClick={(e) => e.stopPropagation()}>
                #{t.id}
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
              <Link key="poster" href={`/profile/${t.poster}`} className="font-mono text-zinc-400 hover:text-arena-blue" onClick={(e) => e.stopPropagation()}>
                {truncateAddress(t.poster)}
              </Link>,
              <span key="deadline" className="font-mono text-zinc-400">
                {timeRemaining(t.deadline)}
              </span>,
              <StatusBadge key="status" status={t.status} />,
            ])}
            onRowClick={(idx) => {
              const task = filteredTasks[idx];
              if (task) router.push(`/tasks/${task.id}`);
            }}
          />
        )}
      </div>

      {/* Count footer */}
      <div className="mt-4 text-xs text-zinc-500">
        Showing {filteredTasks.length} of {tasks.length} tasks
      </div>
    </div>
  );
}
