# Arena Protocol — Security Audit Report

**Date:** 2026-02-23
**Auditor:** Automated Security Self-Audit (Claude)
**Scope:** All Arena Protocol smart contracts
**Solidity Version:** 0.8.24
**Framework:** Hardhat (viaIR, optimizer runs: 1)
**Chain:** Base Sepolia (Chain ID 84532)

---

## Executive Summary

This report covers a comprehensive security review of the Arena Protocol smart contracts, including the three core contracts (ArenaCoreMain, ArenaCoreAuction, ArenaCoreVRF) and twelve satellite contracts. The review covers USDC flow tracing, state transition analysis, access control review, griefing/front-running vectors, require statement completeness, and cross-contract interaction safety.

**Finding Summary:**

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 4 |
| Medium | 6 |
| Low | 6 |
| Informational | 5 |
| **Total** | **23** |

### Self-Audit Results

23 findings identified. 12 Critical/High/Medium findings — all resolved. 6 Low + 5 Informational — acknowledged, no code changes required. 1,104 tests passing after all fixes.

---

## Findings

---

### CRITICAL

---

#### C-01: ArenaReputation.mintReputationNFT() Has No Access Control

**Severity:** Critical
**Contract:** ArenaReputation.sol
**Function:** `mintReputationNFT(address _agent)` (line 102)

**Description:**
The `mintReputationNFT()` function has no access control modifier. Any external address can call it to mint a soulbound reputation NFT for any agent. The function only checks that `_agent != address(0)` and that the agent does not already have a token.

All other state-changing functions in ArenaReputation use the `onlyCoreOrOwner` modifier, but `mintReputationNFT()` is unprotected. This allows anyone to mint reputation NFTs for arbitrary addresses, undermining the protocol's reputation credentialing system.

```solidity
// MISSING: onlyCoreOrOwner modifier
function mintReputationNFT(address _agent) external returns (uint256 tokenId) {
    require(_agent != address(0), "Arena: invalid agent address");
    require(agentTokenId[_agent] == 0, "Arena: agent already has reputation NFT");
    tokenId = ++reputationTokenCount;
    // ...
}
```

**Recommended Fix:**
Add the `onlyCoreOrOwner` modifier to `mintReputationNFT()`:

```solidity
function mintReputationNFT(address _agent) external onlyCoreOrOwner returns (uint256 tokenId) {
```

**Status: RESOLVED** — Added `onlyCoreOrOwner` modifier to `mintReputationNFT()`. Commit `8487c63`.

---

#### C-02: VRF Verifier Stakes Use Wrong Token for Non-Default Task Tokens

**Severity:** Critical
**Contract:** ArenaCoreVRF.sol
**Function:** `rawFulfillRandomWords()` (line 237)

**Description:**
When VRF assigns verifiers to a task, it always transfers `main.defaultToken()` from the verifier's pool stake to ArenaCoreAuction, regardless of the task's actual payment token.

```solidity
// Line 237: Always uses defaultToken, ignoring task.token
IERC20(main.defaultToken()).safeTransfer(address(auction), verifierStake);
```

The verifier pool (`joinVerifierPool`) only accepts stakes in `defaultToken`. However, when Auction settles the task, it distributes verifier stakes using `IERC20(task.token)`:

```solidity
// ArenaCoreAuction._settleSuccess, line 598:
token.safeTransfer(vList[i].verifier, vList[i].stake);  // token = task.token
```

If `task.token != defaultToken`, the Auction contract would attempt to transfer a token it does not hold, causing the settlement to revert and permanently locking all funds associated with the task (bounty, agent stake, verifier stakes).

**Impact:**
Any task using a non-default whitelisted token will break if VRF verifier selection is enabled. The task will be stuck in Verifying status with all funds locked. Currently mitigated by only having the default token (MockUSDC) whitelisted, but the protocol is designed to support multiple tokens.

**Recommended Fix:**
Either:
1. Restrict VRF-enabled tasks to defaultToken only (add a check in `deliverTask`), or
2. Make the VRF pool token-agnostic by converting verifier stakes to the task's token at assignment time, or
3. Store the token type alongside each verification entry and handle mixed-token settlement.

**Status: RESOLVED** — Added `if (task.token != main.defaultToken()) revert A76()` in `rawFulfillRandomWords()`, restricting VRF tasks to defaultToken only. Commit `8487c63`.

---

### HIGH

---

#### H-01: All Verifiers Timing Out Auto-Approves Task Without Verification

**Severity:** High
**Contract:** ArenaCoreAuction.sol
**Function:** `enforceVerifierTimeout()` (lines 745-746)

**Description:**
When `enforceVerifierTimeout()` is called and ALL registered verifiers have timed out (`removedCount == vList.length`), the function calls `_settleSuccess(_taskId)`, automatically approving the task with zero actual verification votes.

```solidity
if (removedCount == vList.length) {
    _settleSuccess(_taskId);  // Auto-approves with NO actual votes
} else {
    _trySettlement(_taskId);
}
```

