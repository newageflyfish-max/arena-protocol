// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArenaProfiles
 * @notice User profile satellite for The Arena protocol.
 * @dev Stores display name, bio, website URL, profile type, and IPFS avatar
 *      hash for each registered address. Profiles are self-sovereign — only
 *      the owner of an address can create or update their own profile.
 */
contract ArenaProfiles is Ownable {

    // ═══════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════

    enum ProfileType { Poster, Agent, Verifier, Insurer }

    // ═══════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════

    struct Profile {
        bool exists;
        ProfileType profileType;
        bytes32 avatarHash;
        string displayName;
        string bio;
        string websiteUrl;
        uint256 createdAt;
        uint256 updatedAt;
    }

    // ═══════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════

    /// @notice ArenaCoreMain contract address (stored for reference)
    address public arenaCore;

    /// @notice Address => profile data
    mapping(address => Profile) public profiles;

    /// @notice Total number of registered profiles
    uint256 public profileCount;

    // ═══════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════

    event ProfileCreated(address indexed user, ProfileType profileType, string displayName);
    event ProfileUpdated(address indexed user);

    // ═══════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════

    error ProfileAlreadyExists();
    error ProfileDoesNotExist();
    error EmptyDisplayName();
    error DisplayNameTooLong();
    error BioTooLong();
    error UrlTooLong();
    error ZeroAddress();

    // ═══════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════

    constructor(address _core) Ownable(msg.sender) {
        if (_core == address(0)) revert ZeroAddress();
        arenaCore = _core;
    }

    // ═══════════════════════════════════════════════════
    // WRITE FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Create a new profile for the caller.
     * @param _profileType The user's primary role (Poster, Agent, Verifier, Insurer)
     * @param _displayName Display name (1-64 bytes)
     * @param _bio Bio text (0-280 bytes)
     * @param _websiteUrl Website URL (0-128 bytes)
     * @param _avatarHash IPFS CID as bytes32 (0x0 for no avatar)
     */
    function createProfile(
        ProfileType _profileType,
        string calldata _displayName,
        string calldata _bio,
        string calldata _websiteUrl,
        bytes32 _avatarHash
    ) external {
        if (profiles[msg.sender].exists) revert ProfileAlreadyExists();
        if (bytes(_displayName).length == 0) revert EmptyDisplayName();
        if (bytes(_displayName).length > 64) revert DisplayNameTooLong();
        if (bytes(_bio).length > 280) revert BioTooLong();
        if (bytes(_websiteUrl).length > 128) revert UrlTooLong();

        profiles[msg.sender] = Profile({
            exists: true,
            profileType: _profileType,
            avatarHash: _avatarHash,
            displayName: _displayName,
            bio: _bio,
            websiteUrl: _websiteUrl,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });
        profileCount++;

        emit ProfileCreated(msg.sender, _profileType, _displayName);
    }

    /**
     * @notice Update an existing profile. Cannot change profile type.
     * @param _displayName New display name (1-64 bytes)
     * @param _bio New bio text (0-280 bytes)
     * @param _websiteUrl New website URL (0-128 bytes)
     * @param _avatarHash New IPFS avatar hash (0x0 for no avatar)
     */
    function updateProfile(
        string calldata _displayName,
        string calldata _bio,
        string calldata _websiteUrl,
        bytes32 _avatarHash
    ) external {
        if (!profiles[msg.sender].exists) revert ProfileDoesNotExist();
        if (bytes(_displayName).length == 0) revert EmptyDisplayName();
        if (bytes(_displayName).length > 64) revert DisplayNameTooLong();
        if (bytes(_bio).length > 280) revert BioTooLong();
        if (bytes(_websiteUrl).length > 128) revert UrlTooLong();

        Profile storage p = profiles[msg.sender];
        p.displayName = _displayName;
        p.bio = _bio;
        p.websiteUrl = _websiteUrl;
        p.avatarHash = _avatarHash;
        p.updatedAt = block.timestamp;

        emit ProfileUpdated(msg.sender);
    }

    // ═══════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════

    /**
     * @notice Get the full profile for an address.
     * @param _user Address to look up
     * @return The Profile struct (exists == false if not registered)
     */
    function getProfile(address _user) external view returns (Profile memory) {
        return profiles[_user];
    }

    /**
     * @notice Check if an address has a registered profile.
     * @param _user Address to check
     * @return true if profile exists
     */
    function hasProfile(address _user) external view returns (bool) {
        return profiles[_user].exists;
    }
}
