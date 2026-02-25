/**
 * The Arena SDK — Event Listener System
 *
 * Provides typed event listeners using ethers.js contract event filters.
 * Listens across all three core contracts:
 * - Main: TaskCreated, TaskCancelled
 * - Auction: BidCommitted, BidRevealed, AgentAssigned, TaskDelivered,
 *            VerifierAssigned, VerificationSubmitted, TaskCompleted,
 *            AgentSlashed, VerifierSlashed, TaskDisputed, SlashBondClaimed
 * - VRF: VerifierJoined, VerifierLeft
 */

import type {
  TaskType,
  SlashSeverity,
  VerifierVote,
} from './types';

// Event payload types

export interface TaskCreatedEvent {
  taskId: string;
  poster: string;
  bounty: bigint;
  taskType: string;
  deadline: number;
  requiredVerifiers: number;
}

export interface BidCommittedEvent {
  taskId: string;
  agent: string;
  commitHash: string;
}

export interface BidRevealedEvent {
  taskId: string;
  agent: string;
  stake: bigint;
  price: bigint;
  eta: number;
}

export interface AgentAssignedEvent {
  taskId: string;
  agent: string;
  stake: bigint;
  price: bigint;
}

export interface TaskDeliveredEvent {
  taskId: string;
  agent: string;
  outputHash: string;
}

export interface VerifierAssignedEvent {
  taskId: string;
  verifier: string;
  stake: bigint;
}

export interface VerificationSubmittedEvent {
  taskId: string;
  verifier: string;
  vote: number;
}

export interface TaskCompletedEvent {
  taskId: string;
  agent: string;
  payout: bigint;
}

export interface AgentSlashedEvent {
  taskId: string;
  agent: string;
  amount: bigint;
  severity: number;
}

export interface VerifierSlashedEvent {
  taskId: string;
  verifier: string;
  amount: bigint;
}

export interface TaskDisputedEvent {
  taskId: string;
  disputant: string;
}

export interface TaskCancelledEvent {
  taskId: string;
}

export interface SlashBondClaimedEvent {
  taskId: string;
  agent: string;
  amount: bigint;
}

export interface HoneypotSettledEvent {
  taskId: string;
  agent: string;
  passed: boolean;
}

// Union type for all events
export type ArenaEvent =
  | { type: 'TaskCreated'; data: TaskCreatedEvent }
  | { type: 'BidCommitted'; data: BidCommittedEvent }
  | { type: 'BidRevealed'; data: BidRevealedEvent }
  | { type: 'AgentAssigned'; data: AgentAssignedEvent }
  | { type: 'TaskDelivered'; data: TaskDeliveredEvent }
  | { type: 'VerifierAssigned'; data: VerifierAssignedEvent }
  | { type: 'VerificationSubmitted'; data: VerificationSubmittedEvent }
  | { type: 'TaskCompleted'; data: TaskCompletedEvent }
  | { type: 'AgentSlashed'; data: AgentSlashedEvent }
  | { type: 'VerifierSlashed'; data: VerifierSlashedEvent }
  | { type: 'TaskDisputed'; data: TaskDisputedEvent }
  | { type: 'TaskCancelled'; data: TaskCancelledEvent }
  | { type: 'SlashBondClaimed'; data: SlashBondClaimedEvent }
  | { type: 'HoneypotSettled'; data: HoneypotSettledEvent };

export type ArenaEventType = ArenaEvent['type'];

export type EventCallback<T = any> = (event: T) => void;

/** Maps event types to the contract that emits them. */
const MAIN_EVENTS = new Set<string>(['TaskCreated', 'TaskCancelled', 'TokenWhitelisted', 'TokenRemoved']);
const AUCTION_EVENTS = new Set<string>([
  'BidCommitted', 'BidRevealed', 'AgentAssigned', 'TaskDelivered',
  'VerifierAssigned', 'VerificationSubmitted', 'TaskCompleted',
  'AgentSlashed', 'VerifierSlashed', 'TaskDisputed',
  'ProtocolFeeCollected', 'SlashBondClaimed', 'SlashBondForfeited',
]);
const VRF_EVENTS = new Set<string>(['VerifierJoined', 'VerifierLeft']);