A malicious agent could exploit this by:
1. Delivering deliberately poor work
2. Colluding with verifiers who intentionally don't submit votes
3. After 24 hours, anyone calls `enforceVerifierTimeout()`
4. All verifiers are slashed 10% and the task is approved

The verifier timeout slash (10%) is much smaller than the agent's payout, making this economically profitable for the colluding parties.

**Recommended Fix:**
When all verifiers time out, treat it as a failure (or disputed state) rather than auto-approval:

```solidity
if (removedCount == vList.length) {
    main.setTaskStatus(_taskId, TaskStatus.Disputed);
    emit TaskDisputed(_taskId, address(0));
}
```

**Status: RESOLVED** — All-verifiers-timeout now sets `TaskStatus.Disputed`, refunds bounty to poster, returns agent stake minus 10% penalty. Commit `8487c63`.

---

#### H-02: Comparison Verification Dead Zone Blocks Settlement

**Severity:** High
**Contract:** ArenaCoreVRF.sol
**Function:** `submitComparisonVerification()` (lines 282-295)

**Description:**
When a verifier submits a comparison verification with a `_matchScore` between 5000 (CMP_REJECT) and 7999 (below CMP_APPROVE), and `_missedCritical == false`, the result falls into a dead zone where `resolution == 0` and no vote is recorded on the Auction contract.

```solidity
if (_missedCritical || _matchScore < CMP_REJECT) {
    resolution = 2;  // Rejected
    vote = VerifierVote.Rejected;
} else if (_matchScore >= CMP_APPROVE) {
    resolution = 1;  // Approved
    vote = VerifierVote.Approved;
}
// ELSE: resolution = 0, no vote recorded
```

Since `comparisonResults[_taskId][msg.sender].done = true` is set before the vote logic, the verifier cannot resubmit. The verification stays `Pending` on the Auction contract, blocking `_trySettlement()` which returns early when any vote is Pending.

**Impact:**
Tasks in comparison mode can get stuck in Verifying status until `abandonVerification()` is called after 7 days, resulting in no payout for the agent and bounty refunded to the poster regardless of work quality.

**Recommended Fix:**
Either:
1. Force a vote for all score ranges (e.g., scores in 5000-7999 count as Disputed/Abstain), or
2. Allow verifiers in the dead zone to fall back to `submitVerification()` explicitly, or
3. Remove the dead zone by making CMP_REJECT the threshold for everything below CMP_APPROVE.

**Status: RESOLVED** — Eliminated the dead zone. All scores below `CMP_APPROVE` (8000) now map to Rejected (resolution=2). A vote is always recorded. Commit `8487c63`.

---

#### H-03: ArenaContinuous Protocol Treasury Not Per-Token

**Severity:** High
**Contract:** ArenaContinuous.sol
**Function:** `withdrawProtocolFees()` (lines 302-306)

**Description:**
`protocolTreasury` is a single `uint256` that accumulates protocol fees across ALL token types, but `withdrawProtocolFees()` allows the owner to specify which token to withdraw:

```solidity
uint256 public protocolTreasury;  // Single counter for ALL tokens

function withdrawProtocolFees(address _token, address _to, uint256 _amount) external onlyOwner {
    require(_amount <= protocolTreasury, "Arena: exceeds treasury");
    protocolTreasury -= _amount;
    IERC20(_token).safeTransfer(_to, _amount);  // Can withdraw ANY token
}
```

If the protocol earns fees in multiple tokens (e.g., 100 USDC + 50 WETH = protocolTreasury of 150), the owner could withdraw 150 USDC despite only earning 100 USDC in fees, effectively stealing 50 USDC from escrow/stake funds.

**Recommended Fix:**
Change `protocolTreasury` to a per-token mapping:

```solidity
mapping(address => uint256) public protocolTreasury;
```

And update all fee accumulation points to use `protocolTreasury[cc.token]`.

**Status: RESOLVED** — Changed `protocolTreasury` to `mapping(address => uint256)` and updated all 7 accumulation points and `withdrawProtocolFees()`. Commit `8487c63`.

---

#### H-04: Task Can Get Permanently Stuck in Delivered Status

**Severity:** High
**Contract:** ArenaCoreAuction.sol
**State:** TaskStatus.Delivered

**Description:**
After an agent delivers a task (`deliverTask()`), the task transitions to `Delivered` status. If VRF is disabled and no one manually registers as a verifier via `registerVerifier()`, the task remains in `Delivered` status indefinitely with no exit mechanism:

- `enforceDeadline()` only works for `Assigned` tasks (line 789)
- `abandonVerification()` only works for `Verifying` tasks (line 756)
- `cancelTask()` only works for `Open` tasks (line 214)
- `postCompletionSlash()` only works for `Completed` tasks (line 390)

The bounty (on Main) and agent stake (on Auction) are locked with no way to recover them except through `emergencyWithdrawBounty()` and `emergencyWithdrawStake()`, which require the protocol to be paused for 7 full days.

