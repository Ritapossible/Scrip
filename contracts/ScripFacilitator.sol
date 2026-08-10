// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * Settles x402 invoices in FXRP.
 *
 * The payer never sends a transaction and never holds a gas token: they sign an
 * EIP-2612 permit offchain, and whoever calls settle() pays the gas.
 *
 * FXRP implements EIP-2612 permit rather than EIP-3009
 * transferWithAuthorization, which is what USDC uses and what most x402
 * implementations assume. The difference matters here: a permit grants an
 * allowance rather than authorising one specific transfer, so the invoice
 * binding below is what makes a signature single-use.
 */
contract ScripFacilitator {
    IERC20 public immutable token;

    /// Invoice IDs already paid. A permit signature stays valid until its
    /// deadline, so without this a relayer could settle the same invoice twice.
    mapping(bytes32 => bool) public settled;

    event PaymentSettled(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 requested,
        uint256 delivered
    );

    error AlreadySettled(bytes32 invoiceId);
    error Underdelivered(uint256 requested, uint256 delivered);

    constructor(address _token) {
        token = IERC20(_token);
    }

    function settle(
        bytes32 invoiceId,
        address payer,
        address payee,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (settled[invoiceId]) revert AlreadySettled(invoiceId);
        settled[invoiceId] = true; // effects before interactions

        // Spike note: this call is deliberately NOT wrapped in try/catch yet, so
        // a bad signature reverts with a readable reason instead of failing
        // later as an opaque allowance error. Wrap it once signing is proven -
        // in production a front-runner can consume the permit from the mempool,
        // and the transferFrom below is what actually has to succeed.
        IERC20Permit(address(token)).permit(payer, address(this), amount, deadline, v, r, s);

        // FAssets parameters are asset-manager controlled and may levy a
        // transfer fee. An invoice that silently underpays the payee is a broken
        // payment rail, so measure what actually arrived rather than trusting
        // the transfer amount.
        uint256 balanceBefore = token.balanceOf(payee);
        token.transferFrom(payer, payee, amount);
        uint256 delivered = token.balanceOf(payee) - balanceBefore;
        if (delivered < amount) revert Underdelivered(amount, delivered);

        emit PaymentSettled(invoiceId, payer, payee, amount, delivered);
    }
}
