// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Simple ERC20 with public mint for testing purposes.
 *         Uses 6 decimals like real USDC.
 *         Deployed on Base Sepolia as "Arena Test USDC" (aUSDC).
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Arena Test USDC", "aUSDC") {}

    /// @notice Returns the number of decimals (6, matching real USDC)
    /// @return The number of decimals
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints tokens to a specified address (unrestricted, for testing only)
    /// @param to Recipient address
    /// @param amount Amount of tokens to mint
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