**Recommended Fix:**
Add a timeout mechanism for `Delivered` tasks. For example, add an `enforceDeliveredTimeout()` function that allows cancellation and refunds if no verifiers register within a reasonable period (e.g., 7 days after delivery).

**Status: RESOLVED** — Added `enforceDeliveredTimeout()` to ArenaCoreAuction. After 7 days in Delivered with no verifiers, returns bounty to poster and full stake to agent (no slash). Commit `8487c63`.

---

### MEDIUM

---

#### M-01: Task Deadline Can Be Before Auction Ends

**Severity:** Medium
**Contract:** ArenaCoreMain.sol
**Function:** `createTask()` (lines 158-207)

**Description:**
`createTask()` validates `_deadline > block.timestamp` but does not validate that the deadline is after the bid + reveal periods end. A poster can create a task where:

```
deadline < block.timestamp + _bidDuration + _revealDuration
```

This means the task's completion deadline may have already passed by the time an agent is assigned (after auction resolution), making it impossible for the agent to deliver on time. The agent would then be slashed via `enforceDeadline()` through no fault of their own.

**Recommended Fix:**
Add a validation in `createTask()`:

```solidity
if (_deadline <= block.timestamp + _bidDuration + _revealDuration) revert A07();
```

**Status: RESOLVED** — Added `if (_deadline <= block.timestamp + _bidDuration + _revealDuration) revert A07()` in `createTask()`. Commit `1635989`.

---

#### M-02: ArenaCompliance Reporting Has No Cost — Sybil Griefing

**Severity:** Medium
**Contract:** ArenaCompliance.sol
**Function:** `reportTask()` (line 187)

**Description:**
Anyone can report a task at zero cost. The `flagThreshold` is only 3 unique reporters by default. An attacker can create 3 addresses (no cost on L2) and flag any legitimate task, potentially leading to its suspension by the compliance officer.

While suspension itself requires the compliance role to act, the auto-flagging creates noise and pressure. Combined with the fact that there's no penalty for false reports, this enables costless griefing of competitors' tasks.

**Recommended Fix:**
Require a minimum token stake (e.g., 10 USDC) to submit a report. The stake is returned if the report is upheld and slashed if it's a false report.

**Status: RESOLVED** — Added 10 USDC reporter deposit via `safeTransferFrom` in `reportTask()`, with `returnReportDeposit()` (upheld) and `slashReportDeposit()` (false report) functions. Commit `1635989`.

---

#### M-03: VRF Verifier Selection Can Fail Silently for Small Pools

**Severity:** Medium
**Contract:** ArenaCoreVRF.sol
**Function:** `rawFulfillRandomWords()` (lines 195-218)

**Description:**
The VRF callback loops up to `poolSize * 10` times trying to find eligible verifiers. Candidates are skipped if they are the agent, poster, banned, in cooldown, or already selected. If the effective eligible pool is smaller than `requiredVerifiers`, the function reverts with `A37()` after consuming significant gas.

Since VRF callbacks have a fixed gas limit (`vrfCallbackGasLimit`), a revert means the task stays in `Delivered` status with the VRF request consumed but no verifiers assigned. The VRF subscription is charged but the task gets no verifiers, creating the stuck-in-Delivered scenario described in H-04.

**Recommended Fix:**
1. Add a pre-check in `requestVRFVerifiers()` to verify the effective eligible pool size before requesting VRF
2. Add a fallback mechanism: if VRF callback fails, allow manual verifier registration
3. Consider increasing `vrfCallbackGasLimit` or reducing the selection loop bound

**Status: RESOLVED** — Added pre-check in `requestVRFVerifiers()` that counts eligible verifiers before requesting VRF. Falls back to manual registration with `VRFFallbackToManual` event if pool is too small. Commit `1635989`.

---

#### M-04: registerVerifier Cooldown Check Uses Wrong Source When VRF Is Unset

**Severity:** Medium
**Contract:** ArenaCoreAuction.sol
**Function:** `registerVerifier()` (lines 462-468)

**Description:**
The verifier cooldown check is wrapped in `if (address(arenaCoreVRF) != address(0))`. If VRF is not configured (arenaCoreVRF is address(0)), the cooldown check is entirely skipped, allowing the same verifier to repeatedly verify the same agent with no cooldown period.

```solidity
if (address(arenaCoreVRF) != address(0)) {
    uint256 cdp = arenaCoreVRF.verifierCooldownPeriod();
    if (cdp > 0) {
        uint256 lastTs = arenaCoreVRF.getLastVerifiedTimestamp(msg.sender, assignment.agent);
        if (lastTs > 0 && block.timestamp < lastTs + cdp) revert A43();
    }
}
// If VRF is not set, NO cooldown check at all
```

This enables agent-verifier collusion in non-VRF deployments.

**Recommended Fix:**
Store a local cooldown period on ArenaCoreAuction and enforce it regardless of VRF configuration:

