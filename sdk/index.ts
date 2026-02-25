/**
 * The Arena SDK
 *
 * Root entry point — re-exports everything from src/.
 *
 * Usage:
 *   import { Arena } from '@arena-protocol/sdk';
 *
 *   const arena = new Arena({
 *     rpcUrl: 'https://sepolia.base.org',
 *     chainId: 84532,
 *     signer: wallet,
 *   });
 */

export * from './src/index';
export { default } from './src/index';
