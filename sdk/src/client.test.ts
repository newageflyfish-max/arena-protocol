/**
 * The Arena SDK — Arena Client Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Arena } from './client';
import { ArenaError } from './errors';

// Mock crypto for pinToIPFS fallback
vi.stubGlobal('crypto', {
  getRandomValues: (arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
    return arr;
  },
  subtle: {
    digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
  },
});

describe('Arena Client', () => {
  let arena: Arena;
  let mockSigner: any;
  let mockContract: any;
  let mockToken: any;

  const mockReceipt = {
    transactionHash: '0xtxhash',
    blockNumber: 42,
    gasUsed: 100000n,
    status: 1,
  };

  beforeEach(() => {
    mockSigner = {
      getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    };

    mockContract = {
      createTask: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          ...mockReceipt,
          logs: [{
            topics: ['0x...'],
            data: '0x...',
          }],
        }),
      }),
      cancelTask: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      commitBid: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      revealBid: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      resolveAuction: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      deliverTask: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      registerVerifier: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      submitVerification: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      raiseDispute: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      enforceDeadline: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      claimSlashBond: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue(mockReceipt),
      }),
      getTask: vi.fn().mockResolvedValue({
        poster: '0xposter',
        token: '0xtoken',
        bounty: 1000000000n,
        deadline: 1700000000n,
        slashWindow: 604800n,
        createdAt: 1699900000n,
        bidDeadline: 1699903600n,
        revealDeadline: 1699905400n,
        requiredVerifiers: 2n,
        status: 0n,
        criteriaHash: '0xcriteria',
        taskType: 'audit',
      }),
      getAssignment: vi.fn().mockResolvedValue({
        agent: '0xagent',
        stake: 100000000n,
        price: 500000000n,
        assignedAt: 1699905500n,
        deliveredAt: 0n,
        outputHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }),
      getAgentStats: vi.fn().mockResolvedValue({
        reputation: 50n,
        completed: 10n,
        failed: 2n,
        activeStake: 250000000n,
        banned: false,
      }),
      getTaskBidders: vi.fn().mockResolvedValue(['0xbidder1', '0xbidder2']),
      getBid: vi.fn().mockResolvedValue({
        agent: '0xbidder1',
        stake: 100000000n,
        price: 500000000n,
        eta: 3600n,
        revealed: true,
      }),
      getVerifications: vi.fn().mockResolvedValue([
        {
          verifier: '0xverifier1',
          stake: 20000000n,
          vote: 1n,
          reportHash: '0xreport',
        },
      ]),
      taskCount: vi.fn().mockResolvedValue(5n),
      interface: {
        parseLog: vi.fn().mockReturnValue({
          name: 'TaskCreated',
          args: { taskId: 1n },
        }),
      },
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    mockToken = {
      allowance: vi.fn().mockResolvedValue(0n),
      approve: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({}),
      }),
    };

    // Create Arena instance and inject mocks
    arena = new Arena({
      rpcUrl: 'http://localhost:8545',
      contractAddress: '0xcontract',
      signer: mockSigner,
      tokenAddress: '0xtoken',
    });

    // Inject mock contract and token (access private fields)
    (arena as any).contract = mockContract;
    (arena as any).token = mockToken;
  });

  describe('cancelTask', () => {
    it('should cancel a task', async () => {
      const result = await arena.cancelTask('1');
      expect(result.hash).toBe('0xtxhash');
      expect(result.status).toBe('success');
      expect(mockContract.cancelTask).toHaveBeenCalledWith('1');
    });

    it('should throw ArenaError on contract revert', async () => {
      mockContract.cancelTask.mockRejectedValue({
        reason: 'Arena: not task poster',
      });

      try {
        await arena.cancelTask('1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ArenaError);
      }
    });
  });

  describe('resolveAuction', () => {
    it('should resolve an auction', async () => {
      const result = await arena.resolveAuction('1');
      expect(result.hash).toBe('0xtxhash');
      expect(mockContract.resolveAuction).toHaveBeenCalledWith('1');
    });
  });

  describe('raiseDispute', () => {
    it('should raise a dispute', async () => {
      const result = await arena.raiseDispute('1');
      expect(result.hash).toBe('0xtxhash');
      expect(mockContract.raiseDispute).toHaveBeenCalledWith('1');
    });
  });

  describe('enforceDeadline', () => {
    it('should enforce deadline', async () => {
      const result = await arena.enforceDeadline('1');
      expect(result.hash).toBe('0xtxhash');
      expect(mockContract.enforceDeadline).toHaveBeenCalledWith('1');
    });
  });

  describe('claimSlashBond', () => {
    it('should claim slash bond', async () => {
      const result = await arena.claimSlashBond('1');
      expect(result.hash).toBe('0xtxhash');
      expect(mockContract.claimSlashBond).toHaveBeenCalledWith('1');
    });
  });

  describe('getTask', () => {
    it('should return formatted task info', async () => {
      const task = await arena.getTask('1');
      expect(task.id).toBe('1');
      expect(task.poster).toBe('0xposter');
      expect(task.bounty).toBe('1000');
      expect(task.status).toBe('open');
      expect(task.taskType).toBe('audit');
      expect(task.requiredVerifiers).toBe(2);
    });
  });

  describe('getAssignment', () => {
    it('should return formatted assignment info', async () => {
      const assignment = await arena.getAssignment('1');
      expect(assignment.agent).toBe('0xagent');
      expect(assignment.stake).toBe('100');
      expect(assignment.price).toBe('500');
    });
  });

  describe('getAgentStats', () => {
    it('should return formatted agent stats with success rate', async () => {
      const stats = await arena.getAgentStats('0xagent');
      expect(stats.reputation).toBe(50);
      expect(stats.tasksCompleted).toBe(10);
      expect(stats.tasksFailed).toBe(2);
      expect(stats.banned).toBe(false);
      // successRate = (10 / 12) * 100 ≈ 83.33
      expect(stats.successRate).toBeCloseTo(83.33, 1);
    });

    it('should handle zero total tasks', async () => {
      mockContract.getAgentStats.mockResolvedValue({
        reputation: 0n,
        completed: 0n,
        failed: 0n,
        activeStake: 0n,
        banned: false,
      });

      const stats = await arena.getAgentStats('0xnewagent');
      expect(stats.successRate).toBe(0);
    });
  });

  describe('getTaskBids', () => {
    it('should return formatted bid list', async () => {
      const bids = await arena.getTaskBids('1');
      expect(bids.length).toBe(2); // Two bidders, both "revealed"
      expect(bids[0].agent).toBe('0xbidder1');
      expect(bids[0].stake).toBe('100');
      expect(bids[0].price).toBe('500');
      expect(bids[0].eta).toBe(3600);
    });

    it('should skip unrevealed bids', async () => {
      mockContract.getBid
        .mockResolvedValueOnce({ agent: '0xb1', stake: 100n, price: 50n, eta: 3600n, revealed: true })
        .mockResolvedValueOnce({ agent: '0xb2', stake: 200n, price: 100n, eta: 7200n, revealed: false });

      const bids = await arena.getTaskBids('1');
      expect(bids.length).toBe(1);
    });
  });

  describe('getVerifications', () => {
    it('should return formatted verification list', async () => {
      const verifs = await arena.getVerifications('1');
      expect(verifs.length).toBe(1);
      expect(verifs[0].verifier).toBe('0xverifier1');
      expect(verifs[0].vote).toBe('approved');
      expect(verifs[0].stake).toBe('20');
    });
  });

  describe('error handling', () => {
    it('should convert contract errors to ArenaError', async () => {
      mockContract.cancelTask.mockRejectedValue({
        reason: 'Arena: bounty must be > 0',
      });

      try {
        await arena.cancelTask('1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ArenaError);
        expect(err.code).toBe('ARENA_001');
      }
    });

    it('should handle unknown contract errors', async () => {
      mockContract.cancelTask.mockRejectedValue({
        reason: 'Some random error',
      });

      try {
        await arena.cancelTask('1');
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ArenaError);
        expect(err.code).toBe('ARENA_UNKNOWN');
      }
    });
  });
});