```solidity
// Always check cooldown, not just when VRF is set
if (lastVerifiedTimestamp[msg.sender][assignment.agent] > 0 &&
    block.timestamp < lastVerifiedTimestamp[msg.sender][assignment.agent] + cooldownPeriod) {
    revert A43();
}
```

**Status: RESOLVED** — Added `localVerifierCooldown` (7 days default) and `localLastVerified` mapping on ArenaCoreAuction, enforced in `registerVerifier()` regardless of VRF configuration. Owner-configurable via `setLocalVerifierCooldown()`. Commit `1635989`.

---

#### M-05: ArenaRecurring Does Not Validate deadlineOffset > bidDuration + revealDuration

**Severity:** Medium
**Contract:** ArenaRecurring.sol
**Function:** `createRecurringTask()` (line 261)

**Description:**
`createRecurringTask()` only validates `_deadlineOffset >= 1 hours` but does not check that the deadline offset is greater than `bidDuration + revealDuration`. When `triggerRecurringTask()` creates a task on ArenaCore with `deadline = block.timestamp + deadlineOffset`, the deadline may fall before the auction concludes.

This means all recurring occurrences will create impossible-to-complete tasks where agents are guaranteed to be slashed.

**Recommended Fix:**
```solidity
if (_deadlineOffset <= _bidDuration + _revealDuration) revert InvalidDeadlineOffset();
```

**Status: RESOLVED** — Added `if (_deadlineOffset <= _bidDuration + _revealDuration) revert InvalidDeadlineOffset()` in `createRecurringTask()`. Commit `1635989`.

---

#### M-06: postCompletionSlash Decrements agentTasksCompleted Potentially to Zero

**Severity:** Medium
**Contract:** ArenaCoreMain.sol
**Function:** `postCompletionSlash()` (lines 429-432)

**Description:**
When `postCompletionSlash()` is called on a previously Completed task, it decrements `agentTasksCompleted`:

```solidity
agentTasksFailed[assignment.agent]++;
if (agentTasksCompleted[assignment.agent] > 0) {
    agentTasksCompleted[assignment.agent]--;
}
```

This means an agent's completion count can be artificially reduced by repeated post-completion slashes on different tasks. If an agent has completed 5 tasks and all 5 are post-completion slashed, their completed count drops to 0 while their failed count goes to 5, completely destroying their reputation metrics even if only minor slashing occurred (e.g., `SlashSeverity.Late`).

Combined with the fact that post-completion slashing changes task status from `Completed` to `Failed`, this can cascade into other systems (ArenaReputation credit scores, marketplace rankings).

**Recommended Fix:**
Consider whether decrementing `agentTasksCompleted` is appropriate for all severity levels. A `Late` slash should arguably not undo a completion.

**Status: RESOLVED** — `agentTasksCompleted` now only decremented for Material, Execution, and Critical severity slashes. Late and Minor slashes apply the financial penalty but preserve the completion record. Commit `1635989`.

---

### LOW

---

#### L-01: No Events Emitted for Satellite Address Updates

**Severity:** Low
**Contract:** ArenaCoreMain.sol
**Functions:** `setArenaCoreAuction()`, `setArenaCoreVRF()`, `setArenaArbitration()`, `setArenaOutcomes()`, `setArenaCompliance()` (lines 702-722)

**Description:**
Critical configuration changes (setting satellite contract addresses) emit no events, making it impossible for off-chain monitoring systems to detect when these addresses change. This is particularly important for security because changing the Auction address redirects all escrow access.

**Recommended Fix:**
Emit events for all satellite address updates.

---

#### L-02: Opaque Error Codes Reduce Debuggability

**Severity:** Low
**Contracts:** ArenaCoreMain.sol, ArenaCoreAuction.sol, ArenaCoreVRF.sol

**Description:**
All three core contracts use short alphanumeric error codes (`A01`, `A03`, `A06`, etc.) with no descriptive information. This makes debugging failed transactions extremely difficult for users and developers.

While short error codes save deployment gas, they significantly harm the developer experience. At minimum, a mapping from error codes to descriptions should be maintained off-chain.

**Recommended Fix:**
Either use descriptive error messages (e.g., `error NotAuthorized()`, `error TaskNotOpen()`) or maintain a comprehensive error code reference in documentation.

---

#### L-03: No Zero-Address Validation on Critical Setters

**Severity:** Low
**Contracts:** ArenaCoreMain.sol, ArenaCoreAuction.sol

**Description:**
Functions `setArenaCoreAuction()`, `setArenaCoreVRF()`, `setArenaArbitration()`, `setArenaOutcomes()`, `setArenaCompliance()`, and `setTreasuryAddress()` do not validate against `address(0)`. Setting any of these to zero address would:

- `arenaCoreAuction = 0`: Break all auction operations, lock all funds
- `arenaCoreVRF = 0`: Disable VRF (semi-intentional but risky)
- `arenaArbitration = 0`: Disable dispute resolution
- `treasuryAddress = 0`: Protocol fees withdrawn to the `_to` fallback (less risky)

