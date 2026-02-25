import { TASK_STATUS_LABELS, TASK_STATUS_COLORS } from '@/lib/contracts';

interface StatusBadgeProps {
  status: number;
}

const BADGE_BG: Record<number, string> = {
  0: 'bg-arena-blue/10',
  1: 'bg-arena-amber/10',
  2: 'bg-cyan-400/10',
  3: 'bg-purple-400/10',
  4: 'bg-arena-amber/10',
  5: 'bg-arena-green/10',
  6: 'bg-arena-red/10',
  7: 'bg-orange-400/10',
  8: 'bg-zinc-500/10',
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = TASK_STATUS_LABELS[status] ?? 'Unknown';
  const textColor = TASK_STATUS_COLORS[status] ?? 'text-zinc-400';
  const bgColor = BADGE_BG[status] ?? 'bg-zinc-500/10';

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${textColor} ${bgColor}`}
    >
      {label}
    </span>
  );
}
