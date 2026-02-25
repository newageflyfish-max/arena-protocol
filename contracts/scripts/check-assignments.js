const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const addrs = JSON.parse(fs.readFileSync("deployments/base-sepolia.json", "utf8"));
  const mainC = await hre.ethers.getContractAt("ArenaCoreMain", addrs.ArenaCoreMain);

  // Check tasks 36 and 38 (previous run - success)
  for (const id of [36, 38, 44, 45, 46]) {
    const a = await mainC.getAssignment(id);
    const t = await mainC.getTask(id);
    console.log(`Task #${id}: status=${t.status} agent=${a.agent} stake=${a.stake.toString()}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
