/**
 * The Arena SDK — Utility Functions
 */

/**
 * Parse duration string to seconds.
 * Supports: "90s", "30m", "4h", "1d", "30d"
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const value = parseFloat(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return Math.floor(value);
    case 'm': return Math.floor(value * 60);
    case 'h': return Math.floor(value * 3600);
    case 'd': return Math.floor(value * 86400);
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

/**
 * Format token amount from wei to human-readable.
 * Default 6 decimals (USDC).
 */
export function formatAmount(weiAmount: bigint, decimals: number = 6): string {
  const divisor = BigInt(10 ** decimals);
  const whole = weiAmount / divisor;
  const fraction = weiAmount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractionStr ? `${whole}.${fractionStr}` : `${whole}`;
}

/**
 * Parse human-readable amount to wei.
 * Default 6 decimals (USDC).
 */
export function parseAmount(amount: string, decimals: number = 6): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

/**
 * Generate a random 32-byte salt for bid commitment.
 */
export function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute bid commitment hash using ethers.js solidityPackedKeccak256.
 */
export function computeCommitHash(
  ethers: any,
  agent: string,
  stake: bigint,
  price: bigint,
  eta: number,
  salt: string
): string {
  return ethers.solidityPackedKeccak256(
    ['address', 'uint256', 'uint256', 'uint256', 'bytes32'],
    [agent, stake, price, eta, salt]
  );
}

/**
 * Parse on-chain task status enum to string.
 */
export function parseStatus(status: number): import('./types').TaskStatus {
  const statuses: import('./types').TaskStatus[] = [
    'open', 'bid_reveal', 'assigned', 'delivered',
    'verifying', 'completed', 'failed', 'disputed', 'cancelled',
  ];
  return statuses[status] || 'open';
}

/**
 * Parse on-chain verifier vote enum to string.
 */
export function parseVote(vote: number): import('./types').VerifierVote {
  const votes: import('./types').VerifierVote[] = ['pending', 'approved', 'rejected'];
  return votes[vote] || 'pending';
}

/**
 * Format an ethers.js receipt into a TransactionResult.
 */
export function formatReceipt(receipt: any): import('./types').TransactionResult {
  return {
    hash: receipt.transactionHash || receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed?.toString() || '0',
    status: receipt.status === 1 ? 'success' : 'reverted',
  };
}
