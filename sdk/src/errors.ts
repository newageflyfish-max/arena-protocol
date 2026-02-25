/**
 * The Arena SDK — Custom Error Classes
 *
 * Maps to contract revert reasons ARENA_001 through ARENA_014.
 */

export class ArenaError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArenaError';
    this.code = code;
  }
}

// Contract revert reason mapping
const ERROR_MAP: Record<string, { code: string; message: string }> = {
  'Arena: bounty must be > 0': { code: 'ARENA_001', message: 'Bounty must be greater than zero' },
  'Arena: deadline must be future': { code: 'ARENA_002', message: 'Deadline must be in the future' },
  'Arena: invalid verifier count': { code: 'ARENA_003', message: 'Verifier count must be 1-5' },
  'Arena: bid duration must be > 0': { code: 'ARENA_004', message: 'Bid duration must be greater than zero' },
  'Arena: reveal duration must be > 0': { code: 'ARENA_005', message: 'Reveal duration must be greater than zero' },
  'Arena: bidding closed': { code: 'ARENA_006', message: 'Bidding period has closed' },
  'Arena: already bid': { code: 'ARENA_007', message: 'Agent has already submitted a bid' },
  'Arena: not in reveal period': { code: 'ARENA_008', message: 'Not currently in the reveal period' },
  'Arena: invalid reveal': { code: 'ARENA_009', message: 'Bid reveal does not match commitment' },
  'Arena: stake below minimum': { code: 'ARENA_010', message: 'Stake is below the minimum required (bounty / 10)' },
  'Arena: price exceeds bounty': { code: 'ARENA_011', message: 'Price cannot exceed the task bounty' },
  'Arena: no valid bids': { code: 'ARENA_012', message: 'No valid revealed bids found' },
  'Arena: empty output': { code: 'ARENA_013', message: 'Output hash cannot be empty' },
  'Arena: agent is banned': { code: 'ARENA_014', message: 'Agent is banned from the protocol' },
};

/**
 * Parse a contract revert reason into a typed ArenaError.
 */
export function parseContractError(error: any): ArenaError {
  const reason = error?.reason || error?.message || '';

  for (const [revertReason, mapped] of Object.entries(ERROR_MAP)) {
    if (reason.includes(revertReason)) {
      return new ArenaError(mapped.code, mapped.message);
    }
  }

  // Check for common Ownable/Pausable errors
  if (reason.includes('OwnableUnauthorizedAccount')) {
    return new ArenaError('ARENA_AUTH', 'Caller is not the contract owner');
  }
  if (reason.includes('EnforcedPause')) {
    return new ArenaError('ARENA_PAUSED', 'Protocol is currently paused');
  }

  return new ArenaError('ARENA_UNKNOWN', `Unknown contract error: ${reason}`);
}

// Typed error subclasses for specific scenarios
export class BountyError extends ArenaError {
  constructor(message?: string) {
    super('ARENA_001', message || 'Invalid bounty amount');
    this.name = 'BountyError';
  }
}

export class DeadlineError extends ArenaError {
  constructor(message?: string) {
    super('ARENA_002', message || 'Invalid deadline');
    this.name = 'DeadlineError';
  }
}

export class BidError extends ArenaError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'BidError';
  }
}

export class StakeError extends ArenaError {
  constructor(message?: string) {
    super('ARENA_010', message || 'Stake below minimum');
    this.name = 'StakeError';
  }
}

export class AuthorizationError extends ArenaError {
  constructor(message?: string) {
    super('ARENA_AUTH', message || 'Not authorized');
    this.name = 'AuthorizationError';
  }
}

export class PausedError extends ArenaError {
  constructor() {
    super('ARENA_PAUSED', 'Protocol is currently paused');
    this.name = 'PausedError';
  }
}

export class BannedError extends ArenaError {
  constructor() {
    super('ARENA_014', 'Agent is banned from the protocol');
    this.name = 'BannedError';
  }
}