/**
 * Event listener manager for Arena protocol events.
 *
 * Listens across Main, Auction, and VRF contracts, routing each event
 * type to the correct contract for subscription.
 */
export class ArenaEventListener {
  private mainContract: any; // ethers.Contract (ArenaCoreMain)
  private auctionContract: any; // ethers.Contract (ArenaCoreAuction)
  private vrfContract: any; // ethers.Contract (ArenaCoreVRF)
  private listeners: Map<string, Set<EventCallback>> = new Map();

  constructor(main: any, auction: any, vrf: any) {
    this.mainContract = main;
    this.auctionContract = auction;
    this.vrfContract = vrf;
  }

  /**
   * Listen for a specific event type.
   */
  on(eventType: ArenaEventType, callback: EventCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
      this.attachContractListener(eventType);
    }

    this.listeners.get(eventType)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(eventType)?.delete(callback);
    };
  }

  /**
   * Listen for a specific event once.
   */
  once(eventType: ArenaEventType, callback: EventCallback): void {
    const unsub = this.on(eventType, (data: any) => {
      unsub();
      callback(data);
    });
  }

  /**
   * Remove all listeners for an event type (or all events).
   */
  off(eventType?: ArenaEventType): void {
    if (eventType) {
      this.listeners.delete(eventType);
      const contract = this.getContractForEvent(eventType);
      contract.off(eventType);
    } else {
      this.mainContract.removeAllListeners();
      this.auctionContract.removeAllListeners();
      this.vrfContract.removeAllListeners();
      this.listeners.clear();
    }
  }

  /** Resolve which contract emits a given event. */
  private getContractForEvent(eventType: string): any {
    if (MAIN_EVENTS.has(eventType)) return this.mainContract;
    if (AUCTION_EVENTS.has(eventType)) return this.auctionContract;
    if (VRF_EVENTS.has(eventType)) return this.vrfContract;
    // Default to auction (most events live there)
    return this.auctionContract;
  }

  private attachContractListener(eventType: string): void {
    const contract = this.getContractForEvent(eventType);

    contract.on(eventType, (...args: any[]) => {
      const callbacks = this.listeners.get(eventType);
      if (!callbacks) return;

      const parsed = this.parseEventArgs(eventType, args);
      for (const cb of callbacks) {
        cb(parsed);
      }
    });
  }

  private parseEventArgs(eventType: string, args: any[]): any {
    // ethers.js v6 passes event args positionally, with the last arg being the event log
    switch (eventType) {
      case 'TaskCreated':
        return { taskId: args[0].toString(), poster: args[1], bounty: args[2], taskType: args[3], deadline: Number(args[4]), requiredVerifiers: Number(args[5]) };
      case 'BidCommitted':
        return { taskId: args[0].toString(), agent: args[1], commitHash: args[2] };
      case 'BidRevealed':
        return { taskId: args[0].toString(), agent: args[1], stake: args[2], price: args[3], eta: Number(args[4]) };
      case 'AgentAssigned':
        return { taskId: args[0].toString(), agent: args[1], stake: args[2], price: args[3] };
      case 'TaskDelivered':
        return { taskId: args[0].toString(), agent: args[1], outputHash: args[2] };
      case 'VerifierAssigned':
        return { taskId: args[0].toString(), verifier: args[1], stake: args[2] };
      case 'VerificationSubmitted':
        return { taskId: args[0].toString(), verifier: args[1], vote: Number(args[2]) };
      case 'TaskCompleted':
        return { taskId: args[0].toString(), agent: args[1], payout: args[2] };
      case 'AgentSlashed':
        return { taskId: args[0].toString(), agent: args[1], amount: args[2], severity: Number(args[3]) };
      case 'VerifierSlashed':
        return { taskId: args[0].toString(), verifier: args[1], amount: args[2] };
      case 'TaskDisputed':
        return { taskId: args[0].toString(), disputant: args[1] };
      case 'TaskCancelled':
        return { taskId: args[0].toString() };
      case 'SlashBondClaimed':
        return { taskId: args[0].toString(), agent: args[1], amount: args[2] };
      case 'HoneypotSettled':
        return { taskId: args[0].toString(), agent: args[1], passed: args[2] };
      default:
        return args;
    }
  }
}
