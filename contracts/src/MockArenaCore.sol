// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ArenaTypes.sol";

/**
 * @title MockArenaCore
 * @notice Minimal mock of ArenaCore for testing ArenaReputation.
 */
contract MockArenaCore {
    mapping(address => uint256) public agentReputation;
    mapping(address => uint256) public agentTasksCompleted;
    mapping(address => uint256) public agentTasksFailed;
    mapping(address => uint256) public agentActiveStake;
    mapping(address => bool) public agentBanned;
    mapping(address => uint256) public agentSlashCooldownEnd;

    uint256 public taskCount;

    // Mock task and assignment storage
    mapping(uint256 => Task) internal _tasks;
    mapping(uint256 => Assignment) internal _assignments;

    function setAgentReputation(address _agent, uint256 _rep) external {
        agentReputation[_agent] = _rep;
    }

    function setAgentTasksCompleted(address _agent, uint256 _count) external {
        agentTasksCompleted[_agent] = _count;
    }

    function setAgentTasksFailed(address _agent, uint256 _count) external {
        agentTasksFailed[_agent] = _count;
    }

    function setAgentActiveStake(address _agent, uint256 _stake) external {
        agentActiveStake[_agent] = _stake;
    }

    function setAgentBanned(address _agent, bool _banned) external {
        agentBanned[_agent] = _banned;
    }

    function protocolTreasury() external pure returns (uint256) {
        return 0;
    }

    function defaultToken() external pure returns (address) {
        return address(0);
    }

    // ---- Mock task/assignment setters ----

    function setTask(
        uint256 _taskId,
        address _poster,
        TaskStatus _status
    ) external {
        _tasks[_taskId].poster = _poster;
        _tasks[_taskId].status = _status;
    }

    function setTaskFull(
        uint256 _taskId,
        address _poster,
        address _token,
        uint256 _bounty,
        uint256 _deadline,
        TaskStatus _status,
        string calldata _taskType
    ) external {
        Task storage t = _tasks[_taskId];
        t.poster = _poster;
        t.token = _token;
        t.bounty = _bounty;
        t.deadline = _deadline;
        t.status = _status;
        t.taskType = _taskType;
    }

    function setAssignment(
        uint256 _taskId,
        address _agent,
        uint256 _stake,
        uint256 _price
    ) external {
        _assignments[_taskId].agent = _agent;
        _assignments[_taskId].stake = _stake;
        _assignments[_taskId].price = _price;
    }

    function getTask(uint256 _taskId) external view returns (Task memory) {
        return _tasks[_taskId];
    }

    function getAssignment(uint256 _taskId) external view returns (Assignment memory) {
        return _assignments[_taskId];
    }
}
