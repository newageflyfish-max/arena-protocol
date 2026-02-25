// ---------------------------------------------------------------------------
// Arena Protocol -- Utility helpers
// ---------------------------------------------------------------------------

/**
 * Truncate an Ethereum address to 0x1234...5678 format.
 */
export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Format a raw USDC bigint (6 decimals) to a human-readable dollar string.
 * Example: 1_500_000n => "$1.50"
 */
export function formatUSDC(amount: bigint): string {
  const divisor = BigInt(1_000_000);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(6, '0').slice(0, 2);
  return `$${whole.toLocaleString()}.${fractionStr}`;
}

/**
 * Format a unix timestamp (bigint or number) into a readable date string.
 */
export function formatTimestamp(ts: bigint | number): string {
  const seconds = typeof ts === 'bigint' ? Number(ts) : ts;
  if (seconds === 0) return '--';
  return new Date(seconds * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Return a human-readable remaining-time string like "2d 5h" or "Expired".
 */
export function timeRemaining(deadline: bigint | number): string {
  const deadlineSec = typeof deadline === 'bigint' ? Number(deadline) : deadline;
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = deadlineSec - nowSec;

  if (diff <= 0) return 'Expired';

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Derive a reputation tier from a numeric score.
 */
export function getReputationTier(score: number): { label: string; color: string } {
  if (score >= 5000) return { label: 'Diamond', color: 'text-cyan-300' };
  if (score >= 1000) return { label: 'Gold', color: 'text-yellow-400' };
  if (score >= 500) return { label: 'Silver', color: 'text-zinc-300' };
  if (score >= 100) return { label: 'Bronze', color: 'text-orange-400' };
  return { label: 'Novice', color: 'text-zinc-500' };
}