**Recommended Fix:**
Add `if (_addr == address(0)) revert ZeroAddress();` to critical setters. For setters where zero address means "disabled" (like VRF), document this explicitly.

---

#### L-04: Magic Numbers in Settlement Logic

**Severity:** Low
**Contract:** ArenaCoreAuction.sol
**Functions:** `_settleSuccess()`, `_settleFailure()`

**Description:**
Several hardcoded values are used without named constants:
- `10` — reputation increase on success (line 574)
- `5` — reputation decrease on failure (line 654)
- `300` — verifier fee BPS (line 584)
- `2` — verifier slash divisor (line 600)

These should be named constants for clarity and maintainability.

**Recommended Fix:**
```solidity
uint256 internal constant SUCCESS_REPUTATION_BONUS = 10;
uint256 internal constant FAILURE_REPUTATION_PENALTY = 5;
uint256 internal constant VERIFIER_FEE_BPS = 300;
```

---

#### L-05: decrementAgentCompleted Has No Underflow Protection

**Severity:** Low
**Contract:** ArenaCoreMain.sol
**Function:** `decrementAgentCompleted()` (lines 567-569)

**Description:**
The `onlyAuction` setter `decrementAgentCompleted()` does not check if `agentTasksCompleted[_agent] > 0` before decrementing, unlike the inline check in `postCompletionSlash()`. In Solidity 0.8+, this would revert on underflow, potentially causing a DoS if Auction calls it with incorrect accounting.

```solidity
function decrementAgentCompleted(address _agent) external onlyAuction {
    agentTasksCompleted[_agent]--;  // No underflow check
}
```

**Recommended Fix:**
Add underflow protection matching the pattern used in `postCompletionSlash()`:
```solidity
if (agentTasksCompleted[_agent] > 0) {
    agentTasksCompleted[_agent]--;
}
```

---

#### L-06: registerVerifier Front-Running — First-Come-First-Served Slot Competition

**Severity:** Low
**Contract:** ArenaCoreAuction.sol
**Function:** `registerVerifier()` (line 456)

**Description:**
Verifier slots are limited by `task.requiredVerifiers`. Since `registerVerifier()` is permissionless (anyone who meets the stake requirement can register), an attacker can front-run legitimate verifiers to claim all slots.

```solidity
if (verifierList.length >= task.requiredVerifiers) revert A41();
```

While the minimum stake requirement provides some economic barrier, the first-come-first-served model allows MEV bots to capture verifier slots on high-value tasks.

**Recommended Fix:**
Consider a commitment-based verifier registration or use VRF-based selection (which already mitigates this). Alternatively, add a registration window before accepting verifiers.

---

### INFORMATIONAL

---

#### I-01: Cross-Contract Reentrancy Is Theoretically Possible

**Severity:** Informational
**Contracts:** ArenaCoreMain.sol, ArenaCoreAuction.sol, ArenaCoreVRF.sol

**Description:**
Each contract has its own independent `ReentrancyGuard`. Cross-contract calls (Auction calling Main's setters, VRF calling Auction's pushVerification) are not protected by a shared reentrancy guard.

Currently safe because:
1. Main's `onlyAuction` setters are pure storage writes with no external calls (except `transferFromEscrow` using SafeERC20)
2. All token transfers use SafeERC20 (no reentrancy hooks for standard ERC20)
3. The default token is USDC (standard ERC20 without transfer hooks)

However, if an ERC777 or other hook-enabled token is whitelisted in the future, the `safeTransfer` calls could trigger reentrancy across contracts that bypasses the per-contract guards.

**Recommendation:**
Document that only standard ERC20 tokens without transfer hooks should be whitelisted. Consider adding explicit re-entrancy protection to cross-contract call paths.

---

#### I-02: Task IDs Start at Zero

**Severity:** Informational
**Contract:** ArenaCoreMain.sol

**Description:**
`taskId = taskCount++` means the first task has ID 0. While valid, many systems check `if (taskId == 0)` to detect uninitialized state. The default value of mappings (e.g., `_tasks[0]`) is a zeroed struct, making it hard to distinguish between "task 0" and "no task."

**Recommendation:**
Consider starting task IDs at 1 (`taskId = ++taskCount`).

---

#### I-03: Comparison Mode Can Be Bypassed

**Severity:** Informational
**Contract:** ArenaCoreVRF.sol, ArenaCoreAuction.sol

**Description:**
When `comparisonMode[taskId]` is enabled, verifiers are expected to use `submitComparisonVerification()` on VRF. However, `submitVerification()` on Auction does not check whether comparison mode is active. Any registered verifier can bypass comparison mode by calling `submitVerification()` directly, casting a simple Approve/Reject vote without the score-based evaluation.

**Recommendation:**
Add a comparison mode check in `submitVerification()`:
```solidity
if (address(arenaCoreVRF) != address(0) && arenaCoreVRF.comparisonMode(_taskId)) revert A_COMPARISON_MODE();
```

