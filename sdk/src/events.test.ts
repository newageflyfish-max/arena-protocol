/**
 * The Arena SDK — Events Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArenaEventListener } from './events';
import type { ArenaEventType } from './events';

describe('ArenaEventListener', () => {
  let mockContract: any;
  let listener: ArenaEventListener;

  beforeEach(() => {
    mockContract = {
      on: vi.fn(),
      off: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    listener = new ArenaEventListener(mockContract);
  });

  describe('on', () => {
    it('should register a listener for an event type', () => {
      const callback = vi.fn();
      listener.on('TaskCreated', callback);

      expect(mockContract.on).toHaveBeenCalledWith('TaskCreated', expect.any(Function));
    });

    it('should return an unsubscribe function', () => {
      const callback = vi.fn();
      const unsub = listener.on('TaskCreated', callback);

      expect(typeof unsub).toBe('function');
    });

    it('should only attach contract listener once per event type', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      listener.on('TaskCreated', cb1);
      listener.on('TaskCreated', cb2);

      // Contract.on should only be called once for TaskCreated
      const taskCreatedCalls = mockContract.on.mock.calls.filter(
        (call: any[]) => call[0] === 'TaskCreated'
      );
      expect(taskCreatedCalls.length).toBe(1);
    });

    it('should invoke callback when contract event fires', () => {
      const callback = vi.fn();
      listener.on('TaskCreated', callback);

      // Simulate contract event
      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('1', '0xposter', 1000n, 'audit', 1234567, 2);

      expect(callback).toHaveBeenCalled();
      const eventData = callback.mock.calls[0][0];
      expect(eventData.taskId).toBe('1');
      expect(eventData.poster).toBe('0xposter');
    });

    it('should handle unsubscribe correctly', () => {
      const callback = vi.fn();
      const unsub = listener.on('TaskCreated', callback);

      // Simulate event before unsubscribe
      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('1', '0xposter', 1000n, 'audit', 1234567, 2);
      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Simulate event after unsubscribe
      contractCallback('2', '0xposter2', 2000n, 'risk', 1234568, 3);
      expect(callback).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('once', () => {
    it('should call callback only once', () => {
      const callback = vi.fn();
      listener.once('BidCommitted', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];

      // First event
      contractCallback('1', '0xagent', '0xhash');
      expect(callback).toHaveBeenCalledTimes(1);

      // Second event — should not fire
      contractCallback('2', '0xagent2', '0xhash2');
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('should remove all listeners for a specific event', () => {
      const callback = vi.fn();
      listener.on('TaskCreated', callback);

      listener.off('TaskCreated');
      expect(mockContract.off).toHaveBeenCalledWith('TaskCreated');
    });

    it('should remove all listeners when no event type specified', () => {
      listener.on('TaskCreated', vi.fn());
      listener.on('BidCommitted', vi.fn());

      listener.off();
      expect(mockContract.removeAllListeners).toHaveBeenCalled();
    });
  });

  describe('event parsing', () => {
    it('should parse BidRevealed events', () => {
      const callback = vi.fn();
      listener.on('BidRevealed', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('5', '0xagent', 1000n, 500n, 3600);

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('5');
      expect(data.agent).toBe('0xagent');
      expect(data.stake).toBe(1000n);
      expect(data.price).toBe(500n);
      expect(data.eta).toBe(3600);
    });

    it('should parse AgentAssigned events', () => {
      const callback = vi.fn();
      listener.on('AgentAssigned', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('3', '0xagent', 100n, 50n);

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('3');
      expect(data.agent).toBe('0xagent');
      expect(data.stake).toBe(100n);
      expect(data.price).toBe(50n);
    });

    it('should parse TaskDelivered events', () => {
      const callback = vi.fn();
      listener.on('TaskDelivered', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('7', '0xagent', '0xoutputhash');

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('7');
      expect(data.outputHash).toBe('0xoutputhash');
    });

    it('should parse TaskCompleted events', () => {
      const callback = vi.fn();
      listener.on('TaskCompleted', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('10', '0xagent', 2500n);

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('10');
      expect(data.payout).toBe(2500n);
    });

    it('should parse AgentSlashed events', () => {
      const callback = vi.fn();
      listener.on('AgentSlashed', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('12', '0xagent', 500n, 2);

      const data = callback.mock.calls[0][0];
      expect(data.amount).toBe(500n);
      expect(data.severity).toBe(2);
    });

    it('should parse TaskCancelled events', () => {
      const callback = vi.fn();
      listener.on('TaskCancelled', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('15');

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('15');
    });

    it('should parse SlashBondClaimed events', () => {
      const callback = vi.fn();
      listener.on('SlashBondClaimed', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('20', '0xagent', 100n);

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('20');
      expect(data.agent).toBe('0xagent');
      expect(data.amount).toBe(100n);
    });

    it('should parse HoneypotSettled events', () => {
      const callback = vi.fn();
      listener.on('HoneypotSettled', callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('25', '0xagent', true);

      const data = callback.mock.calls[0][0];
      expect(data.taskId).toBe('25');
      expect(data.passed).toBe(true);
    });

    it('should return raw args for unknown event types', () => {
      const callback = vi.fn();
      // Force unknown event by casting
      listener.on('UnknownEvent' as ArenaEventType, callback);

      const contractCallback = mockContract.on.mock.calls[0][1];
      contractCallback('arg1', 'arg2');

      const data = callback.mock.calls[0][0];
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
