/**
 * The Arena SDK — Deployed Contract Addresses
 *
 * Loads contract addresses from the deployment manifest.
 * Supports multiple networks via chain ID lookup.
 *
 * Architecture: 3 core contracts (Main, Auction, VRF) + 12 satellites.
 */

/** Contract address map for a single deployment. */
export interface DeploymentAddresses {
  /** ERC-20 settlement token (USDC or MockUSDC) */
  token: string;
  /** ArenaCoreMain — task creation, escrow, shared state */
  main: string;
  /** ArenaCoreAuction — sealed-bid auctions, delivery, settlement, slashing */
  auction: string;
  /** ArenaCoreVRF — verifier pool management, random selection */
  vrf: string;
  /** ArenaArbitration — dispute resolution */
  arbitration: string;
  /** ArenaReputation — ERC-721 reputation NFTs */
  reputation: string;
  /** ArenaConsensus — multi-agent consensus */
  consensus: string;
  /** ArenaProfiles — on-chain identity */
  profiles: string;
  /** ArenaRecurring — recurring task templates */
  recurring: string;
  /** ArenaSyndicates — pooled staking */
  syndicates: string;
  /** ArenaInsurance — insurance marketplace */
  insurance: string;
  /** ArenaDelegation — delegated staking */
  delegation: string;
  /** ArenaOutcomes — outcome-based slashing */
  outcomes: string;
  /** ArenaCompliance — moderation & sanctions */
  compliance: string;
  /** ArenaTimelock — governance timelock */
  timelock: string;
}

/**
 * Base Sepolia testnet deployment (chain ID 84532).
 * Addresses sourced from contracts/deployments/base-sepolia.json.
 */
export const BASE_SEPOLIA_ADDRESSES: DeploymentAddresses = {
  token:       '0xfF91Ec9aaee6fF0dB44b8197E4A1e9CfC9Dc0350',
  main:        '0x04776E515eDBDE81350974E3F8576bE3b9117F61',
  auction:     '0x0c48FE6468BD0Ee121eb04aAA10b7eF09B910f9B',
  vrf:         '0x7417d610a1835bEcadea6A017EFd05F2906EBcd9',
  arbitration: '0x5815E25D0987d1716A15726bed802eC2Ecc16E8f',
  reputation:  '0x4663A38C27462CC97b0d1bdeDd88F82Ec6246371',
  consensus:   '0xF7b561677aa7E151d1d0Eb60160dd0201D992938',
  profiles:    '0xc5C6e1638c364b4f353397B31F1c6C6a0d9432c2',
  recurring:   '0xF0939A408415707bE535fe5B863b1E751BEBCc4E',
  syndicates:  '0xeeD87bd1329f3526116Bc144F76B5504bec9A9b1',
  insurance:   '0x2A570A32425ADE40cbb28704183165Afdcd17ce1',
  delegation:  '0xf9cF0895EFf491cD8e610C0C68C5d447c70e46Cc',
  outcomes:    '0x6F29A9A8B01009971b606C1B5C47541E5Ab1a25e',
  compliance:  '0xb354Da530329251A21EcFF7876cA03eA34ff9d84',
  timelock:    '0x2E2c019750AD39f60e6F64DebD2E473C695CBa0e',
};

/** All known deployments indexed by chain ID. */
const DEPLOYMENTS: Record<number, DeploymentAddresses> = {
  84532: BASE_SEPOLIA_ADDRESSES,  // Base Sepolia
};

/**
 * Resolve deployment addresses for a given chain ID.
 *
 * @param chainId - The EVM chain ID
 * @returns The deployment addresses, or undefined if not deployed on that chain
 */
export function getAddresses(chainId: number): DeploymentAddresses | undefined {
  return DEPLOYMENTS[chainId];
}

/**
 * Resolve deployment addresses for a chain ID, throwing if not found.
 *
 * @param chainId - The EVM chain ID
 * @returns The deployment addresses
 * @throws Error if no deployment exists for the chain
 */
export function getAddressesOrThrow(chainId: number): DeploymentAddresses {
  const addrs = DEPLOYMENTS[chainId];
  if (!addrs) {
    throw new Error(
      `No Arena deployment found for chain ID ${chainId}. ` +
      `Supported chains: ${Object.keys(DEPLOYMENTS).join(', ')}`
    );
  }
  return addrs;
}
