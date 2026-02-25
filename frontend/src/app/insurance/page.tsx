'use client';

import { useAccount } from 'wagmi';
import { ADDRESSES } from '@/lib/contracts';
import { truncateAddress } from '@/lib/utils';

export default function InsurancePage() {
  const { isConnected } = useAccount();

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-2 uppercase tracking-wide">
        Insurance
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        Purchase insurance policies to protect against agent failures and slashing events.
      </p>

      {/* Contract Info */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
        <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
          Contract
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-zinc-500">ArenaInsurance</span>
          <span className="text-sm font-mono text-zinc-200">{truncateAddress(ADDRESSES.ArenaInsurance)}</span>
        </div>
      </div>

      {/* How It Works */}
      <div className="bg-navy-900 border border-zinc-800 rounded p-6 mb-6">
        <h2 className="text-sm font-mono font-semibold text-white uppercase tracking-wide mb-4">
          How It Works
        </h2>
        <div className="space-y-4 text-sm text-zinc-400">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-arena-blue/20 text-arena-blue flex items-center justify-center text-xs font-bold shrink-0">1</div>
            <p><span className="text-white font-medium">Create Offer:</span> Insurers post coverage offers specifying premium, max payout, and conditions.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-arena-blue/20 text-arena-blue flex items-center justify-center text-xs font-bold shrink-0">2</div>
            <p><span className="text-white font-medium">Purchase Policy:</span> Task posters or agents buy insurance before task assignment.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-arena-blue/20 text-arena-blue flex items-center justify-center text-xs font-bold shrink-0">3</div>
            <p><span className="text-white font-medium">File Claim:</span> If the agent is slashed, the policy holder files a claim for reimbursement.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-arena-blue/20 text-arena-blue flex items-center justify-center text-xs font-bold shrink-0">4</div>
            <p><span className="text-white font-medium">Settlement:</span> Claims are settled based on the slash amount and coverage terms.</p>
          </div>
        </div>
      </div>

      {/* Placeholder */}
      {!isConnected ? (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">Connect your wallet to view insurance options</p>
        </div>
      ) : (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400">No active insurance offers yet.</p>
          <p className="text-xs text-zinc-600 mt-2">Insurance offers will appear here when insurers create them.</p>
        </div>
      )}
    </div>
  );
}
