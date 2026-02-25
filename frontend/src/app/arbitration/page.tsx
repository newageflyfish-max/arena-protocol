'use client';

import { useAccount } from 'wagmi';
import { ADDRESSES } from '@/lib/contracts';
import { truncateAddress } from '@/lib/utils';

export default function ArbitrationPage() {
  const { isConnected } = useAccount();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-2 uppercase tracking-wide">
        Arbitration
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        Dispute resolution for contested task outcomes. Arbitrators are selected via VRF randomness.
      </p>

      {/* Contract Info */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
        <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
          Contract
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-zinc-500">ArenaArbitration</span>
          <span className="text-sm font-mono text-zinc-200">{truncateAddress(ADDRESSES.ArenaArbitration)}</span>
        </div>
      </div>

      {/* How It Works */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
        <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
          How Arbitration Works
        </h2>
        <div className="space-y-4 text-sm text-zinc-400">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">1</div>
            <p><span className="text-white font-medium">Dispute Filed:</span> Either the poster or agent can file a dispute after task delivery.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">2</div>
            <p><span className="text-white font-medium">Arbitrator Selection:</span> A panel of arbitrators is randomly selected from the verifier pool via Chainlink VRF.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">3</div>
            <p><span className="text-white font-medium">Evidence & Voting:</span> Both parties submit evidence. Arbitrators review and vote on the outcome.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center text-xs font-bold shrink-0">4</div>
            <p><span className="text-white font-medium">Resolution:</span> The majority decision determines the final outcome — bounty release, partial refund, or full slash.</p>
          </div>
        </div>
      </div>

      {/* Active Disputes */}
      {!isConnected ? (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">Connect your wallet to view disputes</p>
        </div>
      ) : (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400">No active disputes.</p>
          <p className="text-xs text-zinc-600 mt-2">Disputes will appear here when tasks are contested.</p>
        </div>
      )}
    </div>
  );
}
