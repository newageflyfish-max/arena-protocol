/**
 * The Arena SDK — Errors Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ArenaError,
  parseContractError,
  BountyError,
  DeadlineError,
  BidError,
  StakeError,
  AuthorizationError,
  PausedError,
  BannedError,
} from './errors';

describe('ArenaError', () => {
  it('should create an error with code and message', () => {
    const err = new ArenaError('ARENA_001', 'Test error');
    expect(err.code).toBe('ARENA_001');
    expect(err.message).toBe('Test error');
    expect(err.name).toBe('ArenaError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('parseContractError', () => {
  it('should map "bounty must be > 0" to ARENA_001', () => {
    const err = parseContractError({ reason: 'Arena: bounty must be > 0' });
    expect(err.code).toBe('ARENA_001');
    expect(err.message).toBe('Bounty must be greater than zero');
  });

  it('should map "deadline must be future" to ARENA_002', () => {
    const err = parseContractError({ reason: 'Arena: deadline must be future' });
    expect(err.code).toBe('ARENA_002');
  });

  it('should map "invalid verifier count" to ARENA_003', () => {
    const err = parseContractError({ reason: 'Arena: invalid verifier count' });
    expect(err.code).toBe('ARENA_003');
  });

  it('should map "bid duration must be > 0" to ARENA_004', () => {
    const err = parseContractError({ reason: 'Arena: bid duration must be > 0' });
    expect(err.code).toBe('ARENA_004');
  });

  it('should map "reveal duration must be > 0" to ARENA_005', () => {
    const err = parseContractError({ reason: 'Arena: reveal duration must be > 0' });
    expect(err.code).toBe('ARENA_005');
  });

  it('should map "bidding closed" to ARENA_006', () => {
    const err = parseContractError({ reason: 'Arena: bidding closed' });
    expect(err.code).toBe('ARENA_006');
  });

  it('should map "already bid" to ARENA_007', () => {
    const err = parseContractError({ reason: 'Arena: already bid' });
    expect(err.code).toBe('ARENA_007');
  });

  it('should map "not in reveal period" to ARENA_008', () => {
    const err = parseContractError({ reason: 'Arena: not in reveal period' });
    expect(err.code).toBe('ARENA_008');
  });

  it('should map "invalid reveal" to ARENA_009', () => {
    const err = parseContractError({ reason: 'Arena: invalid reveal' });
    expect(err.code).toBe('ARENA_009');
  });

  it('should map "stake below minimum" to ARENA_010', () => {
    const err = parseContractError({ reason: 'Arena: stake below minimum' });
    expect(err.code).toBe('ARENA_010');
  });

  it('should map "price exceeds bounty" to ARENA_011', () => {
    const err = parseContractError({ reason: 'Arena: price exceeds bounty' });
    expect(err.code).toBe('ARENA_011');
  });

  it('should map "no valid bids" to ARENA_012', () => {
    const err = parseContractError({ reason: 'Arena: no valid bids' });
    expect(err.code).toBe('ARENA_012');
  });

  it('should map "empty output" to ARENA_013', () => {
    const err = parseContractError({ reason: 'Arena: empty output' });
    expect(err.code).toBe('ARENA_013');
  });

  it('should map "agent is banned" to ARENA_014', () => {
    const err = parseContractError({ reason: 'Arena: agent is banned' });
    expect(err.code).toBe('ARENA_014');
  });

  it('should handle OwnableUnauthorizedAccount', () => {
    const err = parseContractError({ reason: 'OwnableUnauthorizedAccount(0x...)' });
    expect(err.code).toBe('ARENA_AUTH');
  });

  it('should handle EnforcedPause', () => {
    const err = parseContractError({ reason: 'EnforcedPause()' });
    expect(err.code).toBe('ARENA_PAUSED');
  });

  it('should handle unknown errors', () => {
    const err = parseContractError({ reason: 'Something unexpected' });
    expect(err.code).toBe('ARENA_UNKNOWN');
    expect(err.message).toContain('Something unexpected');
  });

  it('should handle errors with message instead of reason', () => {
    const err = parseContractError({ message: 'Arena: bounty must be > 0' });
    expect(err.code).toBe('ARENA_001');
  });

  it('should handle null/undefined errors', () => {
    const err = parseContractError(null);
    expect(err.code).toBe('ARENA_UNKNOWN');
  });

  it('should handle errors with nested reason in message', () => {
    const err = parseContractError({
      message: 'execution reverted: Arena: stake below minimum',
    });
    expect(err.code).toBe('ARENA_010');
  });
});

describe('Error subclasses', () => {
  it('BountyError should have correct code and name', () => {
    const err = new BountyError();
    expect(err.code).toBe('ARENA_001');
    expect(err.name).toBe('BountyError');
    expect(err).toBeInstanceOf(ArenaError);
    expect(err).toBeInstanceOf(Error);
  });

  it('BountyError should accept custom message', () => {
    const err = new BountyError('Custom bounty message');
    expect(err.message).toBe('Custom bounty message');
  });

  it('DeadlineError should have correct code', () => {
    const err = new DeadlineError();
    expect(err.code).toBe('ARENA_002');
    expect(err.name).toBe('DeadlineError');
  });

  it('BidError should accept code and message', () => {
    const err = new BidError('ARENA_006', 'Bidding closed');
    expect(err.code).toBe('ARENA_006');
    expect(err.message).toBe('Bidding closed');
    expect(err.name).toBe('BidError');
  });

  it('StakeError should have correct code', () => {
    const err = new StakeError();
    expect(err.code).toBe('ARENA_010');
    expect(err.name).toBe('StakeError');
  });

  it('AuthorizationError should have correct code', () => {
    const err = new AuthorizationError();
    expect(err.code).toBe('ARENA_AUTH');
    expect(err.name).toBe('AuthorizationError');
  });

  it('PausedError should have correct code and message', () => {
    const err = new PausedError();
    expect(err.code).toBe('ARENA_PAUSED');
    expect(err.message).toBe('Protocol is currently paused');
    expect(err.name).toBe('PausedError');
  });

  it('BannedError should have correct code and message', () => {
    const err = new BannedError();
    expect(err.code).toBe('ARENA_014');
    expect(err.message).toBe('Agent is banned from the protocol');
    expect(err.name).toBe('BannedError');
  });
});