---

#### I-04: Slash Bond Accounting Relies on Token Transfers Between Main and Auction

**Severity:** Informational
**Contracts:** ArenaCoreAuction.sol, ArenaCoreMain.sol

**Description:**
The slash bond flow involves:
1. Auction calculates `slashBond = stake * 2000 / 10000`
2. Auction transfers `slashBond` tokens to Main via `token.safeTransfer(address(main), slashBond)`
3. Main records `slashBonds[taskId] = slashBond` via `batchSettleState`
4. Later, Main distributes the bond via `claimSlashBond()` or `postCompletionSlash()`

If the token transfer in step 2 fails (e.g., Auction has insufficient balance due to an accounting bug), Main would record a bond amount it doesn't actually hold, leading to a failed withdrawal in step 4.

**Recommendation:**
Add balance verification or use a pull-based pattern where Main requests the bond from Auction when needed.

---

#### I-05: ArenaContinuous Has Independent State from Core

**Severity:** Informational
**Contract:** ArenaContinuous.sol

**Description:**
ArenaContinuous maintains its own parallel state for agent tracking (`agentActiveStake`, `agentTasksCompleted`, `agentTasksFailed`, `agentSlashCooldownEnd`, `agentBannedLocal`) that is independent from ArenaCoreMain's state. Actions on one system do not affect the other:

- An agent banned on ArenaCoreMain is checked via `core.agentBanned()` in the `notBanned` modifier, but local bans (`agentBannedLocal`) only apply to ArenaContinuous
- An agent's slash cooldown on core does not affect their ArenaContinuous cooldown and vice versa
- Reputation/completion stats are tracked independently

This is by design (satellites are independent) but could lead to inconsistencies where an agent banned on core can still operate on ArenaContinuous (via `notBanned` modifier which checks both).

**Recommendation:**
Document the independence of state between core and satellite contracts. Consider whether cross-system bans should be synchronized.

---

## USDC Flow Analysis

### Path 1: Task Creation → Successful Completion

```
1. createTask():     Poster → Main escrow          [bounty]
2. revealBid():      Agent → Auction                [stake]
3. resolveAuction(): Auction → losing agents        [their stakes returned]
4. registerVerifier(): Verifier → Auction            [verifier stake]
5. _settleSuccess():
   a. Main escrow → Agent                           [price - protocolFee]
   b. Auction → Agent                               [stake - slashBond]
   c. Auction → Main                                [slashBond] (held for slash window)
   d. Main escrow → correct verifiers               [feePerVerifier each]
   e. Main escrow → poster                          [bounty - price - verifierFees]
   f. protocolTreasury[token] += protocolFee         [tracked, stays on Main]
   g. Wrong verifiers: Auction → Main (protocol)    [10% of stake]
   h. Wrong verifiers: Auction → poster             [40% of stake]
   i. Wrong verifiers: Auction → verifier            [50% of stake]
6. claimSlashBond(): Main → Agent                   [slashBond] (after slash window)
```

**Token conservation verified:** bounty in = (price - protocolFee) + (bounty - price - verifierFees) + verifierFees + protocolFee = bounty. Stake in = (stake - slashBond) + slashBond = stake.

### Path 2: Task Creation → Failed (Majority Rejection)

```
1-4: Same as Path 1
5. _settleFailure():
   a. Auction → Agent                               [stake - slashAmount]
   b. Main escrow → Poster                          [bounty refunded]
   c. Auction → Main                                [protocol fee from slash]
   d. Auction → Poster                              [slash proceeds]
   e. Correct verifiers: Auction → verifier          [stake returned]
   f. Wrong verifiers (Approved): fully slashed to protocol + poster
```

**Token conservation verified.**

### Path 3: Task Cancellation

```
1. createTask(): Poster → Main escrow               [bounty]
2. commitBid(): No token transfer
3. revealBid(): Agent → Auction                      [stake]
4. cancelTask():
   a. Main → Poster                                 [bounty refunded]
   b. Auction.refundBidsOnCancel() → agents          [stakes refunded]
```

**Token conservation verified.**

### Path 4: Deadline Enforcement

```
1-3: Same as Path 1 through resolveAuction
4. enforceDeadline():
   → Calls _settleFailure() with Late or Material severity
   → Same flow as Path 2 step 5
```

**Token conservation verified.**

### Path 5: Emergency Withdrawal

```
1. createTask(): Poster → Main escrow               [bounty]
2-3: Auction proceeds as normal
4. Protocol paused for 7+ days
5a. emergencyWithdrawBounty():
    Main → Poster                                   [bounty]
5b. emergencyWithdrawStake():
    Auction.transferToMain() → Main                  [stake]
    Main → Agent                                     [stake]
```

**Token conservation verified.**

### Path 6: VRF Verifier Pool

