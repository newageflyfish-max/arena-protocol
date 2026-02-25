/**
 * Deploy to local Hardhat node and write frontend .env file.
 *
 * Usage:
 *   npx hardhat node                                          # Terminal 1
 *   npx hardhat run scripts/deploy-local.js --network localhost  # Terminal 2
 */

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying to local node with:", deployer.address);

  // Deploy MockUSDC
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();

  // Deploy ArenaCoreMain
  const ArenaCoreMain = await ethers.getContractFactory("ArenaCoreMain");
  const main = await ArenaCoreMain.deploy(usdcAddr);
  await main.waitForDeployment();
  const mainAddr = await main.getAddress();

  // Deploy ArenaCoreAuction
  const ArenaCoreAuction = await ethers.getContractFactory("ArenaCoreAuction");
  const auction = await ArenaCoreAuction.deploy(mainAddr);
  await auction.waitForDeployment();
  const auctionAddr = await auction.getAddress();

  // Deploy ArenaCoreVRF
  const ArenaCoreVRF = await ethers.getContractFactory("ArenaCoreVRF");
  const vrf = await ArenaCoreVRF.deploy(mainAddr, auctionAddr);
  await vrf.waitForDeployment();
  const vrfAddr = await vrf.getAddress();

  // Link core contracts
  await main.setArenaCoreAuction(auctionAddr);
  await main.setArenaCoreVRF(vrfAddr);
  await auction.setArenaCoreVRF(vrfAddr);

  console.log(`MockUSDC:         ${usdcAddr}`);
  console.log(`ArenaCoreMain:    ${mainAddr}`);
  console.log(`ArenaCoreAuction: ${auctionAddr}`);
  console.log(`ArenaCoreVRF:     ${vrfAddr}`);

  // Write .env for frontend
  const envPath = path.join(__dirname, "../../frontend/.env");
  const envContent = `VITE_ARENA_MAIN_ADDRESS=${mainAddr}\nVITE_ARENA_AUCTION_ADDRESS=${auctionAddr}\nVITE_ARENA_VRF_ADDRESS=${vrfAddr}\nVITE_USDC_ADDRESS=${usdcAddr}\n`;
  fs.writeFileSync(envPath, envContent);
  console.log(`Wrote frontend/.env`);

  // Mint USDC to first 10 Hardhat accounts for testing
  const signers = await ethers.getSigners();
  const mintAmount = ethers.parseUnits("100000", 6);
  for (let i = 0; i < Math.min(10, signers.length); i++) {
    await usdc.mint(signers[i].address, mintAmount);
  }
  console.log("Minted 100,000 USDC to first 10 accounts");

  console.log("\n✓ Ready. Frontend will auto-connect to localhost:8545.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
