'use client';

import { useState, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { keccak256, toBytes, parseUnits } from 'viem';
import { ADDRESSES, ARENA_CORE_MAIN_ABI, ERC20_ABI, TASK_TYPES } from '@/lib/contracts';
import type { TaskType } from '@/lib/contracts';

// ---------------------------------------------------------------------------
// Focus area options per task type
// ---------------------------------------------------------------------------
const AUDIT_FOCUS_AREAS = [
  'reentrancy',
  'access_control',
  'oracle_manipulation',
  'integer_overflow',
  'flash_loan',
  'front_running',
  'logic_errors',
  'gas_optimization',
] as const;

const RISK_CATEGORIES = [
  'smart_contract',
  'liquidity',
  'governance',
  'oracle',
  'bridge',
  'economic',
] as const;

const SCORING_FACTORS = [
  'transaction_history',
  'defi_activity',
  'nft_holdings',
  'governance_participation',
  'protocol_interactions',
  'wallet_age',
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CreateTaskPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // ---- Form state ----
  const [taskType, setTaskType] = useState<TaskType>('audit');
  const [bounty, setBounty] = useState('');
  const [deadline, setDeadline] = useState('');
  const [requiredVerifiers, setRequiredVerifiers] = useState(3);

  // Audit fields
  const [targetContract, setTargetContract] = useState('');
  const [scope, setScope] = useState('');
  const [focusAreas, setFocusAreas] = useState<string[]>([]);

  // Risk validation fields
  const [protocol, setProtocol] = useState('');
  const [contractAddress, setContractAddress] = useState('');
  const [chain, setChain] = useState('base');
  const [riskCategories, setRiskCategories] = useState<string[]>([]);

  // Credit scoring fields
  const [targetAddress, setTargetAddress] = useState('');
  const [evaluationPeriod, setEvaluationPeriod] = useState('30');
  const [scoringFactorsSelected, setScoringFactorsSelected] = useState<string[]>([]);

  // Treasury execution fields
  const [treasuryAddress, setTreasuryAddress] = useState('');
  const [operationType, setOperationType] = useState('');
  const [maxValue, setMaxValue] = useState('');

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [successTaskId, setSuccessTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- Read allowance ----
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: ADDRESSES.MockUSDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, ADDRESSES.ArenaCoreMain] : undefined,
    query: { enabled: !!address },
  });

  // ---- Build criteria object for hashing ----
  const buildCriteria = useCallback(() => {
    switch (taskType) {
      case 'audit':
        return {
          taskType,
          target_contract: targetContract,
          scope,
          focus_areas: focusAreas,
        };
      case 'risk_validation':
        return {
          taskType,
          protocol,
          contractAddress,
          chain,
          risk_categories: riskCategories,
        };
      case 'credit_scoring':
        return {
          taskType,
          target_address: targetAddress,
          evaluation_period_days: Number(evaluationPeriod),
          scoring_factors: scoringFactorsSelected,
        };
      case 'treasury_execution':
        return {
          taskType,
          treasury_address: treasuryAddress,
          operation_type: operationType,
          max_value: Number(maxValue),
        };
    }
  }, [
    taskType,
    targetContract,
    scope,
    focusAreas,
    protocol,
    contractAddress,
    chain,
    riskCategories,
    targetAddress,
    evaluationPeriod,
    scoringFactorsSelected,
    treasuryAddress,
    operationType,
    maxValue,
  ]);

  // ---- Toggle checkbox helper ----
  const toggleItem = (
    list: string[],
    setter: (v: string[]) => void,
    item: string,
  ) => {
    if (list.includes(item)) {
      setter(list.filter((x) => x !== item));
    } else {
      setter([...list, item]);
    }
  };

  // ---- Approve USDC ----
  const handleApprove = async () => {
    if (!address) return;
    setApproving(true);
    setError(null);

    try {
      const bountyWei = parseUnits(bounty || '0', 6);
      await writeContractAsync({
        address: ADDRESSES.MockUSDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.ArenaCoreMain, bountyWei],
      });
      await refetchAllowance();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Approval failed';
      setError(message);
    } finally {
      setApproving(false);
    }
  };

  // ---- Submit task ----
  const handleSubmit = async () => {
    if (!address || !publicClient) return;
    setSubmitting(true);
    setError(null);
    setSuccessTaskId(null);

    try {
      const bountyWei = parseUnits(bounty || '0', 6);
      const deadlineTs = BigInt(Math.floor(new Date(deadline).getTime() / 1000));
      const slashWindow = BigInt(24 * 3600); // 24h default
      const bidDuration = BigInt(4 * 3600); // 4h
      const revealDuration = BigInt(2 * 3600); // 2h

      const criteria = buildCriteria();
      const criteriaHash = keccak256(toBytes(JSON.stringify(criteria)));

      const hash = await writeContractAsync({
        address: ADDRESSES.ArenaCoreMain,
        abi: ARENA_CORE_MAIN_ABI,
        functionName: 'createTask',
        args: [
          bountyWei,
          deadlineTs,
          slashWindow,
          bidDuration,
          revealDuration,
          requiredVerifiers,
          criteriaHash,
          taskType,
          ADDRESSES.MockUSDC,
        ],
      });

      // Wait for receipt to get the task ID from event
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const taskCreatedLog = receipt.logs.find((log) => {
        try {
          return log.topics[0] !== undefined;
        } catch {
          return false;
        }
      });

      if (taskCreatedLog && taskCreatedLog.topics[1]) {
        const id = BigInt(taskCreatedLog.topics[1]);
        setSuccessTaskId(id.toString());
      } else {
        setSuccessTaskId('submitted');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Computed ----
  const bountyWei = bounty ? parseUnits(bounty, 6) : BigInt(0);
  const needsApproval =
    allowance !== undefined && (allowance as bigint) < bountyWei;

  // ---- Not connected ----
  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">
            Connect your wallet to create a task
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-6 uppercase tracking-wide">
        Create Task
      </h1>

      {/* Success banner */}
      {successTaskId && (
        <div className="mb-6 bg-arena-green/10 border border-arena-green/30 rounded p-4">
          <p className="text-arena-green text-sm font-medium">
            Task created successfully!
            {successTaskId !== 'submitted' && (
              <span className="font-mono ml-1">
                Task ID: #{successTaskId}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mb-6 bg-arena-red/10 border border-arena-red/30 rounded p-4">
          <p className="text-arena-red text-sm">{error}</p>
        </div>
      )}

      <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-6">
        {/* Task Type Selector */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Task Type
          </label>
          <div className="flex gap-2">
            {TASK_TYPES.map((tt) => (
              <button
                key={tt}
                onClick={() => setTaskType(tt)}
                className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                  taskType === tt
                    ? 'bg-arena-blue text-white'
                    : 'bg-navy-800 text-zinc-400 hover:text-zinc-200 hover:bg-navy-700'
                }`}
              >
                {tt.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic Fields */}
        {taskType === 'audit' && (
          <>
            <FormInput
              label="Target Contract"
              placeholder="0x..."
              value={targetContract}
              onChange={setTargetContract}
            />
            <FormTextarea
              label="Scope"
              placeholder="Describe the audit scope..."
              value={scope}
              onChange={setScope}
            />
            <FormCheckboxGroup
              label="Focus Areas"
              options={AUDIT_FOCUS_AREAS as unknown as string[]}
              selected={focusAreas}
              onToggle={(item) => toggleItem(focusAreas, setFocusAreas, item)}
            />
          </>
        )}

        {taskType === 'risk_validation' && (
          <>
            <FormInput
              label="Protocol"
              placeholder="Protocol name"
              value={protocol}
              onChange={setProtocol}
            />
            <FormInput
              label="Contract Address"
              placeholder="0x..."
              value={contractAddress}
              onChange={setContractAddress}
            />
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
                Chain
              </label>
              <select
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:border-arena-blue focus:outline-none"
              >
                <option value="base">Base</option>
                <option value="ethereum">Ethereum</option>
                <option value="arbitrum">Arbitrum</option>
                <option value="optimism">Optimism</option>
                <option value="polygon">Polygon</option>
              </select>
            </div>
            <FormCheckboxGroup
              label="Risk Categories"
              options={RISK_CATEGORIES as unknown as string[]}
              selected={riskCategories}
              onToggle={(item) =>
                toggleItem(riskCategories, setRiskCategories, item)
              }
            />
          </>
        )}

        {taskType === 'credit_scoring' && (
          <>
            <FormInput
              label="Target Address"
              placeholder="0x..."
              value={targetAddress}
              onChange={setTargetAddress}
            />
            <FormInput
              label="Evaluation Period (days)"
              placeholder="30"
              value={evaluationPeriod}
              onChange={setEvaluationPeriod}
              type="number"
            />
            <FormCheckboxGroup
              label="Scoring Factors"
              options={SCORING_FACTORS as unknown as string[]}
              selected={scoringFactorsSelected}
              onToggle={(item) =>
                toggleItem(
                  scoringFactorsSelected,
                  setScoringFactorsSelected,
                  item,
                )
              }
            />
          </>
        )}

        {taskType === 'treasury_execution' && (
          <>
            <FormInput
              label="Treasury Address"
              placeholder="0x..."
              value={treasuryAddress}
              onChange={setTreasuryAddress}
            />
            <FormInput
              label="Operation Type"
              placeholder="e.g. rebalance, swap, yield"
              value={operationType}
              onChange={setOperationType}
            />
            <FormInput
              label="Max Value (USDC)"
              placeholder="10000"
              value={maxValue}
              onChange={setMaxValue}
              type="number"
            />
          </>
        )}

        {/* Common Fields */}
        <hr className="border-zinc-800" />

        <FormInput
          label="Bounty (USDC)"
          placeholder="100"
          value={bounty}
          onChange={setBounty}
          type="number"
        />

        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Deadline
          </label>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:border-arena-blue focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Required Verifiers: {requiredVerifiers}
          </label>
          <input
            type="range"
            min={1}
            max={5}
            value={requiredVerifiers}
            onChange={(e) => setRequiredVerifiers(Number(e.target.value))}
            className="w-full accent-arena-blue"
          />
          <div className="flex justify-between text-xs text-zinc-600 mt-1">
            <span>1</span>
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 pt-2">
          {needsApproval ? (
            <button
              onClick={handleApprove}
              disabled={approving}
              className="flex-1 bg-arena-amber text-navy-950 font-medium py-2.5 rounded text-sm hover:bg-arena-amber/90 transition-colors disabled:opacity-50"
            >
              {approving ? 'Approving...' : `Approve ${bounty || '0'} USDC`}
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting || !bounty || !deadline}
              className="flex-1 bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Task'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form sub-components
// ---------------------------------------------------------------------------
function FormInput({
  label,
  placeholder,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
        {label}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
      />
    </div>
  );
}

function FormTextarea({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
        {label}
      </label>
      <textarea
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none resize-none"
      />
    </div>
  );
}

function FormCheckboxGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (item: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors border ${
                isSelected
                  ? 'bg-arena-blue/20 border-arena-blue text-arena-blue'
                  : 'bg-navy-950 border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {option.replace(/_/g, ' ')}
            </button>
          );
        })}
      </div>
    </div>
  );
}
