// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
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
 * The payer never sends a transaction and never holds a gas token: they sign
 * offchain, and whoever calls settle() pays the gas.
 *
 * FXRP implements EIP-2612 permit rather than EIP-3009
 * transferWithAuthorization, which is what USDC uses and what most x402
 * implementations assume. That difference is the whole reason this contract
 * needs two signatures rather than one.
 *
 * An EIP-3009 authorisation names its recipient: the signature itself says
 * "move X to this address". An EIP-2612 permit does not. A permit commits only
 * to (owner, spender, value, nonce, deadline) - it grants an allowance and says
 * nothing about where the money then goes. So a permit alone cannot authorise a
 * payment, only a spend limit.
 *
 * settle() is permissionless by design, because any relayer should be able to
 * carry a payment. That makes the missing recipient a hole rather than an
 * omission: anyone who observes a permit signature - in the mempool, or on the
 * x402 HTTP path it necessarily travels - could otherwise call settle() naming
 * themselves as payee and take the funds.
 *
 * The PaymentIntent below closes it. The payer signs a second EIP-712 message
 * that does name the invoice, the payee and the amount, and settle() verifies
 * it against the payer. The permit authorises the allowance; the intent
 * authorises the destination. Neither is sufficient alone.
 */
contract ScripFacilitator {
    /// Mirrors PAYMENT_INTENT_TYPEHASH field for field. Passed as calldata
    /// rather than as loose arguments because settle() needs both signatures
    /// alongside it, and eleven flat parameters overflow the stack under
    /// legacy codegen.
    struct PaymentIntent {
        bytes32 invoiceId;
        address payer;
        address payee;
        uint256 amount;
        uint256 deadline;
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    IERC20 public immutable token;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// The payer's authorisation of a specific payment. Every field a relayer
    /// supplies as calldata appears here, so none of them can be substituted.
    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 invoiceId,address payer,address payee,uint256 amount,uint256 deadline)"
    );

    bytes32 private constant _NAME_HASH = keccak256("Scrip");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    // Cached because the common path should not rebuild the separator, but
    // rebuilt if chainid changes so signatures cannot cross a fork.
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    /// Payments already made, keyed on (invoiceId, payer). A signature stays
    /// valid until its deadline, so without this a relayer could settle the same
    /// invoice twice.
    ///
    /// Keyed on the pair rather than the invoice alone because invoice IDs
    /// travel the x402 HTTP path in the clear. Keyed on the invoice by itself,
    /// anyone who saw one could settle their own payment against it first and
    /// burn it for the payer it was issued to - no funds at risk, since the
    /// intent binds payer, payee and amount, but the quote is spent and the
    /// intended payer is left holding a signature for something that can never
    /// settle. Namespacing by payer costs a hash and closes it: a stranger's
    /// payment lands under a different key and leaves the real one payable.
    mapping(bytes32 => bool) private _settled;

    event PaymentSettled(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 requested,
        uint256 delivered
    );

    error AlreadySettled(bytes32 invoiceId);
    error ZeroAmount();
    error Underdelivered(uint256 requested, uint256 delivered);
    error Expired(uint256 deadline, uint256 nowTime);
    error IntentNotSignedByPayer(address recovered, address payer);
    error MalleableSignature();
    error BadSignatureV(uint8 v);
    error InsufficientAllowance(uint256 have, uint256 need);
    error TransferFailed();
    error ZeroPayee();

    constructor(address _token) {
        token = IERC20(_token);
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// The slot a payment occupies. Exposed so an offchain caller can ask about
    /// a specific payer's invoice rather than inferring one from the other.
    function settlementKey(bytes32 invoiceId, address payer) public pure returns (bytes32) {
        return keccak256(abi.encode(invoiceId, payer));
    }

    /// Has this payer already settled this invoice? Two different payers holding
    /// the same invoice ID are two different questions, and this answers the one
    /// that was asked.
    function settled(bytes32 invoiceId, address payer) external view returns (bool) {
        return _settled[settlementKey(invoiceId, payer)];
    }

    /**
     * The exact digest a payer must sign. Exposed so the offchain signer can
     * assert its locally built digest matches the chain's rather than
     * discovering a mismatch as an unexplained revert - the same check the
     * probe runs against FXRP's own domain.
     */
    function intentDigest(PaymentIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_INTENT_TYPEHASH,
                intent.invoiceId,
                intent.payer,
                intent.payee,
                intent.amount,
                intent.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /**
     * @param permitSig  EIP-2612 permit, signed by payer over the FXRP domain
     * @param intentSig  PaymentIntent, signed by payer over this contract's domain
     *
     * The intent's one deadline governs both signatures, so they cannot be
     * given divergent lifetimes.
     */
    function settle(
        PaymentIntent calldata intent,
        Signature calldata permitSig,
        Signature calldata intentSig
    ) external {
        if (intent.payee == address(0)) revert ZeroPayee();
        // A zero-amount payment moves nothing and delivers nothing, but it still
        // occupies an invoice and still costs whoever relayed it their gas. That
        // made it a way to spend someone else's relayer on burning invoice IDs
        // for free. Nothing downstream has a use for it either: the middleware
        // only ever quotes a price above zero.
        if (intent.amount == 0) revert ZeroAmount();
        if (block.timestamp > intent.deadline) revert Expired(intent.deadline, block.timestamp);

        bytes32 key = settlementKey(intent.invoiceId, intent.payer);
        if (_settled[key]) revert AlreadySettled(intent.invoiceId);
        _settled[key] = true; // effects before interactions

        // --- the payee binding -------------------------------------------
        // Verified before anything is spent. Every settle() field that a
        // relayer controls is covered by this digest, so a relayer can choose
        // when a payment lands but nothing about what it is.
        address recovered =
            _recover(intentDigest(intent), intentSig.v, intentSig.r, intentSig.s);
        if (recovered != intent.payer) revert IntentNotSignedByPayer(recovered, intent.payer);

        // --- the allowance -------------------------------------------------
        // try/catch is safe now, and it was not before. A front-runner can lift
        // the permit out of the mempool and submit it directly; the nonce is
        // then consumed and a bare permit call here reverts, which would let
        // anyone grief every payment on the rail for the price of gas. Ignoring
        // that revert is only acceptable because the intent above already fixed
        // the destination - a griefer who replays the permit moves the
        // allowance into place and gains nothing from it.
        try IERC20Permit(address(token)).permit(
            intent.payer, address(this), intent.amount, intent.deadline, permitSig.v, permitSig.r, permitSig.s
        ) {} catch {}

        // Whatever happened above, the allowance is what has to be there. Check
        // it explicitly so a missing one reports itself rather than surfacing as
        // an opaque failure inside the token.
        uint256 allowed = token.allowance(intent.payer, address(this));
        if (allowed < intent.amount) revert InsufficientAllowance(allowed, intent.amount);

        // --- delivery --------------------------------------------------------
        // FAssets parameters are asset-manager controlled and may levy a
        // transfer fee. An invoice that silently underpays the payee is a broken
        // payment rail, so measure what actually arrived rather than trusting
        // the transfer amount.
        uint256 balanceBefore = token.balanceOf(intent.payee);
        _safeTransferFrom(intent.payer, intent.payee, intent.amount);
        uint256 delivered = token.balanceOf(intent.payee) - balanceBefore;
        if (delivered < intent.amount) revert Underdelivered(intent.amount, delivered);

        emit PaymentSettled(intent.invoiceId, intent.payer, intent.payee, intent.amount, delivered);
    }

    /// FXRP is a vendored implementation; do not assume it reverts rather than
    /// returning false, and do not assume it returns a value at all.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address) {
        // EIP-2: constrain s to the lower half order. Otherwise every signature
        // has a second equally valid form, and any check keyed on its bytes can
        // be sidestepped by flipping it.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert MalleableSignature();
        }
        if (v != 27 && v != 28) revert BadSignatureV(v);
        address signer = ecrecover(digest, v, r, s);
        // ecrecover reports failure by returning zero rather than reverting.
        if (signer == address(0)) revert IntentNotSignedByPayer(address(0), address(0));
        return signer;
    }
}
