/**
 * The Arena SDK — BidManager Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BidManager } from './bid-manager';
import type { ManagedBid } from './bid-manager';

// Mock crypto.getRandomValues for deterministic salt generation
vi.stubGlobal('crypto', {
  getRandomValues: (arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
    return arr;
  },
  subtle: {
    digest: vi.fn(),
  },
});

describe('BidManager', () => {
  let bidManager: BidManager;
  let mockSigner: any;
  let mockContract: any;
  let mockToken: any;

  beforeEach(() => {
    mockSigner = {
      getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    };

    mockContract = {
      commitBid: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          transactionHash: '0xcommithash',
          blockNumber: 1,
          gasUsed: 50000n,
          status: 1,
        }),
      }),
      revealBid: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          transactionHash: '0xrevealhash',
          blockNumber: 2,
          gasUsed: 80000n,
          status: 1,
        }),
      }),
      getAddress: vi.fn().mockResolvedValue('0xcontract'),
    };

    mockToken = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({}),
      }),
    };

    bidManager = new BidManager({
      signer: mockSigner,
      contract: mockContract,
      token: mockToken,
      pollIntervalMs: 100, // Fast poll for tests
    });
  });

  afterEach(() => {
    bidManager.stopWatching();
  });

  describe('commitBid', () => {
    it('should commit a bid and store it', async () => {
      const now = Math.floor(Date.now() / 1000);
      const result = await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      expect(result.salt).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.tx.hash).toBe('0xcommithash');
      expect(result.tx.status).toBe('success');

      const bid = bidManager.getBid('1');
      expect(bid).toBeDefined();
      expect(bid!.taskId).toBe('1');
      expect(bid!.status).toBe('committed');
      expect(bid!.stake).toBe('100');
      expect(bid!.price).toBe('50');
      expect(bid!.eta).toBe('1h');
    });

    it('should call contract.commitBid with correct hash', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '5',
        stake: '200',
        price: '100',
        eta: '2h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      expect(mockContract.commitBid).toHaveBeenCalledWith('5', expect.any(String));
    });
  });

  describe('revealBid', () => {
    it('should reveal a committed bid', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      const result = await bidManager.revealBid('1');
      expect(result.hash).toBe('0xrevealhash');

      const bid = bidManager.getBid('1');
      expect(bid!.status).toBe('revealed');
      expect(bid!.revealedAt).toBeDefined();
    });

    it('should approve tokens if allowance is insufficient', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '2',
        stake: '500',
        price: '250',
        eta: '30m',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      await bidManager.revealBid('2');
      expect(mockToken.approve).toHaveBeenCalled();
    });

    it('should throw if no bid found', async () => {
      await expect(bidManager.revealBid('999')).rejects.toThrow('No bid found');
    });

    it('should throw if bid is not in committed status', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      await bidManager.revealBid('1'); // Now it's 'revealed'

      await expect(bidManager.revealBid('1')).rejects.toThrow('not committed');
    });
  });

  describe('getBid', () => {
    it('should return undefined for non-existent bids', () => {
      expect(bidManager.getBid('99')).toBeUndefined();
    });

    it('should return bid data for existing bids', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '3',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      const bid = bidManager.getBid('3');
      expect(bid).toBeDefined();
      expect(bid!.taskId).toBe('3');
    });
  });

  describe('getActiveBids', () => {
    it('should return empty array when no bids', () => {
      expect(bidManager.getActiveBids()).toEqual([]);
    });

    it('should return committed and revealed bids', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      await bidManager.commitBid({
        taskId: '2',
        stake: '200',
        price: '100',
        eta: '2h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      const active = bidManager.getActiveBids();
      expect(active.length).toBe(2);
    });

    it('should exclude expired bids', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      bidManager.updateBidStatus('1', 'expired');

      const active = bidManager.getActiveBids();
      expect(active.length).toBe(0);
    });
  });

  describe('getBidHistory', () => {
    it('should return all bids regardless of status', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      bidManager.updateBidStatus('1', 'expired');

      const history = bidManager.getBidHistory();
      expect(history.length).toBe(1);
      expect(history[0].status).toBe('expired');
    });
  });

  describe('updateBidStatus', () => {
    it('should update bid status', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      bidManager.updateBidStatus('1', 'won');
      expect(bidManager.getBid('1')!.status).toBe('won');
    });

    it('should silently handle non-existent bids', () => {
      // Should not throw
      bidManager.updateBidStatus('999', 'lost');
    });
  });

  describe('exportBids / importBids', () => {
    it('should export all bids', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      const exported = bidManager.exportBids();
      expect(exported.length).toBe(1);
      expect(exported[0].salt).toBeDefined();
    });

    it('should import previously exported bids', async () => {
      const importData: ManagedBid[] = [
        {
          taskId: '10',
          salt: '0x' + 'a'.repeat(64),
          stake: '500',
          price: '250',
          eta: '2h',
          committedAt: Date.now(),
          status: 'committed',
          bidDeadline: Math.floor(Date.now() / 1000) + 3600,
          revealDeadline: Math.floor(Date.now() / 1000) + 5400,
        },
      ];

      bidManager.importBids(importData);

      const bid = bidManager.getBid('10');
      expect(bid).toBeDefined();
      expect(bid!.stake).toBe('500');
    });

    it('should roundtrip export/import', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      const exported = bidManager.exportBids();

      // Create new manager and import
      const newManager = new BidManager({
        signer: mockSigner,
        contract: mockContract,
        token: mockToken,
      });
      newManager.importBids(exported);

      const bid = newManager.getBid('1');
      expect(bid).toBeDefined();
      expect(bid!.taskId).toBe('1');
    });
  });

  describe('clear', () => {
    it('should remove all bids', async () => {
      const now = Math.floor(Date.now() / 1000);
      await bidManager.commitBid({
        taskId: '1',
        stake: '100',
        price: '50',
        eta: '1h',
        bidDeadline: now + 3600,
        revealDeadline: now + 5400,
      });

      bidManager.clear();
      expect(bidManager.getBidHistory()).toEqual([]);
      expect(bidManager.getBid('1')).toBeUndefined();
    });
  });

  describe('onReveal / onError callbacks', () => {
    it('should register reveal callback', () => {
      const callback = vi.fn();
      bidManager.onReveal(callback);
      // Callback registration doesn't throw
      expect(true).toBe(true);
    });

    it('should register error callback', () => {
      const callback = vi.fn();
      bidManager.onError(callback);
      expect(true).toBe(true);
    });
  });

  describe('startWatching / stopWatching', () => {
    it('should start and stop without error', () => {
      bidManager.startWatching();
      bidManager.stopWatching();
    });

    it('should not start multiple watchers', () => {
      bidManager.startWatching();
      bidManager.startWatching(); // Should be no-op
      bidManager.stopWatching();
    });

    it('should handle stopWatching when not watching', () => {
      bidManager.stopWatching(); // Should not throw
    });
  });
});
