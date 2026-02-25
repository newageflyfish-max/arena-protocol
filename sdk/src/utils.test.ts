/**
 * The Arena SDK — Utils Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  formatAmount,
  parseAmount,
  generateSalt,
  computeCommitHash,
  parseStatus,
  parseVote,
  formatReceipt,
} from './utils';

describe('parseDuration', () => {
  it('should parse seconds', () => {
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('1s')).toBe(1);
    expect(parseDuration('0s')).toBe(0);
  });

  it('should parse minutes', () => {
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('1m')).toBe(60);
  });

  it('should parse hours', () => {
    expect(parseDuration('4h')).toBe(14400);
    expect(parseDuration('1h')).toBe(3600);
  });

  it('should parse days', () => {
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('30d')).toBe(2592000);
  });

  it('should handle decimal values', () => {
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('0.5d')).toBe(43200);
    expect(parseDuration('2.5m')).toBe(150);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('10')).toThrow('Invalid duration');
    expect(() => parseDuration('10x')).toThrow('Invalid duration');
    expect(() => parseDuration('-5s')).toThrow('Invalid duration');
  });
});

describe('formatAmount', () => {
  it('should format whole amounts (6 decimals)', () => {
    expect(formatAmount(1000000n)).toBe('1');
    expect(formatAmount(2500000000n)).toBe('2500');
  });

  it('should format fractional amounts', () => {
    expect(formatAmount(1500000n)).toBe('1.5');
    expect(formatAmount(1234567n)).toBe('1.234567');
  });

  it('should handle zero', () => {
    expect(formatAmount(0n)).toBe('0');
  });

  it('should strip trailing zeros', () => {
    expect(formatAmount(1100000n)).toBe('1.1');
    expect(formatAmount(1000100n)).toBe('1.0001');
  });

  it('should handle custom decimals', () => {
    expect(formatAmount(1000000000000000000n, 18)).toBe('1');
    expect(formatAmount(1500000000000000000n, 18)).toBe('1.5');
  });

  it('should handle amounts less than 1', () => {
    expect(formatAmount(500000n)).toBe('0.5');
    expect(formatAmount(1n)).toBe('0.000001');
  });
});

describe('parseAmount', () => {
  it('should parse whole numbers', () => {
    expect(parseAmount('1')).toBe(1000000n);
    expect(parseAmount('2500')).toBe(2500000000n);
  });

  it('should parse fractional amounts', () => {
    expect(parseAmount('1.5')).toBe(1500000n);
    expect(parseAmount('1.234567')).toBe(1234567n);
  });

  it('should parse zero', () => {
    expect(parseAmount('0')).toBe(0n);
  });

  it('should handle amounts with fewer decimal places', () => {
    expect(parseAmount('1.1')).toBe(1100000n);
  });

  it('should truncate excess decimals', () => {
    expect(parseAmount('1.1234567')).toBe(1123456n);
  });

  it('should handle custom decimals', () => {
    expect(parseAmount('1', 18)).toBe(1000000000000000000n);
    expect(parseAmount('1.5', 18)).toBe(1500000000000000000n);
  });

  it('should roundtrip with formatAmount', () => {
    const original = '1234.567';
    const wei = parseAmount(original);
    const formatted = formatAmount(wei);
    expect(formatted).toBe('1234.567');
  });
});

describe('generateSalt', () => {
  it('should return a 0x-prefixed hex string', () => {
    const salt = generateSalt();
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should generate unique salts', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(salt1).not.toBe(salt2);
  });

  it('should be 66 characters long (0x + 64 hex chars)', () => {
    const salt = generateSalt();
    expect(salt.length).toBe(66);
  });
});

describe('computeCommitHash', () => {
  it('should produce a bytes32 hash', () => {
    const mockEthers = {
      solidityPackedKeccak256: (types: string[], values: any[]) => {
        return '0x' + 'a'.repeat(64);
      },
    };

    const hash = computeCommitHash(
      mockEthers,
      '0x1234567890123456789012345678901234567890',
      1000000n,
      500000n,
      3600,
      '0x' + '0'.repeat(64)
    );

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should call ethers.solidityPackedKeccak256 with correct args', () => {
    let calledWith: any = null;
    const mockEthers = {
      solidityPackedKeccak256: (types: string[], values: any[]) => {
        calledWith = { types, values };
        return '0x' + 'b'.repeat(64);
      },
    };

    const agent = '0x1234567890123456789012345678901234567890';
    const stake = 1000000n;
    const price = 500000n;
    const eta = 3600;
    const salt = '0x' + 'c'.repeat(64);

    computeCommitHash(mockEthers, agent, stake, price, eta, salt);

    expect(calledWith.types).toEqual(['address', 'uint256', 'uint256', 'uint256', 'bytes32']);
    expect(calledWith.values).toEqual([agent, stake, price, eta, salt]);
  });
});

describe('parseStatus', () => {
  it('should parse all status values', () => {
    expect(parseStatus(0)).toBe('open');
    expect(parseStatus(1)).toBe('bid_reveal');
    expect(parseStatus(2)).toBe('assigned');
    expect(parseStatus(3)).toBe('delivered');
    expect(parseStatus(4)).toBe('verifying');
    expect(parseStatus(5)).toBe('completed');
    expect(parseStatus(6)).toBe('failed');
    expect(parseStatus(7)).toBe('disputed');
    expect(parseStatus(8)).toBe('cancelled');
  });

  it('should default to open for unknown values', () => {
    expect(parseStatus(99)).toBe('open');
  });
});

describe('parseVote', () => {
  it('should parse all vote values', () => {
    expect(parseVote(0)).toBe('pending');
    expect(parseVote(1)).toBe('approved');
    expect(parseVote(2)).toBe('rejected');
  });

  it('should default to pending for unknown values', () => {
    expect(parseVote(99)).toBe('pending');
  });
});

describe('formatReceipt', () => {
  it('should format a successful receipt', () => {
    const receipt = {
      transactionHash: '0xabc',
      blockNumber: 42,
      gasUsed: 21000n,
      status: 1,
    };

    const result = formatReceipt(receipt);
    expect(result.hash).toBe('0xabc');
    expect(result.blockNumber).toBe(42);
    expect(result.gasUsed).toBe('21000');
    expect(result.status).toBe('success');
  });

  it('should format a reverted receipt', () => {
    const receipt = {
      hash: '0xdef',
      blockNumber: 100,
      gasUsed: 50000n,
      status: 0,
    };

    const result = formatReceipt(receipt);
    expect(result.hash).toBe('0xdef');
    expect(result.status).toBe('reverted');
  });

  it('should fallback to hash if transactionHash not present', () => {
    const receipt = {
      hash: '0x123',
      blockNumber: 1,
      status: 1,
    };

    const result = formatReceipt(receipt);
    expect(result.hash).toBe('0x123');
    expect(result.gasUsed).toBe('0');
  });
});
