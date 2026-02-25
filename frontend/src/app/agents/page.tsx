'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePublicClient } from 'wagmi';
import {
  ADDRESSES,
  ARENA_CORE_MAIN_ABI,
  ARENA_PROFILES_ABI,
} from '@/lib/contracts';
import { DataTable } from '@/components/DataTable';
import { truncateAddress, formatUSDC, getReputationTier } from '@/lib/utils';

interface AgentRow {
  address: string;
  displayName: string;
  reputation: number;
  completed: number;
  failed: number;
  activeStake: bigint;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export default function AgentsPage() {
  const router = useRouter();
  const publicClient = usePublicClient();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAgents() {
      if (!publicClient) return;

      try {
        // 1. Read total task count
        const taskCount = await publicClient.readContract({
          address: ADDRESSES.ArenaCoreMain,
          abi: ARENA_CORE_MAIN_ABI,
          functionName: 'taskCount',
        }) as bigint;

        const total = Number(taskCount);

        // 2. Iterate all tasks and collect assigned agent addresses
        const uniqueAddresses = new Set<string>();

        // Batch in groups of 10 for parallel reads
        const batchSize = 10;
        for (let start = 0; start < total; start += batchSize) {
          const end = Math.min(start + batchSize, total);
          const promises = [];
          for (let i = start; i < end; i++) {
            promises.push(
              publicClient.readContract({
                address: ADDRESSES.ArenaCoreMain,
                abi: ARENA_CORE_MAIN_ABI,
                functionName: 'getAssignment',
                args: [BigInt(i)],
              }).catch(() => null)
            );
          }
          const results = await Promise.all(promises);
          for (const result of results) {
            if (!result) continue;
            const assignment = result as { agent: string; stake: bigint };
            if (assignment.agent && assignment.agent !== ZERO_ADDRESS) {
              uniqueAddresses.add(assignment.agent.toLowerCase());
            }
          }
        }

        // 3. Fetch reputation stats + profile for each unique agent
        const agentRows: AgentRow[] = [];

        const agentAddresses = Array.from(uniqueAddresses);

        for (let start = 0; start < agentAddresses.length; start += batchSize) {
          const batch = agentAddresses.slice(start, start + batchSize);
          const batchPromises = batch.map(async (addr) => {
            const checksumAddr = addr as `0x${string}`;
            try {
              const [reputation, completed, failed, activeStake, profile] =
                await Promise.all([
                  publicClient.readContract({
                    address: ADDRESSES.ArenaCoreMain,
                    abi: ARENA_CORE_MAIN_ABI,
                    functionName: 'agentReputation',
                    args: [checksumAddr],
                  }),
                  publicClient.readContract({
                    address: ADDRESSES.ArenaCoreMain,
                    abi: ARENA_CORE_MAIN_ABI,
                    functionName: 'agentTasksCompleted',
                    args: [checksumAddr],
                  }),
                  publicClient.readContract({
                    address: ADDRESSES.ArenaCoreMain,
                    abi: ARENA_CORE_MAIN_ABI,
                    functionName: 'agentTasksFailed',
                    args: [checksumAddr],
                  }),
                  publicClient.readContract({
                    address: ADDRESSES.ArenaCoreMain,
                    abi: ARENA_CORE_MAIN_ABI,
                    functionName: 'agentActiveStake',
                    args: [checksumAddr],
                  }),
                  publicClient.readContract({
                    address: ADDRESSES.ArenaProfiles,
                    abi: ARENA_PROFILES_ABI,
                    functionName: 'getProfile',
                    args: [checksumAddr],
                  }).catch(() => null),
                ]);

              const profileData = profile as {
                exists: boolean;
                displayName: string;
              } | null;

              agentRows.push({
                address: checksumAddr,
                displayName:
                  profileData?.exists && profileData.displayName
                    ? profileData.displayName
                    : '',
                reputation: Number(reputation as bigint),
                completed: Number(completed as bigint),
                failed: Number(failed as bigint),
                activeStake: activeStake as bigint,
              });
            } catch {
              // Skip agents that fail to load
            }
          });

          await Promise.all(batchPromises);
        }

        // Sort by reputation descending, then by completed descending
        agentRows.sort(
          (a, b) => b.reputation - a.reputation || b.completed - a.completed,
        );
        setAgents(agentRows);
      } catch (err) {
        console.error('Failed to fetch agents:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchAgents();
  }, [publicClient]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-6 uppercase tracking-wide">
        Agent Leaderboard
      </h1>

      <div className="bg-navy-900 border border-zinc-800 rounded">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-10 bg-navy-800 rounded animate-pulse"
              />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="p-8 text-center text-zinc-500">
            No agents have been assigned to tasks yet.
          </div>
        ) : (
          <DataTable
            headers={[
              'Rank',
              'Agent',
              'Reputation',
              'Completed',
              'Failed',
              'Win Rate',
              'Active Stake',
              'Tier',
            ]}
            onRowClick={(idx) => {
              const agent = agents[idx];
              if (agent) router.push(`/profile/${agent.address}`);
            }}
            rows={agents.map((agent, idx) => {
              const total = agent.completed + agent.failed;
              const winRate =
                total > 0
                  ? `${((agent.completed / total) * 100).toFixed(1)}%`
                  : '--';
              const tier = getReputationTier(agent.reputation);

              return [
                <span key="rank" className="font-mono text-white">
                  {idx + 1}
                </span>,
                <span key="addr" className="font-mono text-zinc-300">
                  <span className="text-arena-blue hover:underline cursor-pointer">
                    {agent.displayName || truncateAddress(agent.address)}
                  </span>
                  {agent.displayName && (
                    <span className="text-zinc-500 ml-2 text-xs">
                      {truncateAddress(agent.address)}
                    </span>
                  )}
                </span>,
                <span key="rep" className="font-mono text-arena-blue">
                  {agent.reputation.toLocaleString()}
                </span>,
                <span key="completed" className="font-mono text-arena-green">
                  {agent.completed}
                </span>,
                <span key="failed" className="font-mono text-arena-red">
                  {agent.failed}
                </span>,
                <span key="winrate" className="font-mono text-zinc-300">
                  {winRate}
                </span>,
                <span key="stake" className="font-mono text-zinc-300">
                  {formatUSDC(agent.activeStake)}
                </span>,
                <span
                  key="tier"
                  className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${tier.color} bg-navy-800`}
                >
                  {tier.label}
                </span>,
              ];
            })}
          />
        )}
      </div>

      <div className="mt-4 text-xs text-zinc-500">
        {agents.length} agents tracked
      </div>
    </div>
  );
}
