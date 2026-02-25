// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ArenaTypes.sol";

/**
 * @title ArenaDelegation
 * @notice Delegated staking pools for The Arena protocol.
 *         Delegators deposit capital into agent pools. Agents use pooled capital in bids.
 *         Revenue is shared according to the agent's configured share rate.
 */
contract ArenaDelegation is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    IArenaCore public immutable core;
    address public arenaCore;

    uint256 public constant DELEGATION_MAX_DELEGATORS = 50;
    uint256 public constant DELEGATION_MIN_REVENUE_SHARE_BPS = 500;
    uint256 public constant DELEGATION_MAX_REVENUE_SHARE_BPS = 9000;
    uint256 public constant BPS_DENOMINATOR = 10000;

    mapping(address => DelegationPool) public delegationPools;
    mapping(address => mapping(address => uint256)) public delegatorContributions;
    mapping(address => address[]) public agentDelegatorList;
    mapping(uint256 => TaskDelegation) public taskDelegations;
    mapping(uint256 => mapping(address => bool)) public delegatorClaimed;

    event DelegationPoolOpened(address indexed agent, address indexed token, uint256 revenueShareBps);
    event DelegatorRevenueShareUpdated(address indexed agent, uint256 revenueShareBps);
    event StakeDelegated(address indexed agent, address indexed delegator, uint256 amount);
    event DelegationWithdrawn(address indexed agent, address indexed delegator, uint256 amount);
    event DelegatedBidRevealed(uint256 indexed taskId, address indexed agent, uint256 ownStake, uint256 delegatedStake);
    event DelegatorRewardsClaimed(uint256 indexed taskId, address indexed delegator, address indexed agent, uint256 payout, uint256 stakeReturn);
    event DelegatorLossesClaimed(uint256 indexed taskId, address indexed delegator, address indexed agent, uint256 returned, uint256 loss);
    event ArenaCoreUpdated(address indexed newCore);

    modifier notBanned() {
        require(!core.agentBanned(msg.sender), "Arena: agent is banned");
        _;
    }

    modifier onlyCoreOrOwner() {
        require(msg.sender == arenaCore || msg.sender == owner(), "Arena: not authorized");
        _;
    }

    constructor(address _core) Ownable(msg.sender) {
        core = IArenaCore(_core);
        arenaCore = _core;
    }

    /// @notice Updates the ArenaCore contract address.
    /// @param _core The new ArenaCore contract address.
    function setArenaCore(address _core) external onlyOwner {
        arenaCore = _core;
        emit ArenaCoreUpdated(_core);
    }

    /// @notice Sets or updates the revenue share for an agent's delegation pool, creating the pool if it does not exist.
    /// @param _revenueShareBps Revenue share offered to delegators, in basis points.
    /// @param _token ERC-20 token for the pool; uses the default token if address(0).
    function setDelegatorRevenueShare(uint256 _revenueShareBps, address _token)
        external whenNotPaused notBanned
    {
        require(
            _revenueShareBps >= DELEGATION_MIN_REVENUE_SHARE_BPS &&
            _revenueShareBps <= DELEGATION_MAX_REVENUE_SHARE_BPS,
            "Arena: invalid revenue share"
        );

        DelegationPool storage pool = delegationPools[msg.sender];

        if (pool.agent == address(0)) {
            address token = _token == address(0) ? core.defaultToken() : _token;
            pool.agent = msg.sender;
            pool.token = token;
            pool.revenueShareBps = _revenueShareBps;
            pool.acceptingDelegations = true;
            emit DelegationPoolOpened(msg.sender, token, _revenueShareBps);
        } else {
            pool.revenueShareBps = _revenueShareBps;
            emit DelegatorRevenueShareUpdated(msg.sender, _revenueShareBps);
        }
    }

    /// @notice Delegates stake to an agent's delegation pool.
    /// @param _agent The agent whose pool will receive the delegation.
    /// @param _amount The amount of tokens to delegate.
    function delegateStake(address _agent, uint256 _amount)
        external whenNotPaused nonReentrant
    {
        require(_amount > 0, "Arena: amount must be > 0");
        require(msg.sender != _agent, "Arena: cannot delegate to self");
        require(!core.agentBanned(_agent), "Arena: agent is banned");

        DelegationPool storage pool = delegationPools[_agent];
        require(pool.agent != address(0), "Arena: no delegation pool");
        require(pool.acceptingDelegations, "Arena: pool not accepting delegations");

        if (delegatorContributions[_agent][msg.sender] == 0) {
            require(pool.delegatorCount < DELEGATION_MAX_DELEGATORS, "Arena: max delegators reached");
            agentDelegatorList[_agent].push(msg.sender);
            pool.delegatorCount++;
        }

        IERC20(pool.token).safeTransferFrom(msg.sender, address(this), _amount);
        delegatorContributions[_agent][msg.sender] += _amount;
        pool.totalDelegated += _amount;

        emit StakeDelegated(_agent, msg.sender, _amount);
    }

    /// @notice Withdraws a delegator's stake from an agent's delegation pool.
    /// @param _agent The agent whose pool to withdraw from.
    /// @param _amount The amount of tokens to withdraw.
    function withdrawDelegation(address _agent, uint256 _amount) external nonReentrant {
        require(_amount > 0, "Arena: amount must be > 0");

        DelegationPool storage pool = delegationPools[_agent];
        uint256 contribution = delegatorContributions[_agent][msg.sender];
        require(contribution >= _amount, "Arena: insufficient contribution");

        uint256 available = pool.totalDelegated - pool.lockedCapital;
        require(available >= _amount, "Arena: capital locked in active tasks");

        delegatorContributions[_agent][msg.sender] -= _amount;
        pool.totalDelegated -= _amount;

        if (delegatorContributions[_agent][msg.sender] == 0) {
            address[] storage delegators = agentDelegatorList[_agent];
            for (uint256 i = 0; i < delegators.length; i++) {
                if (delegators[i] == msg.sender) {
                    delegators[i] = delegators[delegators.length - 1];
                    delegators.pop();
                    break;
                }
            }
            pool.delegatorCount--;
        }

        IERC20(pool.token).safeTransfer(msg.sender, _amount);
        emit DelegationWithdrawn(_agent, msg.sender, _amount);
    }

    /// @notice Records delegation details when an agent's bid is committed to a task.
    /// @param _taskId The task identifier.
    /// @param _agent The agent whose delegated capital is being used.
    /// @param _ownStake The agent's own stake contribution.
    /// @param _delegatedStake The amount of delegated capital locked for this task.
    /// @param _revenueShareBps Revenue share rate snapshot at time of recording, in basis points.
    /// @param _poolSnapshotTotal Total pool size snapshot used for pro-rata calculations.
    function recordTaskDelegation(
        uint256 _taskId,
        address _agent,
        uint256 _ownStake,
        uint256 _delegatedStake,
        uint256 _revenueShareBps,
        uint256 _poolSnapshotTotal
    ) external onlyCoreOrOwner {
        DelegationPool storage pool = delegationPools[_agent];
        pool.totalDelegated -= _delegatedStake;
        pool.lockedCapital += _delegatedStake;

        taskDelegations[_taskId] = TaskDelegation({
            agent: _agent,
            ownStake: _ownStake,
            delegatedStake: _delegatedStake,
            revenueShareBps: _revenueShareBps,
            poolSnapshotTotal: _poolSnapshotTotal,
            escrowPayout: 0,
            escrowStakeReturn: 0,
            settled: false
        });
    }

    /// @notice Settles a task's delegation by recording the escrow payout and stake return amounts.
    /// @param _taskId The task identifier.
    /// @param _escrowPayout The total payout released from escrow for delegators.
    /// @param _escrowStakeReturn The total stake amount returned from escrow.
    function settleTaskDelegation(uint256 _taskId, uint256 _escrowPayout, uint256 _escrowStakeReturn) external onlyCoreOrOwner {
        TaskDelegation storage td = taskDelegations[_taskId];
        td.escrowPayout = _escrowPayout;
        td.escrowStakeReturn = _escrowStakeReturn;
        td.settled = true;
    }

    /// @notice Returns the delegation record for a given task.
    /// @param _taskId The task identifier.
    /// @return The TaskDelegation struct for the specified task.
    function getTaskDelegation(uint256 _taskId) external view returns (TaskDelegation memory) {
        return taskDelegations[_taskId];
    }

    /// @notice Claims a delegator's pro-rata rewards or loss settlement for a settled task.
    /// @param _taskId The task identifier to claim rewards or losses for.
    function claimDelegatorRewards(uint256 _taskId) external nonReentrant {
        TaskDelegation storage td = taskDelegations[_taskId];
        require(td.settled, "Arena: task not settled");
        require(!delegatorClaimed[_taskId][msg.sender], "Arena: already claimed");

        address agent = td.agent;
        uint256 contribution = delegatorContributions[agent][msg.sender];
        require(contribution > 0, "Arena: not a delegator");

        delegatorClaimed[_taskId][msg.sender] = true;

        DelegationPool storage pool = delegationPools[agent];
        IERC20 token = IERC20(pool.token);

        uint256 delegatorLockedShare = (contribution * td.delegatedStake) / td.poolSnapshotTotal;

        (,,,,,,,,,TaskStatus status,) = core.tasks(_taskId);

        if (status == TaskStatus.Completed) {
            uint256 delegatorPayoutShare = td.escrowPayout > 0
                ? (contribution * td.escrowPayout) / td.poolSnapshotTotal
                : 0;
            uint256 delegatorStakeReturn = td.escrowStakeReturn > 0
                ? (contribution * td.escrowStakeReturn) / td.poolSnapshotTotal
                : 0;

            uint256 totalClaim = delegatorPayoutShare + delegatorStakeReturn;
            if (totalClaim > 0) {
                token.safeTransfer(msg.sender, totalClaim);
            }

            if (delegatorLockedShare > 0) {
                pool.lockedCapital = pool.lockedCapital >= delegatorLockedShare
                    ? pool.lockedCapital - delegatorLockedShare
                    : 0;
            }
            pool.totalDelegated += delegatorStakeReturn;

            emit DelegatorRewardsClaimed(_taskId, msg.sender, agent, delegatorPayoutShare, delegatorStakeReturn);

        } else if (status == TaskStatus.Failed) {
            uint256 delegatorReturn = td.escrowStakeReturn > 0
                ? (contribution * td.escrowStakeReturn) / td.poolSnapshotTotal
                : 0;
            uint256 delegatorLoss = delegatorLockedShare > delegatorReturn
                ? delegatorLockedShare - delegatorReturn
                : 0;

            if (delegatorReturn > 0) {
                token.safeTransfer(msg.sender, delegatorReturn);
            }

            if (delegatorLoss >= contribution) {
                delegatorContributions[agent][msg.sender] = 0;
            } else {
                delegatorContributions[agent][msg.sender] -= delegatorLoss;
            }

            if (delegatorLoss > 0) {
                pool.totalDelegated = pool.totalDelegated >= delegatorLoss
                    ? pool.totalDelegated - delegatorLoss
                    : 0;
            }

            if (delegatorLockedShare > 0) {
                pool.lockedCapital = pool.lockedCapital >= delegatorLockedShare
                    ? pool.lockedCapital - delegatorLockedShare
                    : 0;
            }

            emit DelegatorLossesClaimed(_taskId, msg.sender, agent, delegatorReturn, delegatorLoss);
        }
    }

    /// @notice Returns a delegator's contribution and pool details for a given agent.
    /// @param _agent The agent whose pool to query.
    /// @param _delegator The delegator address to look up.
    /// @return contribution The delegator's current contribution amount.
    /// @return poolTotal The total amount delegated in the agent's pool.
    /// @return revenueShareBps The agent's current revenue share in basis points.
    /// @return lockedCapital The amount of pool capital currently locked in active tasks.
    function getDelegatorInfo(address _agent, address _delegator) external view returns (
        uint256 contribution, uint256 poolTotal, uint256 revenueShareBps, uint256 lockedCapital
    ) {
        DelegationPool storage pool = delegationPools[_agent];
        return (
            delegatorContributions[_agent][_delegator],
            pool.totalDelegated,
            pool.revenueShareBps,
            pool.lockedCapital
        );
    }

    /// @notice Returns the list of delegator addresses for a given agent.
    /// @param _agent The agent whose delegators to retrieve.
    /// @return An array of delegator addresses.
    function getAgentDelegations(address _agent) external view returns (address[] memory) {
        return agentDelegatorList[_agent];
    }

    /// @notice Returns the full delegation pool details for a given agent.
    /// @param _agent The agent whose delegation pool to query.
    /// @return agent The agent address that owns the pool.
    /// @return token The ERC-20 token used by the pool.
    /// @return totalDelegated The total amount currently delegated.
    /// @return delegatorCount The number of active delegators.
    /// @return revenueShareBps The revenue share offered to delegators in basis points.
    /// @return acceptingDelegations Whether the pool is currently accepting new delegations.
    /// @return lockedCapital The amount of capital locked in active tasks.
    function getAgentDelegationPool(address _agent) external view returns (
        address agent, address token, uint256 totalDelegated,
        uint256 delegatorCount, uint256 revenueShareBps,
        bool acceptingDelegations, uint256 lockedCapital
    ) {
        DelegationPool storage pool = delegationPools[_agent];
        return (pool.agent, pool.token, pool.totalDelegated, pool.delegatorCount,
                pool.revenueShareBps, pool.acceptingDelegations, pool.lockedCapital);
    }

    /// @notice Pauses all delegation operations.
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpauses all delegation operations.
    function unpause() external onlyOwner { _unpause(); }
}