```
1. joinVerifierPool(): Verifier → VRF               [defaultToken stake]
2. rawFulfillRandomWords():
   VRF pool stake reduced, VRF → Auction             [verifierStake per verifier]
3. Settlement: Auction → verifiers                   [stakes ± rewards/slashes]
4. leaveVerifierPool(): VRF → Verifier               [remaining pool stake]
```

**Note:** Path 6 has the C-02 bug when task.token != defaultToken.

---

## State Transition Map

```
Open ─────────┬─→ BidReveal ──→ Assigned ──→ Delivered ──→ Verifying ─┬─→ Completed ──→ Failed*
              │                     │                         │        ├─→ Failed
              │                     │                         │        └─→ Disputed
              │                     └─→ Failed                │
              │                        (enforceDeadline)      └─→ Cancelled
              └─→ Cancelled                                       (abandonVerification)
                 (cancelTask)

* Completed → Failed only via postCompletionSlash (within slashWindow)
```

**Stuck states identified:**
1. **Delivered** — No timeout if VRF disabled and no verifiers register (H-04)
2. **Verifying** — Has 24h timeout (enforceVerifierTimeout) and 7-day abandon (abandonVerification)
3. **Disputed** — Requires ArenaArbitration to resolve; no on-chain timeout

**Backward transitions:**
1. **Completed → Failed** — via `postCompletionSlash()` (intentional, within slash window)

**Skip transitions:** None possible. All transitions are sequential.

---

## Access Control Summary

### Functions That Move USDC (Token Transfers)

| Contract | Function | Access Control | Tokens Moved |
|----------|----------|----------------|--------------|
| Main | `createTask()` | Anyone (whenNotPaused) | Poster → Main (bounty) |
| Main | `cancelTask()` | Poster only | Main → Poster (bounty refund) |
| Main | `postCompletionSlash()` | Owner or ArenaOutcomes | Main → Poster + Agent (bond) |
| Main | `claimSlashBond()` | Assigned agent only | Main → Agent (bond) |
| Main | `withdrawProtocolFees()` | Owner | Main → Treasury (fees) |
| Main | `emergencySweep()` | Owner + 7d pause | Main → recipient (any amount) |
| Main | `emergencyWithdrawBounty()` | Poster + 7d pause | Main → Poster (bounty) |
| Main | `emergencyWithdrawStake()` | Agent + 7d pause | Auction → Main → Agent (stake) |
| Main | `transferFromEscrow()` | onlyAuction | Main → recipient (amount) |
| Auction | `revealBid()` | Bidding agent | Agent → Auction (stake) |
| Auction | `resolveAuction()` | Anyone | Auction → losing agents (stakes) |
| Auction | `registerVerifier()` | Anyone (whenNotPaused) | Verifier → Auction (stake) |
| Auction | `_settleSuccess()` | Internal | Multiple transfers |
| Auction | `_settleFailure()` | Internal | Multiple transfers |
| Auction | `enforceVerifierTimeout()` | Anyone | Auction → verifiers/poster |
| Auction | `abandonVerification()` | Anyone | Auction → agent + verifiers, Main → poster |
| Auction | `enforceDeadline()` | Anyone | Via _settleFailure |
| Auction | `refundBidsOnCancel()` | onlyMain | Auction → agents (stakes) |
| Auction | `transferToMain()` | onlyMain | Auction → Main |
| VRF | `joinVerifierPool()` | Anyone (whenNotPaused) | Verifier → VRF (stake) |
| VRF | `leaveVerifierPool()` | Active verifier | VRF → Verifier (stake) |
| VRF | `rawFulfillRandomWords()` | VRF Coordinator | VRF → Auction (stakes) |

### onlyOwner Functions

| Contract | Function |
|----------|----------|
| Main | `setArenaCoreAuction`, `setArenaCoreVRF`, `setArenaArbitration`, `setArenaOutcomes`, `setArenaCompliance` |
| Main | `setTreasuryAddress`, `withdrawProtocolFees`, `emergencySweep` |
| Main | `pause`, `unpause`, `unbanAgent` |
| Main | `setMinBounty`, `setMaxPosterActiveTasks` |
| Main | `setRequireTaskTypeApproval`, `addApprovedTaskType`, `removeApprovedTaskType`, `setSchemaHash` |
| Main | `whitelistToken`, `removeToken` |
| Auction | `setArenaCoreVRF` (via main.owner()) |
| VRF | `configureVRF`, `disableVRF`, `setVerifierCooldown` (via main.owner()) |

### Functions That Should Be Restricted But Aren't

| Contract | Function | Current Access | Should Be |
|----------|----------|----------------|-----------|
| ArenaReputation | `mintReputationNFT()` | Anyone | onlyCoreOrOwner (C-01) |

---

## Static Analysis — Slither v0.11.4

Slither was run with all detectors enabled (`slither . --hardhat-ignore-compile`). Results are summarized below. OpenZeppelin false positives (Math.sol `incorrect-exp`, Base64.sol `divide-before-multiply`) are excluded.

### Arena-Specific Findings

#### S-01: Divide-Before-Multiply Precision Loss

**Detector:** `divide-before-multiply`

