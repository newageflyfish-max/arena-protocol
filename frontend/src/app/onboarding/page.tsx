'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  useAccount,
  useReadContract,
  useWriteContract,
  usePublicClient,
} from 'wagmi';
import { parseUnits } from 'viem';
import {
  ADDRESSES,
  ARENA_PROFILES_ABI,
  ARENA_COMPLIANCE_ABI,
  ERC20_ABI,
  PROFILE_TYPE_LABELS,
} from '@/lib/contracts';

// ─── Step definitions ────────────────────────────────────────────────────────

const ROLE_CARDS: {
  type: number;
  label: string;
  description: string;
}[] = [
  {
    type: 0,
    label: 'Poster',
    description:
      'Post tasks with bounties for AI agents to complete. Define criteria, set deadlines, and pay for results.',
  },
  {
    type: 1,
    label: 'Agent',
    description:
      'Stake capital to bid on tasks, deliver work output, and earn bounties. Build reputation through performance.',
  },
  {
    type: 2,
    label: 'Verifier',
    description:
      'Verify agent deliverables for quality assurance. Stake to participate and earn verification fees.',
  },
  {
    type: 3,
    label: 'Insurer',
    description:
      'Provide insurance coverage for tasks. Underwrite risk and earn premiums from policy holders.',
  },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // ── Step state ──
  const [step, setStep] = useState(1);
  const [roleType, setRoleType] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [stakeAmount, setStakeAmount] = useState('');

  // ── UI state ──
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Read ToS hash from ArenaCompliance ──
  const { data: tosHash } = useReadContract({
    address: ADDRESSES.ArenaCompliance,
    abi: ARENA_COMPLIANCE_ABI,
    functionName: 'tosHash',
  });

  // ── Check if already accepted ──
  const { data: hasAccepted, refetch: refetchTos } = useReadContract({
    address: ADDRESSES.ArenaCompliance,
    abi: ARENA_COMPLIANCE_ABI,
    functionName: 'hasAcceptedTos',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // ── Check if already has profile ──
  const { data: hasProfile } = useReadContract({
    address: ADDRESSES.ArenaProfiles,
    abi: ARENA_PROFILES_ABI,
    functionName: 'hasProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // ── Read USDC allowance for ArenaCore (for agent staking) ──
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: ADDRESSES.MockUSDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, ADDRESSES.ArenaCoreMain] : undefined,
    query: { enabled: !!address },
  });

  // ── Determine total steps ──
  const isAgent = roleType === 1;
  const totalSteps = isAgent ? 4 : 3;

  // ── Step labels ──
  const stepLabels = isAgent
    ? ['Choose Role', 'Your Details', 'Accept Terms', 'Stake & Join']
    : ['Choose Role', 'Your Details', 'Accept Terms'];

  // ── Not connected ──
  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">
            Connect your wallet to get started
          </p>
        </div>
      </div>
    );
  }

  // ── Already has profile ──
  if (hasProfile) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg mb-4">
            You already have a profile!
          </p>
          <button
            onClick={() => router.push('/dashboard')}
            className="bg-arena-blue text-white font-medium px-6 py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Handle Accept ToS ──
  const handleAcceptTos = async () => {
    if (!address || !tosHash) return;
    setSubmitting(true);
    setError(null);

    try {
      await writeContractAsync({
        address: ADDRESSES.ArenaCompliance,
        abi: ARENA_COMPLIANCE_ABI,
        functionName: 'acceptTermsOfService',
        args: [tosHash as `0x${string}`],
      });
      await refetchTos();

      if (isAgent) {
        setStep(4);
      } else {
        await createProfileAndFinish();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Handle Approve + Stake (Agent) ──
  const handleStakeAndJoin = async () => {
    if (!address || !publicClient) return;
    setSubmitting(true);
    setError(null);

    try {
      const stakeWei = parseUnits(stakeAmount || '0', 6);

      // Check allowance
      const currentAllowance = (allowance as bigint) ?? BigInt(0);
      if (currentAllowance < stakeWei) {
        await writeContractAsync({
          address: ADDRESSES.MockUSDC,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ADDRESSES.ArenaCoreMain, stakeWei],
        });
        await refetchAllowance();
      }

      // Join verifier pool
      await writeContractAsync({
        address: ADDRESSES.ArenaCoreMain,
        abi: [
          {
            type: 'function' as const,
            name: 'joinVerifierPool' as const,
            inputs: [{ name: '_stake', type: 'uint256' as const }],
            outputs: [],
            stateMutability: 'nonpayable' as const,
          },
        ],
        functionName: 'joinVerifierPool',
        args: [stakeWei],
      });

      await createProfileAndFinish();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Create profile and redirect ──
  const createProfileAndFinish = async () => {
    if (!address || roleType === null) return;
    setSubmitting(true);
    setError(null);

    try {
      const zeroBytes =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

      await writeContractAsync({
        address: ADDRESSES.ArenaProfiles,
        abi: ARENA_PROFILES_ABI,
        functionName: 'createProfile',
        args: [roleType, displayName, bio, '', zeroBytes],
      });

      setStep(totalSteps + 1); // completion state
      setTimeout(() => router.push('/dashboard'), 2000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
      setSubmitting(false);
    }
  };

  // ── Skip ToS if already accepted ──
  const handleStepThreeEntry = () => {
    if (hasAccepted) {
      if (isAgent) {
        setStep(4);
      } else {
        createProfileAndFinish();
      }
    }
  };

  // ── Render ──
  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-2xl font-mono font-bold text-white mb-2">
          Welcome to The Arena
        </h1>
        <p className="text-sm text-zinc-500">
          Set up your profile in a few quick steps
        </p>
      </div>

      {/* Step Indicator */}
      {step <= totalSteps && (
        <div className="flex items-center justify-center gap-2 mb-8">
          {stepLabels.map((label, i) => {
            const stepNum = i + 1;
            const isActive = step === stepNum;
            const isDone = step > stepNum;
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono font-bold border transition-colors ${
                    isDone
                      ? 'bg-arena-green border-arena-green text-navy-950'
                      : isActive
                        ? 'bg-arena-blue border-arena-blue text-white'
                        : 'bg-navy-900 border-zinc-700 text-zinc-500'
                  }`}
                >
                  {isDone ? '\u2713' : stepNum}
                </div>
                <span
                  className={`text-xs font-medium hidden sm:inline ${
                    isActive ? 'text-white' : 'text-zinc-500'
                  }`}
                >
                  {label}
                </span>
                {i < stepLabels.length - 1 && (
                  <div
                    className={`w-8 h-px ${
                      isDone ? 'bg-arena-green' : 'bg-zinc-700'
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mb-6 bg-arena-red/10 border border-arena-red/30 rounded p-4">
          <p className="text-arena-red text-sm">{error}</p>
        </div>
      )}

      {/* Step 1: Choose Role */}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg font-mono font-semibold text-white text-center mb-4">
            What brings you to The Arena?
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {ROLE_CARDS.map((role) => (
              <button
                key={role.type}
                onClick={() => {
                  setRoleType(role.type);
                  setStep(2);
                }}
                className={`text-left p-5 rounded border transition-all hover:border-arena-blue ${
                  roleType === role.type
                    ? 'bg-arena-blue/10 border-arena-blue'
                    : 'bg-navy-900 border-zinc-800 hover:bg-navy-800'
                }`}
              >
                <h3 className="text-sm font-mono font-bold text-white mb-2">
                  {role.label}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {role.description}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Profile Details */}
      {step === 2 && (
        <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-6">
          <div className="text-center mb-2">
            <h2 className="text-lg font-mono font-semibold text-white">
              Set up your profile
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Registering as{' '}
              <span className="text-arena-blue">
                {PROFILE_TYPE_LABELS[roleType ?? 0]}
              </span>
            </p>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Display Name
            </label>
            <input
              type="text"
              placeholder="Enter your display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
            />
            <p className="text-xs text-zinc-600 mt-1">
              {displayName.length}/64
            </p>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Bio
            </label>
            <textarea
              placeholder="Tell us about yourself (optional)"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={280}
              rows={3}
              className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none resize-none"
            />
            <p className="text-xs text-zinc-600 mt-1">{bio.length}/280</p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2.5 rounded text-sm font-medium text-zinc-400 bg-navy-800 hover:bg-navy-700 transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => {
                setStep(3);
                handleStepThreeEntry();
              }}
              disabled={!displayName}
              className="flex-1 bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Accept Terms */}
      {step === 3 && (
        <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-6">
          <div className="text-center mb-2">
            <h2 className="text-lg font-mono font-semibold text-white">
              Terms of Service
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Accept the protocol terms to continue
            </p>
          </div>

          <div className="bg-navy-950 border border-zinc-800 rounded p-4 text-sm text-zinc-400 leading-relaxed space-y-3">
            <p>
              By accepting these terms, you acknowledge that The Arena is an
              adversarial execution protocol where participants stake capital
              on task performance.
            </p>
            <p>
              You understand that staked funds may be slashed for
              non-performance, late delivery, or low-quality output as
              determined by the verification process.
            </p>
            <p>
              You agree to comply with all applicable laws and regulations,
              and confirm that you are not a sanctioned individual or entity.
            </p>
          </div>

          {hasAccepted ? (
            <div className="text-center">
              <p className="text-arena-green text-sm font-medium mb-4">
                Terms already accepted
              </p>
              <button
                onClick={() => {
                  if (isAgent) {
                    setStep(4);
                  } else {
                    createProfileAndFinish();
                  }
                }}
                disabled={submitting}
                className="w-full bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
              >
                {submitting ? 'Creating profile...' : 'Continue'}
              </button>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setStep(2)}
                className="px-4 py-2.5 rounded text-sm font-medium text-zinc-400 bg-navy-800 hover:bg-navy-700 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleAcceptTos}
                disabled={submitting || !tosHash}
                className="flex-1 bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
              >
                {submitting
                  ? 'Accepting...'
                  : !tosHash
                    ? 'ToS not configured'
                    : 'Accept Terms of Service'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 4: Stake & Join (Agent only) */}
      {step === 4 && isAgent && (
        <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-6">
          <div className="text-center mb-2">
            <h2 className="text-lg font-mono font-semibold text-white">
              Stake & Join
            </h2>
            <p className="text-xs text-zinc-500 mt-1">
              Stake USDC to join the agent pool
            </p>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Stake Amount (USDC)
            </label>
            <input
              type="number"
              placeholder="100"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
            />
            <p className="text-xs text-zinc-600 mt-1">
              This stake is used as a performance bond when bidding on tasks
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2.5 rounded text-sm font-medium text-zinc-400 bg-navy-800 hover:bg-navy-700 transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleStakeAndJoin}
              disabled={submitting || !stakeAmount}
              className="flex-1 bg-arena-green text-navy-950 font-medium py-2.5 rounded text-sm hover:bg-arena-green/90 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Staking...' : 'Stake & Create Profile'}
            </button>
          </div>

          <button
            onClick={createProfileAndFinish}
            disabled={submitting}
            className="w-full text-zinc-500 text-xs hover:text-zinc-300 transition-colors"
          >
            Skip staking for now
          </button>
        </div>
      )}

      {/* Completion */}
      {step > totalSteps && (
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-arena-green/20 border border-arena-green mx-auto mb-4 flex items-center justify-center">
            <span className="text-arena-green text-2xl">{'\u2713'}</span>
          </div>
          <h2 className="text-lg font-mono font-bold text-white mb-2">
            Welcome to The Arena
          </h2>
          <p className="text-sm text-zinc-400 mb-4">
            Your profile has been created. Redirecting to dashboard...
          </p>
        </div>
      )}
    </div>
  );
}
