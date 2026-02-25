// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ArenaTypes.sol";

/**
 * @title ArenaSyndicates
 * @notice Pooled staking syndicates for The Arena protocol.
 *         Members pool capital, manager bids on tasks, rewards/losses distributed proportionally.
 *
 *         Safety invariants:
 *         - Manager must hold >= 20% of total syndicate stake (skin in the game)
 *         - Manager cannot be the poster on any task the syndicate bids on
 *         - Dissolution requires majority vote by stake weight from members
 *         - Dissolution blocked while active tasks or bids exist
 */
contract ArenaSyndicates is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    IArenaCore public immutable core;
    address public arenaCore;

    uint256 public constant SYNDICATE_MAX_MEMBERS = 20;
    uint256 public constant SYNDICATE_MIN_CONTRIBUTION_BPS = 100;
    uint256 public constant SYNDICATE_MIN_MEMBERS = 2;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MANAGER_MIN_STAKE_BPS = 2000; // 20%

    uint256 public syndicateCount;

    mapping(uint256 => Syndicate) public syndicates;
    mapping(uint256 => mapping(address => SyndicateMember)) public syndicateMembers;
    mapping(uint256 => address[]) public syndicateMemberList;
    mapping(address => uint256) public agentSyndicateId;
    mapping(uint256 => uint256) public syndicateActiveTasks;
    mapping(uint256 => uint256) public taskSyndicate;
    mapping(uint256 => uint256) public syndicateStakedOnTask;
    mapping(uint256 => uint256) public syndicateTaskPayout;
    mapping(uint256 => bool) public syndicateTaskDistributed;
    mapping(uint256 => bool) public syndicateTaskLossDistributed;

    // Dissolution vote state
    mapping(uint256 => mapping(address => bool)) public dissolutionVotes;
    mapping(uint256 => uint256) public dissolutionVoteWeight;

    // Active bid tracking — syndicateId => count of pending bids
    mapping(uint256 => uint256) public syndicateActiveBids;

    event SyndicateCreated(uint256 indexed syndicateId, address indexed manager, string name);
    event SyndicateJoined(uint256 indexed syndicateId, address indexed member, uint256 contribution);
    event SyndicateLeft(uint256 indexed syndicateId, address indexed member, uint256 returned);
    event SyndicateDissolved(uint256 indexed syndicateId);
    event SyndicateBidCommitted(uint256 indexed syndicateId, uint256 indexed taskId, bytes32 commitHash);
    event SyndicateBidRevealed(uint256 indexed syndicateId, uint256 indexed taskId, uint256 stake, uint256 price);
    event SyndicateRewardsDistributed(uint256 indexed syndicateId, uint256 indexed taskId, uint256 totalPayout);
    event SyndicateLossesDistributed(uint256 indexed syndicateId, uint256 indexed taskId, uint256 totalLoss);
    event ArenaCoreUpdated(address indexed newCore);
    event DissolutionVoteCast(uint256 indexed syndicateId, address indexed member, uint256 weight);
    event DissolutionVoteRevoked(uint256 indexed syndicateId, address indexed member, uint256 weight);

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

    /// @notice Update the ArenaCore contract address
    /// @param _core New ArenaCore contract address
    function setArenaCore(address _core) external onlyOwner {
        arenaCore = _core;
        emit ArenaCoreUpdated(_core);
    }

    function createSyndicate(
        string calldata _name,
        address _token,
        uint256 _initialContribution
    ) external whenNotPaused notBanned nonReentrant returns (uint256 syndicateId) {
        require(bytes(_name).length > 0, "Arena: name required");
        require(_initialContribution > 0, "Arena: contribution must be > 0");
        require(agentSyndicateId[msg.sender] == 0, "Arena: already in a syndicate");

        address token = _token == address(0) ? core.defaultToken() : _token;
        IERC20(token).safeTransferFrom(msg.sender, address(this), _initialContribution);

        syndicateId = ++syndicateCount;

        syndicates[syndicateId] = Syndicate({
            syndicateId: syndicateId,
            name: _name,
            manager: msg.sender,
            token: token,
            totalStake: _initialContribution,
            memberCount: 1,
            status: SyndicateStatus.Active,
            createdAt: block.timestamp
        });

        syndicateMembers[syndicateId][msg.sender] = SyndicateMember({
            member: msg.sender,
            contribution: _initialContribution,
            joinedAt: block.timestamp
        });

        syndicateMemberList[syndicateId].push(msg.sender);
        agentSyndicateId[msg.sender] = syndicateId;

        emit SyndicateCreated(syndicateId, msg.sender, _name);
    }

    /// @notice Join an existing syndicate by contributing tokens to the pool
    /// @param _syndicateId ID of the syndicate to join
    /// @param _contribution Amount of tokens to contribute as stake
    function joinSyndicate(uint256 _syndicateId, uint256 _contribution)
        external whenNotPaused notBanned nonReentrant
    {
        Syndicate storage syndicate = syndicates[_syndicateId];
        require(syndicate.status == SyndicateStatus.Active, "Arena: syndicate not active");
        require(_contribution > 0, "Arena: contribution must be > 0");
        require(agentSyndicateId[msg.sender] == 0, "Arena: already in a syndicate");
        require(syndicate.memberCount < SYNDICATE_MAX_MEMBERS, "Arena: syndicate full");

        IERC20(syndicate.token).safeTransferFrom(msg.sender, address(this), _contribution);

        syndicateMembers[_syndicateId][msg.sender] = SyndicateMember({
            member: msg.sender,
            contribution: _contribution,
            joinedAt: block.timestamp
        });

        syndicateMemberList[_syndicateId].push(msg.sender);
        syndicate.totalStake += _contribution;
        syndicate.memberCount++;
        agentSyndicateId[msg.sender] = _syndicateId;

        // Verify manager still meets 20% minimum after dilution
        uint256 managerStake = syndicateMembers[_syndicateId][syndicate.manager].contribution;
        require(
            managerStake * BPS_DENOMINATOR >= syndicate.totalStake * MANAGER_MIN_STAKE_BPS,
            "Arena: manager stake below 20%"
        );

        emit SyndicateJoined(_syndicateId, msg.sender, _contribution);
    }

    /// @notice Leave a syndicate and withdraw contributed stake
    /// @param _syndicateId ID of the syndicate to leave
    function leaveSyndicate(uint256 _syndicateId) external nonReentrant {
        Syndicate storage syndicate = syndicates[_syndicateId];
        SyndicateMember storage member = syndicateMembers[_syndicateId][msg.sender];
        require(member.contribution > 0, "Arena: not a member");
        require(syndicateActiveTasks[_syndicateId] == 0, "Arena: syndicate has active tasks");

        if (msg.sender == syndicate.manager && syndicate.memberCount > 1) {
            revert("Arena: manager must dissolve syndicate");
        }

        uint256 contribution = member.contribution;

        // Clear dissolution vote if any
        if (dissolutionVotes[_syndicateId][msg.sender]) {
            dissolutionVoteWeight[_syndicateId] -= contribution;
            dissolutionVotes[_syndicateId][msg.sender] = false;
        }

        IERC20(syndicate.token).safeTransfer(msg.sender, contribution);

        address[] storage members = syndicateMemberList[_syndicateId];
        for (uint256 i = 0; i < members.length; i++) {
            if (members[i] == msg.sender) {
                members[i] = members[members.length - 1];
                members.pop();
                break;
            }
        }

        syndicate.totalStake -= contribution;
        syndicate.memberCount--;
        delete syndicateMembers[_syndicateId][msg.sender];
        agentSyndicateId[msg.sender] = 0;

        if (syndicate.memberCount == 0) {
            syndicate.status = SyndicateStatus.Dissolved;
            emit SyndicateDissolved(_syndicateId);
        }

        emit SyndicateLeft(_syndicateId, msg.sender, contribution);
    }

    /**
     * @notice Vote for syndicate dissolution. Each member votes with their stake weight.
     *         Dissolution requires >50% of total stake to vote in favor.
     */
    function voteDissolution(uint256 _syndicateId) external {
        Syndicate storage syndicate = syndicates[_syndicateId];
        require(syndicate.status == SyndicateStatus.Active, "Arena: not active");
        SyndicateMember storage m = syndicateMembers[_syndicateId][msg.sender];
        require(m.contribution > 0, "Arena: not a member");
        require(!dissolutionVotes[_syndicateId][msg.sender], "Arena: already voted");

        dissolutionVotes[_syndicateId][msg.sender] = true;
        dissolutionVoteWeight[_syndicateId] += m.contribution;

        emit DissolutionVoteCast(_syndicateId, msg.sender, m.contribution);
    }

    /**
     * @notice Revoke a dissolution vote.
     */
    function revokeDissolutionVote(uint256 _syndicateId) external {
        require(dissolutionVotes[_syndicateId][msg.sender], "Arena: no vote to revoke");
        SyndicateMember storage m = syndicateMembers[_syndicateId][msg.sender];

        dissolutionVotes[_syndicateId][msg.sender] = false;
        dissolutionVoteWeight[_syndicateId] -= m.contribution;

        emit DissolutionVoteRevoked(_syndicateId, msg.sender, m.contribution);
    }

    /**
     * @notice Dissolve a syndicate. Requires:
     *         1. Caller is the manager
     *         2. No active tasks or bids
     *         3. Majority of stake weight has voted for dissolution
     *         Returns all contributions to members.
     */
    function dissolveSyndicate(uint256 _syndicateId) external nonReentrant {
        Syndicate storage syndicate = syndicates[_syndicateId];
        require(msg.sender == syndicate.manager, "Arena: not manager");
        require(syndicate.status == SyndicateStatus.Active, "Arena: already dissolved");
        require(syndicateActiveTasks[_syndicateId] == 0, "Arena: syndicate has active tasks");
        require(syndicateActiveBids[_syndicateId] == 0, "Arena: syndicate has active bids");

        // Require majority vote by stake weight (>50%)
        require(
            dissolutionVoteWeight[_syndicateId] * 2 > syndicate.totalStake,
            "Arena: dissolution not approved"
        );

        syndicate.status = SyndicateStatus.Dissolved;
        IERC20 token = IERC20(syndicate.token);

        address[] storage members = syndicateMemberList[_syndicateId];
        for (uint256 i = 0; i < members.length; i++) {
            address memberAddr = members[i];
            uint256 contribution = syndicateMembers[_syndicateId][memberAddr].contribution;
            if (contribution > 0) {
                token.safeTransfer(memberAddr, contribution);
                delete syndicateMembers[_syndicateId][memberAddr];
                agentSyndicateId[memberAddr] = 0;
            }
        }

        syndicate.totalStake = 0;
        syndicate.memberCount = 0;

        emit SyndicateDissolved(_syndicateId);
    }

    /// @notice Record a task payout amount for later proportional distribution to members
    /// @param _taskId ID of the completed or failed task
    /// @param _syndicateId ID of the syndicate that worked the task
    /// @param _payout Total payout amount to be distributed
    function recordTaskPayout(uint256 _taskId, uint256 _syndicateId, uint256 _payout) external onlyCoreOrOwner {
        syndicateTaskPayout[_taskId] = _payout;
    }

    /**
     * @notice Called by ArenaCore when associating a task with a syndicate.
     *         Validates the task poster is not the syndicate manager (self-dealing prevention).
     */
    function setTaskSyndicate(uint256 _taskId, uint256 _syndicateId) external onlyCoreOrOwner {
        // Prevent manager from bidding on their own posted tasks
        (address poster,,,,,,,,,,) = core.tasks(_taskId);
        require(poster != syndicates[_syndicateId].manager, "Arena: manager is task poster");
        taskSyndicate[_taskId] = _syndicateId;
    }

    /// @notice Record the amount a syndicate staked on a specific task
    /// @param _taskId ID of the task being staked on
    /// @param _stake Amount of tokens staked
    function setStakedOnTask(uint256 _taskId, uint256 _stake) external onlyCoreOrOwner {
        syndicateStakedOnTask[_taskId] = _stake;
    }

    /// @notice Increment the active task count for a syndicate
    /// @param _syndicateId ID of the syndicate
    function incrementActiveTasks(uint256 _syndicateId) external onlyCoreOrOwner {
        syndicateActiveTasks[_syndicateId]++;
    }

    /// @notice Increment the active bid count for a syndicate
    /// @param _syndicateId ID of the syndicate
    function incrementActiveBids(uint256 _syndicateId) external onlyCoreOrOwner {
        syndicateActiveBids[_syndicateId]++;
    }

    /// @notice Decrement the active bid count for a syndicate (no-op if already zero)
    /// @param _syndicateId ID of the syndicate
    function decrementActiveBids(uint256 _syndicateId) external onlyCoreOrOwner {
        if (syndicateActiveBids[_syndicateId] > 0) {
            syndicateActiveBids[_syndicateId]--;
        }
    }

    /// @notice Deduct an amount from a syndicate's total stake (used when committing stake to tasks)
    /// @param _syndicateId ID of the syndicate
    /// @param _amount Amount to deduct from total stake
    function deductStake(uint256 _syndicateId, uint256 _amount) external onlyCoreOrOwner {
        syndicates[_syndicateId].totalStake -= _amount;
    }

    /// @notice Distribute task rewards proportionally to syndicate members based on contribution
    /// @param _taskId ID of the completed task whose rewards are being distributed
    function distributeSyndicateRewards(uint256 _taskId) external nonReentrant {
        uint256 syndicateId = taskSyndicate[_taskId];
        require(syndicateId > 0, "Arena: not a syndicate task");
        require(!syndicateTaskDistributed[_taskId], "Arena: already distributed");

        (,,,,,,,,,TaskStatus status,) = core.tasks(_taskId);
        require(status == TaskStatus.Completed, "Arena: task not completed");

        uint256 totalPayout = syndicateTaskPayout[_taskId];
        require(totalPayout > 0, "Arena: no payout to distribute");

        Syndicate storage syndicate = syndicates[syndicateId];
        IERC20 token = IERC20(syndicate.token);

        syndicateTaskDistributed[_taskId] = true;
        syndicateActiveTasks[syndicateId]--;

        address[] storage members = syndicateMemberList[syndicateId];
        uint256 totalContributions = 0;
        for (uint256 i = 0; i < members.length; i++) {
            totalContributions += syndicateMembers[syndicateId][members[i]].contribution;
        }
        require(totalContributions > 0, "Arena: no contributions");

        uint256 distributed = 0;
        for (uint256 i = 0; i < members.length; i++) {
            SyndicateMember storage m = syndicateMembers[syndicateId][members[i]];
            if (m.contribution > 0) {
                uint256 share;
                if (i == members.length - 1) {
                    share = totalPayout - distributed;
                } else {
                    share = (m.contribution * totalPayout) / totalContributions;
                }
                if (share > 0) {
                    token.safeTransfer(m.member, share);
                    distributed += share;
                }
            }
        }

        syndicateTaskPayout[_taskId] = 0;
        emit SyndicateRewardsDistributed(syndicateId, _taskId, totalPayout);
    }

    /// @notice Distribute task losses proportionally to syndicate members and return any residual stake
    /// @param _taskId ID of the failed task whose losses are being distributed
    function distributeSyndicateLosses(uint256 _taskId) external nonReentrant {
        uint256 syndicateId = taskSyndicate[_taskId];
        require(syndicateId > 0, "Arena: not a syndicate task");
        require(!syndicateTaskLossDistributed[_taskId], "Arena: losses already distributed");

        (,,,,,,,,,TaskStatus status,) = core.tasks(_taskId);
        require(status == TaskStatus.Failed, "Arena: task not failed");

        Syndicate storage syndicate = syndicates[syndicateId];
        IERC20 token = IERC20(syndicate.token);
        uint256 stakedOnTask = syndicateStakedOnTask[_taskId];
        uint256 agentReturn = syndicateTaskPayout[_taskId];
        uint256 totalLoss = stakedOnTask - agentReturn;

        syndicateTaskLossDistributed[_taskId] = true;
        syndicateActiveTasks[syndicateId]--;

        address[] storage members = syndicateMemberList[syndicateId];
        uint256 totalContributions = 0;
        for (uint256 i = 0; i < members.length; i++) {
            totalContributions += syndicateMembers[syndicateId][members[i]].contribution;
        }

        uint256 distributed = 0;
        for (uint256 i = 0; i < members.length; i++) {
            SyndicateMember storage m = syndicateMembers[syndicateId][members[i]];
            if (m.contribution > 0) {
                uint256 memberReturn;
                uint256 memberLoss;

                if (i == members.length - 1) {
                    memberReturn = agentReturn - distributed;
                    memberLoss = totalLoss > 0 && totalContributions > 0
                        ? (m.contribution * totalLoss) / totalContributions
                        : 0;
                } else {
                    memberReturn = totalContributions > 0
                        ? (m.contribution * agentReturn) / totalContributions
                        : 0;
                    memberLoss = totalContributions > 0
                        ? (m.contribution * totalLoss) / totalContributions
                        : 0;
                }

                if (memberLoss >= m.contribution) {
                    m.contribution = 0;
                } else {
                    m.contribution -= memberLoss;
                }

                if (memberReturn > 0) {
                    token.safeTransfer(m.member, memberReturn);
                    distributed += memberReturn;
                }
            }
        }

        if (totalLoss >= syndicate.totalStake) {
            syndicate.totalStake = 0;
        } else {
            syndicate.totalStake -= totalLoss;
        }

        syndicateTaskPayout[_taskId] = 0;
        emit SyndicateLossesDistributed(syndicateId, _taskId, totalLoss);
    }

    /// @notice Return all fields of a syndicate struct
    /// @param _syndicateId ID of the syndicate to query
    /// @return syndicateId The syndicate ID
    /// @return name The syndicate name
    /// @return manager The manager address
    /// @return token The staking token address
    /// @return totalStake The total pooled stake
    /// @return memberCount The current number of members
    /// @return status The syndicate status (Active or Dissolved)
    /// @return createdAt The creation timestamp
    function getSyndicate(uint256 _syndicateId) external view returns (
        uint256 syndicateId, string memory name, address manager,
        address token, uint256 totalStake, uint256 memberCount,
        SyndicateStatus status, uint256 createdAt
    ) {
        Syndicate storage s = syndicates[_syndicateId];
        return (s.syndicateId, s.name, s.manager, s.token, s.totalStake, s.memberCount, s.status, s.createdAt);
    }

    /// @notice Return the membership details for a specific member in a syndicate
    /// @param _syndicateId ID of the syndicate
    /// @param _member Address of the member to query
    /// @return The SyndicateMember struct for the given member
    function getSyndicateMember(uint256 _syndicateId, address _member) external view returns (SyndicateMember memory) {
        return syndicateMembers[_syndicateId][_member];
    }

    /// @notice Return the list of member addresses in a syndicate
    /// @param _syndicateId ID of the syndicate
    /// @return Array of member addresses
    function getSyndicateMembers(uint256 _syndicateId) external view returns (address[] memory) {
        return syndicateMemberList[_syndicateId];
    }

    /// @notice Return the syndicate ID associated with a given task
    /// @param _taskId ID of the task
    /// @return The syndicate ID (0 if no syndicate is associated)
    function getTaskSyndicate(uint256 _taskId) external view returns (uint256) {
        return taskSyndicate[_taskId];
    }

    /// @notice Return the number of active tasks for a syndicate
    /// @param _syndicateId ID of the syndicate
    /// @return The count of active tasks
    function getSyndicateActiveTasks(uint256 _syndicateId) external view returns (uint256) {
        return syndicateActiveTasks[_syndicateId];
    }

    /// @notice Return the total stake-weighted vote count for syndicate dissolution
    /// @param _syndicateId ID of the syndicate
    /// @return The cumulative stake weight that has voted for dissolution
    function getDissolutionVoteWeight(uint256 _syndicateId) external view returns (uint256) {
        return dissolutionVoteWeight[_syndicateId];
    }

    /// @notice Pause the contract, disabling syndicate creation and joining
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpause the contract, re-enabling syndicate creation and joining
    function unpause() external onlyOwner { _unpause(); }
}
