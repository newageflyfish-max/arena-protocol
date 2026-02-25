// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/**
 * @title MockVRFCoordinatorV2Plus
 * @notice A simplified mock VRF Coordinator for V2.5 testing.
 *         Allows manual fulfillment of randomness requests.
 */
contract MockVRFCoordinatorV2Plus {
    uint256 private _nextRequestId = 1;
    uint256 private _nextSubId = 1;

    struct Request {
        address consumer;
        uint32 numWords;
        bool fulfilled;
    }

    mapping(uint256 => Request) public requests;
    mapping(uint256 => bool) public subscriptions;

    event RandomWordsRequested(
        uint256 indexed requestId,
        address indexed consumer,
        uint32 numWords
    );

    event RandomWordsFulfilled(
        uint256 indexed requestId,
        address indexed consumer
    );

    /**
     * @notice Create a mock subscription
     */
    function createSubscription() external returns (uint256 subId) {
        subId = _nextSubId++;
        subscriptions[subId] = true;
    }

    /**
     * @notice Add a consumer to a subscription (no-op in mock)
     */
    function addConsumer(uint256 /* subId */, address /* consumer */) external pure {
        // no-op for testing
    }

    /**
     * @notice Fund a subscription (no-op in mock)
     */
    function fundSubscription(uint256 /* subId */, uint96 /* amount */) external pure {
        // no-op for testing
    }

    /**
     * @notice Request random words — stores the request for later fulfillment
     */
    function requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest calldata req
    ) external returns (uint256 requestId) {
        requestId = _nextRequestId++;
        requests[requestId] = Request({
            consumer: msg.sender,
            numWords: req.numWords,
            fulfilled: false
        });

        emit RandomWordsRequested(requestId, msg.sender, req.numWords);
    }

    /**
     * @notice Manually fulfill a randomness request (for testing).
     *         Calls rawFulfillRandomWords on the consumer.
     * @param _requestId The request to fulfill
     * @param _randomWords The random values to provide
     */
    function fulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) external {
        Request storage req = requests[_requestId];
        require(req.consumer != address(0), "MockVRF: request not found");
        require(!req.fulfilled, "MockVRF: already fulfilled");
        require(_randomWords.length == req.numWords, "MockVRF: wrong word count");

        req.fulfilled = true;

        // Call the consumer's rawFulfillRandomWords
        (bool success, bytes memory returndata) = req.consumer.call(
            abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", _requestId, _randomWords)
        );
        require(success, string(abi.encodePacked("MockVRF: callback failed: ", returndata)));

        emit RandomWordsFulfilled(_requestId, req.consumer);
    }

    /**
     * @notice Fulfill with auto-generated pseudorandom values (convenience for testing)
     */
    function fulfillRandomWordsWithOverride(uint256 _requestId) external {
        Request storage req = requests[_requestId];
        require(req.consumer != address(0), "MockVRF: request not found");
        require(!req.fulfilled, "MockVRF: already fulfilled");

        req.fulfilled = true;

        uint256[] memory randomWords = new uint256[](req.numWords);
        for (uint256 i = 0; i < req.numWords; i++) {
            randomWords[i] = uint256(keccak256(abi.encode(_requestId, i, block.timestamp, block.prevrandao)));
        }

        (bool success, ) = req.consumer.call(
            abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", _requestId, randomWords)
        );
        require(success, "MockVRF: callback failed");

        emit RandomWordsFulfilled(_requestId, req.consumer);
    }
}
