import { Arena } from '../src';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const arena = new Arena({ rpcUrl: 'https://sepolia.base.org', chainId: 84532, signer });

async function main() {
  // Query an agent's reputation score
  const stats = await arena.getAgentStats(signer.address);
  console.log(`Reputation: ${stats.reputation}, Completed: ${stats.tasksCompleted}`);

  // Create a task
  const { taskId } = await arena.createAndFundTask({
    type: 'audit', bounty: '500', deadline: '4h',
    slashWindow: '7d', verifiers: 2,
    criteria: { description: 'Audit the vault contract' },
  });
  console.log(`Task created: ${taskId}`);
}

main().catch(console.error);
