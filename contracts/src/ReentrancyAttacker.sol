// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ReentrancyAttacker
 * @notice Malicious ERC20 that attempts reentrancy attacks on ArenaCore.
 * @dev On every `transfer()` call from ArenaCore, this contract calls back
 *      into a configurable ArenaCore function to test reentrancy protection.
 *
 *      Attack modes:
 *        0 = no attack (passive)
 *        1 = reenter createTask
 *        2 = reenter revealBid
 *        3 = reenter resolveAuction
 *        4 = reenter cancelTask
 *        5 = reenter withdrawProtocolFees
 *        6 = reenter registerVerifier
 *        7 = reenter submitVerification (triggers _settleSuccess / _settleFailure internally)
 *        8 = reenter enforceDeadline
 *        9 = reenter postCompletionSlash
 *       10 = reenter claimSlashBond
 *       11 = reenter enforceVerifierTimeout
 *       12 = reenter joinVerifierPool
 *       13 = reenter leaveVerifierPool
 */
contract ReentrancyAttacker is ERC20 {
    address public target;       // ArenaCore address
    uint8 public attackMode;     // Which function to reenter
    uint256 public attackTaskId; // Task ID to use in reentrancy call
    bool public attacking;       // Prevent infinite recursion

    // Reentrancy call data (set before the attack)
    bytes public attackCalldata;

    constructor() ERC20("Malicious Token", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Configure the attack parameters
    function setAttack(address _target, uint8 _mode, bytes calldata _calldata) external {
        target = _target;
        attackMode = _mode;
        attackCalldata = _calldata;
        attacking = false;
    }

    /// @notice Disable the attack (passive mode)
    function disarm() external {
        attackMode = 0;
        attacking = false;
    }

    /**
     * @dev Override transfer to attempt reentrancy when ArenaCore sends tokens out.
     *      This is triggered during safeTransfer calls (refunds, payouts, withdrawals).
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackMode != 0 && !attacking && msg.sender == target) {
            attacking = true;
            // Attempt reentrancy — this should revert with ReentrancyGuardReentrantCall
            (bool success, bytes memory returnData) = target.call(attackCalldata);
            if (!success) {
                // Store the revert reason for test assertions
                lastRevertData = returnData;
                lastAttackReverted = true;
            } else {
                lastAttackReverted = false;
            }
            attacking = false;
        }
        return super.transfer(to, amount);
    }

    /**
     * @dev Override transferFrom to attempt reentrancy when ArenaCore pulls tokens in.
     *      This is triggered during safeTransferFrom calls (bounty escrow, staking).
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attackMode != 0 && !attacking && to == target) {
            attacking = true;
            (bool success, bytes memory returnData) = target.call(attackCalldata);
            if (!success) {
                lastRevertData = returnData;
                lastAttackReverted = true;
            } else {
                lastAttackReverted = false;
            }
            attacking = false;
        }
        return super.transferFrom(from, to, amount);
    }

    // Track results for test assertions
    bool public lastAttackReverted;
    bytes public lastRevertData;
}

/**
 * @title MaliciousSatellite
 * @notice Impersonates a satellite contract to test ArenaCore callback access control.
 *         Attempts to call setTaskStatusFromArbitration and adjustReputationFromSatellite.
 */
contract MaliciousSatellite {
    address public coreTarget;

    constructor(address _core) {
        coreTarget = _core;
    }

    function attackSetTaskStatus(uint256 _taskId, uint8 _status) external returns (bool success) {
        (success, ) = coreTarget.call(
            abi.encodeWithSignature("setTaskStatusFromArbitration(uint256,uint8)", _taskId, _status)
        );
    }

    function attackAdjustReputation(address _agent, int256 _delta) external returns (bool success) {
        (success, ) = coreTarget.call(
            abi.encodeWithSignature("adjustReputationFromSatellite(address,int256)", _agent, _delta)
        );
    }

    function attackWithdrawFees(address _token, address _to) external returns (bool success) {
        (success, ) = coreTarget.call(
            abi.encodeWithSignature("withdrawProtocolFees(address,address)", _token, _to)
        );
    }

    function attackEmergencyWithdrawBounty(uint256 _taskId) external returns (bool success) {
        (success, ) = coreTarget.call(
            abi.encodeWithSignature("emergencyWithdrawBounty(uint256)", _taskId)
        );
    }
}