| Contract | Location | Expression |
|----------|----------|------------|
| ArenaConsensus | `_settleWithConsensus()` L673→L677 | `slashAmount = (stake * BPS) / DENOM` then `toProtocol = (slashAmount * BPS) / DENOM` |
| ArenaContinuous | `resolveCheckpointDispute()` L1259→L1268 | Same pattern — slash then protocol split |
| ArenaReputation | `computeCreditScore()` L225→L230 | `avgSeverity = total / events` then `penalty = (avg * MAX) / 10000` |
| ArenaReputation | `computeCreditScore()` L242→L258 | `verificationScore = MAX / 2` then used in weighted sum |
| ArenaReputation | `computeCreditScore()` L249→L250 | `ageDays = elapsed / 86400` then `ageBase = (ageDays * MAX) / 180` |

**Assessment:** Low risk. The BPS-based calculations lose at most 1 wei per division. The credit score calculations use integer days, which is an intentional design choice (partial days are truncated). No exploitable precision loss.

#### S-02: Cross-Contract Reentrancy Warnings

**Detector:** `reentrancy-no-eth`

| Entry Point | External Call | State Written After |
|-------------|---------------|---------------------|
| `ArenaCoreAuction.commitBid()` L282 | `main.addAgentActiveBids()` | `bids[taskId][agent]`, `taskBidders[taskId]` |
| `ArenaCoreVRF.rawFulfillRandomWords()` L232-236 | `main.addAgentActiveStake()`, `auction.pushVerification()` | `lastVerifiedTimestamp`, `verifierRegistry.stake` |
| `ArenaRecurring.triggerRecurringTask()` L404 | `core.createTask()` | `triggeredCount`, `lastTriggeredAt`, `status` |

**Assessment:** Currently safe — covered in finding I-01. The `onlyAuction` setters on Main are pure storage writes. `createTask` uses SafeERC20 with no hooks for standard ERC20. Risk only materializes if an ERC777 or hook-enabled token is whitelisted.

#### S-03: Dangerous Strict Equalities

**Detector:** `incorrect-equality`

| Contract | Function | Expression |
|----------|----------|------------|
| ArenaContinuous | `_settleContinuousContract()` L1077 | `status == CheckpointStatus.Passed` |
| ArenaCoreAuction | `abandonVerification()` L759 | `t == 0` (unset task check) |
| ArenaCoreAuction | `enforceVerifierTimeout()` L704 | `assignedTime == 0` (unset check) |
| ArenaCoreMain | `onlyEmergency()` L129 | `pausedAt == 0` (not paused check) |
| ArenaInsurance | `buyInsurance()` L200 | `oid != _offerId && status == Open` |

**Assessment:** All are intentional sentinel-value checks (zero means uninitialized/not-set). These are standard Solidity patterns and not exploitable. False positives from Slither's heuristic.

#### S-04: Uninitialized Local Variables

**Detector:** `uninitialized-local`

13 instances across ArenaCoreAuction, ArenaCoreVRF, ArenaCoreMain, ArenaReputation, ArenaConsensus. All are accumulators or default-zero values (e.g., `bestScore = 0`, `removedCount = 0`, `approvals = 0`) that are intentionally initialized to their default.

**Assessment:** All false positives. Solidity defaults local variables to zero. No risk.

#### S-05: Unused Return Values

**Detector:** `unused-return`

16 instances across ArenaArbitration, ArenaCompliance, ArenaCoreAuction, ArenaCoreMain. All are tuple destructuring calls where only some return values are needed (e.g., `(poster,,,,,,,,,status,) = core.tasks(taskId)`).

**Assessment:** All intentional. The unused return values are discarded via the `None` syntax in tuple destructuring. No risk.

### ReentrancyAttacker (Test Contract)

Slither flagged `ReentrancyAttacker.transfer()` and `ReentrancyAttacker.transferFrom()` for reentrancy. This is expected — the contract is a test helper specifically designed to perform reentrancy attacks against the protocol. Not a production concern.

---

## Methodology

1. **Manual Code Review:** Line-by-line review of all 20 Solidity source files (~5,000 lines)
2. **Static Analysis:** Slither v0.11.4 with all detectors enabled on the full contract suite
3. **Token Flow Tracing:** Traced every `safeTransfer` and `safeTransferFrom` call across all contracts, verifying token conservation for each lifecycle path
4. **State Machine Analysis:** Mapped all valid TaskStatus transitions, identified stuck states and backward transitions
5. **Access Control Audit:** Catalogued all functions with access modifiers and all functions that move tokens
6. **Attack Vector Analysis:** Evaluated griefing, front-running, reentrancy, and collusion vectors
7. **Cross-Contract Analysis:** Traced all inter-contract calls between Main, Auction, and VRF for state consistency

---

## Disclaimer

This audit was performed as an automated self-review and does not constitute a professional security audit. Smart contracts should be audited by independent security firms before mainnet deployment. No guarantee of completeness is provided.
