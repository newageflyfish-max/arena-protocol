// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArenaTimelock
 * @notice Timelock controller for sensitive Arena Protocol admin functions.
 *         This contract becomes the owner of ArenaCore and satellite contracts.
 *         Sensitive operations are queued with a 48-hour delay before execution.
 *         pause() and unpause() bypass the timelock for emergency response.
 */
contract ArenaTimelock is Ownable {
    uint256 public constant DELAY = 48 hours;
    uint256 public constant GRACE_PERIOD = 14 days;

    struct QueuedTx {
        address target;
        bytes data;
        uint256 eta;       // earliest execution time
        bool executed;
        bool cancelled;
    }

    uint256 public txCount;
    mapping(uint256 => QueuedTx) public queuedTxs;

    event TransactionQueued(uint256 indexed txId, address indexed target, bytes data, uint256 eta);
    event TransactionExecuted(uint256 indexed txId, address indexed target, bytes data);
    event TransactionCancelled(uint256 indexed txId);

    error NotReady();          // T1: eta not reached
    error Expired();           // T2: past grace period
    error AlreadyExecuted();   // T3
    error AlreadyCancelled();  // T4
    error ExecutionFailed();   // T5

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Queue a transaction for delayed execution.
     * @param _target The contract to call
     * @param _data The encoded function call
     * @return txId The queued transaction ID
     */
    function queueTransaction(address _target, bytes calldata _data) external onlyOwner returns (uint256 txId) {
        txId = txCount++;
        uint256 eta = block.timestamp + DELAY;
        queuedTxs[txId] = QueuedTx({
            target: _target,
            data: _data,
            eta: eta,
            executed: false,
            cancelled: false
        });
        emit TransactionQueued(txId, _target, _data, eta);
    }

    /**
     * @notice Execute a queued transaction after its delay has elapsed.
     *         Anyone can call this — the delay is the security, not the caller.
     * @param _txId The transaction ID to execute
     */
    function executeTransaction(uint256 _txId) external {
        QueuedTx storage qt = queuedTxs[_txId];
        if (qt.executed) revert AlreadyExecuted();
        if (qt.cancelled) revert AlreadyCancelled();
        if (block.timestamp < qt.eta) revert NotReady();
        if (block.timestamp > qt.eta + GRACE_PERIOD) revert Expired();

        qt.executed = true;
        (bool success,) = qt.target.call(qt.data);
        if (!success) revert ExecutionFailed();

        emit TransactionExecuted(_txId, qt.target, qt.data);
    }

    /**
     * @notice Cancel a queued transaction. Only the admin can cancel.
     * @param _txId The transaction ID to cancel
     */
    function cancelTransaction(uint256 _txId) external onlyOwner {
        QueuedTx storage qt = queuedTxs[_txId];
        if (qt.executed) revert AlreadyExecuted();
        if (qt.cancelled) revert AlreadyCancelled();

        qt.cancelled = true;
        emit TransactionCancelled(_txId);
    }

    /**
     * @notice View all queued transactions in a range.
     * @param _from Start index (inclusive)
     * @param _to End index (exclusive)
     */
    function getQueuedTransactions(uint256 _from, uint256 _to) external view returns (QueuedTx[] memory) {
        if (_to > txCount) _to = txCount;
        QueuedTx[] memory result = new QueuedTx[](_to - _from);
        for (uint256 i = _from; i < _to; i++) {
            result[i - _from] = queuedTxs[i];
        }
        return result;
    }
}
