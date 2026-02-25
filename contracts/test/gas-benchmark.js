/**
 * Gas Benchmark — Split Architecture (Main + Auction + VRF)
 * Measures gas for every major user-facing function across the split contracts.
 * Run: npx hardhat test test/gas-benchmark.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gas Benchmark (AFTER optimization)", function () {
  let main, auction, vrf, usdc, owner, poster, agent1, agent2, agent3, verifier1, verifier2, verifier3;
  const USDC_DECIMALS = 6;
  const toUSDC = (n) => ethers.parseUnits(String(n), USDC_DECIMALS);
  const results = [];

  function record(name, receipt) {
    const gas = Number(receipt.gasUsed);
    results.push({ name, gas });
  }

  async function advanceTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  }

  function makeCommitHash(addr, stake, price, eta, salt) {
    return ethers.keccak256(
      ethers.solidityPacked(
        ["address", "uint256", "uint256", "uint256", "bytes32"],
        [addr, stake, price, eta, salt]
      )
    );
  }

  before(async function () {
    [owner, poster, agent1, agent2, agent3, verifier1, verifier2, verifier3] = await ethers.getSigners();

    // Deploy USDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy ArenaCoreMain
    const ArenaCoreMain = await ethers.getContractFactory("ArenaCoreMain");
    const deployTx1 = await ArenaCoreMain.getDeployTransaction(await usdc.getAddress());
    deployTx1.gasLimit = 500_000_000n;
    const tx1 = await owner.sendTransaction(deployTx1);
    const receipt1 = await tx1.wait();
    main = ArenaCoreMain.attach(receipt1.contractAddress);
    record("ArenaCoreMain deployment", receipt1);

    // Deploy ArenaCoreAuction
    const ArenaCoreAuction = await ethers.getContractFactory("ArenaCoreAuction");
    const deployTx2 = await ArenaCoreAuction.getDeployTransaction(await main.getAddress());
    deployTx2.gasLimit = 500_000_000n;
    const tx2 = await owner.sendTransaction(deployTx2);
    const receipt2 = await tx2.wait();
    auction = ArenaCoreAuction.attach(receipt2.contractAddress);
    record("ArenaCoreAuction deployment", receipt2);

    // Deploy ArenaCoreVRF
    const ArenaCoreVRF = await ethers.getContractFactory("ArenaCoreVRF");
    const deployTx3 = await ArenaCoreVRF.getDeployTransaction(await main.getAddress(), await auction.getAddress());
    deployTx3.gasLimit = 500_000_000n;
    const tx3 = await owner.sendTransaction(deployTx3);
    const receipt3 = await tx3.wait();
    vrf = ArenaCoreVRF.attach(receipt3.contractAddress);
    record("ArenaCoreVRF deployment", receipt3);

    // Link contracts
    await main.setArenaCoreAuction(await auction.getAddress());
    await main.setArenaCoreVRF(await vrf.getAddress());
    await auction.setArenaCoreVRF(await vrf.getAddress());

    const mainAddr = await main.getAddress();
    const auctionAddr = await auction.getAddress();
    const vrfAddr = await vrf.getAddress();

    // Mint & approve USDC for all (approve both Main and Auction)
    for (const s of [poster, agent1, agent2, agent3, verifier1, verifier2, verifier3]) {
      await usdc.mint(s.address, toUSDC(100000));
      await usdc.connect(s).approve(mainAddr, ethers.MaxUint256);
      await usdc.connect(s).approve(auctionAddr, ethers.MaxUint256);
      await usdc.connect(s).approve(vrfAddr, ethers.MaxUint256);
    }

    // Register verifiers in VRF pool
    await vrf.connect(verifier1).joinVerifierPool(toUSDC(500));
    await vrf.connect(verifier2).joinVerifierPool(toUSDC(500));
    await vrf.connect(verifier3).joinVerifierPool(toUSDC(500));
  });

  it("benchmark all major functions", async function () {
    const usdcAddr = await usdc.getAddress();

    // ── createTask (on Main) ──
    let tx, r;
    const block0 = await ethers.provider.getBlock("latest");
    tx = await main.connect(poster).createTask(
      toUSDC(1000),                           // bounty
      block0.timestamp + 86400,               // deadline (future timestamp)
      86400,                                   // slashWindow
      3600,                                    // bidDuration
      3600,                                    // revealDuration
      3,                                       // requiredVerifiers
      ethers.id("criteria"),                   // criteriaHash
      "benchmark",                             // taskType
      usdcAddr                                 // token
    );
    r = await tx.wait();
    record("createTask", r);

    // ── commitBid (on Auction) ──
    const salt1 = ethers.id("salt1");
    const hash1 = makeCommitHash(agent1.address, toUSDC(200), toUSDC(800), 3600, salt1);
    tx = await auction.connect(agent1).commitBid(0, hash1, ethers.id("criteria"));
    r = await tx.wait();
    record("commitBid", r);

    const salt2 = ethers.id("salt2");
    const hash2 = makeCommitHash(agent2.address, toUSDC(300), toUSDC(900), 3600, salt2);
    await auction.connect(agent2).commitBid(0, hash2, ethers.id("criteria"));

    // ── revealBid (on Auction) ──
    await advanceTime(3601);
    tx = await auction.connect(agent1).revealBid(0, toUSDC(200), toUSDC(800), 3600, salt1);
    r = await tx.wait();
    record("revealBid", r);

    await auction.connect(agent2).revealBid(0, toUSDC(300), toUSDC(900), 3600, salt2);

    // ── resolveAuction (on Auction) ──
    await advanceTime(3601);
    tx = await auction.connect(poster).resolveAuction(0);
    r = await tx.wait();
    record("resolveAuction (2 bids)", r);

    // ── deliverTask (agent2 won — higher score from higher stake) ──
    tx = await auction.connect(agent2).deliverTask(0, ethers.id("delivery1"));
    r = await tx.wait();
    record("deliverOutput", r);

    // ── registerVerifier (on Auction) ──
    tx = await auction.connect(verifier1).registerVerifier(0, toUSDC(100));
    r = await tx.wait();
    record("registerVerifier", r);

    await auction.connect(verifier2).registerVerifier(0, toUSDC(100));
    await auction.connect(verifier3).registerVerifier(0, toUSDC(100));

    // ── submitVerification (on Auction) ──
    tx = await auction.connect(verifier1).submitVerification(0, 1, ethers.id("report1"));
    r = await tx.wait();
    record("submitVerification", r);

    await auction.connect(verifier2).submitVerification(0, 1, ethers.id("report2"));
    tx = await auction.connect(verifier3).submitVerification(0, 1, ethers.id("report3"));
    r = await tx.wait();
    record("submitVerification (triggers settle)", r);

    // ── createTask #2 for failure path ──
    const block1 = await ethers.provider.getBlock("latest");
    await main.connect(poster).createTask(
      toUSDC(500), block1.timestamp + 86400, 86400, 3600, 3600, 3,
      ethers.id("criteria2"), "benchmark", usdcAddr
    );
    const salt3 = ethers.id("salt3");
    const hash3 = makeCommitHash(agent2.address, toUSDC(100), toUSDC(400), 3600, salt3);
    await auction.connect(agent2).commitBid(1, hash3, ethers.id("criteria2"));
    await advanceTime(3601);
    await auction.connect(agent2).revealBid(1, toUSDC(100), toUSDC(400), 3600, salt3);
    await advanceTime(3601);
    await auction.connect(poster).resolveAuction(1);

    // ── enforceDeadline (failure/slash) ──
    await advanceTime(86401);
    tx = await auction.connect(poster).enforceDeadline(1);
    r = await tx.wait();
    record("enforceDeadline (slash)", r);

    // ── Get contract sizes ──
    const mainArtifact = require("../artifacts/src/ArenaCoreMain.sol/ArenaCoreMain.json");
    const auctionArtifact = require("../artifacts/src/ArenaCoreAuction.sol/ArenaCoreAuction.json");
    const vrfArtifact = require("../artifacts/src/ArenaCoreVRF.sol/ArenaCoreVRF.json");
    const mainSize = (mainArtifact.deployedBytecode.length - 2) / 2;
    const auctionSize = (auctionArtifact.deployedBytecode.length - 2) / 2;
    const vrfSize = (vrfArtifact.deployedBytecode.length - 2) / 2;
    const totalCoreSize = mainSize + auctionSize + vrfSize;

    // ── Print results ──
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║         GAS BENCHMARK — SPLIT ARCHITECTURE                 ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");

    for (const { name, gas } of results) {
      const padded = name.padEnd(42);
      const gasStr = gas.toLocaleString().padStart(12);
      console.log(`║  ${padded} ${gasStr}  ║`);
    }
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║                   CONTRACT SIZE COMPARISON                  ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  ArenaCoreMain:    ${String(mainSize).padEnd(6)} bytes (${(mainSize/1024).toFixed(1)} KB) — ${ mainSize <= 24576 ? 'UNDER ✅' : 'OVER ❌'}${"".padEnd(8)}║`);
    console.log(`║  ArenaCoreAuction: ${String(auctionSize).padEnd(6)} bytes (${(auctionSize/1024).toFixed(1)} KB) — ${ auctionSize <= 24576 ? 'UNDER ✅' : 'OVER ❌'}${"".padEnd(8)}║`);
    console.log(`║  ArenaCoreVRF:     ${String(vrfSize).padEnd(6)} bytes (${(vrfSize/1024).toFixed(1)} KB) — ${ vrfSize <= 24576 ? 'UNDER ✅' : 'OVER ❌'}${"".padEnd(8)}║`);
    console.log(`║  Total core:       ${String(totalCoreSize).padEnd(6)} bytes (${(totalCoreSize/1024).toFixed(1)} KB)${"".padEnd(15)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  BEFORE (monolithic): 95,983 bytes (93.7 KB) — 3.9x over   ║`);
    console.log(`║  All core contracts under 24KB: ${[mainSize, auctionSize, vrfSize].every(s => s <= 24576) ? "YES ✅" : "NO ❌"}${"".padEnd(21)}║`);
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Also print satellite sizes
    const satellites = [
      "ArenaContinuous", "ArenaArbitration", "ArenaInsurance",
      "ArenaSyndicates", "ArenaDelegation", "ArenaReputation", "ArenaCompliance"
    ];
    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║              SATELLITE CONTRACT SIZES                       ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    for (const sat of satellites) {
      try {
        const satArtifact = require(`../artifacts/src/${sat}.sol/${sat}.json`);
        const satSize = (satArtifact.deployedBytecode.length - 2) / 2;
        const status = satSize <= 24576 ? "✅" : "❌";
        console.log(`║  ${sat.padEnd(22)} ${String(satSize).padStart(6)} bytes (${(satSize/1024).toFixed(1)} KB) ${status}${"".padEnd(8)}║`);
      } catch(e) {
        console.log(`║  ${sat.padEnd(22)} NOT FOUND${"".padEnd(24)}║`);
      }
    }
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
  });
});
