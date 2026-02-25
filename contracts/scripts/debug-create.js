const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base-sepolia.json"), "utf8"));
  const mainContract = await hre.ethers.getContractAt("ArenaCoreMain", addresses.ArenaCoreMain);
  const usdc = await hre.ethers.getContractAt("MockUSDC", addresses.MockUSDC);
  const [deployer] = await hre.ethers.getSigners();

  const USDC = 10n ** 6n;

  // Check deployer USDC balance
  const bal = await usdc.balanceOf(deployer.address);
  console.log("Deployer USDC balance:", hre.ethers.formatUnits(bal, 6));

  // Check allowance
  const allow = await usdc.allowance(deployer.address, addresses.ArenaCoreMain);
  console.log("Allowance to Main:", hre.ethers.formatUnits(allow, 6));

  // Check posterActiveTasks
  const active = await mainContract.posterActiveTasks(deployer.address);
  const maxActive = await mainContract.maxPosterActiveTasks();
  console.log("Active poster tasks:", active.toString(), "Max:", maxActive.toString());

  // Check whitelist
  const wl = await mainContract.tokenWhitelist(addresses.MockUSDC);
  console.log("MockUSDC whitelisted:", wl);

  // Check paused
  try {
    const paused = await mainContract.paused();
    console.log("Paused:", paused);
  } catch {
    console.log("No paused() function or error");
  }

  // Try with explicit approval first
  console.log("\nApproving 500 USDC...");
  let tx = await usdc.approve(addresses.ArenaCoreMain, 500n * USDC);
  await tx.wait();
  console.log("Approved!");

  // Try createTask with staticCall first to get error
  console.log("\nTrying staticCall to get error...");
  try {
    await mainContract.createTask.staticCall(
      500n * USDC,
      24n * 3600n,
      48n * 3600n,
      60n,
      60n,
      1,
      hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test")),
      "audit",
      addresses.MockUSDC
    );
    console.log("staticCall succeeded!");
  } catch (err) {
    console.log("staticCall error:", err.message?.slice(0, 300));
    // Check for custom error
    if (err.data) {
      console.log("Error data:", err.data);
      try {
        const iface = mainContract.interface;
        const decoded = iface.parseError(err.data);
        console.log("Decoded error:", decoded);
      } catch (e2) {
        console.log("Could not decode error");
      }
    }
  }

  // Try actual transaction
  console.log("\nTrying actual createTask...");
  try {
    tx = await mainContract.createTask(
      500n * USDC,
      24n * 3600n,
      48n * 3600n,
      60n,
      60n,
      1,
      hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test")),
      "audit",
      addresses.MockUSDC
    );
    const receipt = await tx.wait();
    console.log("SUCCESS! TX:", receipt.hash);
  } catch (err) {
    console.log("TX error:", err.message?.slice(0, 300));
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
