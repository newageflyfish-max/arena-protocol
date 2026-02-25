const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
async function main() {
  const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base-sepolia.json"), "utf8"));
  const mainC = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);
  const [deployer] = await hre.ethers.getSigners();
  const active = await mainC.posterActiveTasks(deployer.address);
  const max = await mainC.maxPosterActiveTasks();
  console.log("posterActiveTasks:", active.toString());
  console.log("maxPosterActiveTasks:", max.toString());
  console.log("Setting maxPosterActiveTasks to 50...");
  const tx = await mainC.setMaxPosterActiveTasks(50);
  await tx.wait();
  console.log("Done!");
}
main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
