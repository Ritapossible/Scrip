// Exercise settle() end to end against a fork of live Coston2, using the real
// FXRP contract and real signatures. Proves five things:
//   1. a payer holding ZERO gas token can pay
//   2. the permit + intent pair verifies against FXRP's vendored implementation
//   3. a relayer cannot redirect the payment to itself
//   4. the same invoice cannot be settled twice
//   5. a front-runner who replays the permit cannot grief the payment
//
//   anvil --fork-url https://coston2-api.flare.network/ext/C/rpc --port 8546
//   forge build && npm run test:fork
//
// Everything here runs against a local fork. It never touches a funded key.
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, keccak256, pad, toHex,
  encodeAbiParameters, decodeEventLog, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'http://127.0.0.1:8546';
const CHAIN_ID = 114;

// Resolved, not hardcoded - same path probe.ts takes, so a redeployed FXRP
// does not silently make this test pass against a dead address.
const ASSET_MANAGER_FXRP = '0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA';

// FXRP keeps balances in a plain mapping at slot 0, behind an EIP-1967 proxy.
// Found by probing, not assumed - see the sentinel check below, which fails
// loudly if a redeployed FXRP ever moves it.
const FXRP_BALANCE_SLOT = 0n;

// anvil's default accounts. These keys are published in anvil's own startup
// output and are the same for every install - they are not secrets, and they
// control nothing outside a local fork.
const payer   = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const relayer = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
// anvil #4. Must NOT be the payee - if the thief and payee are the same address
// the "attack" is just a valid payment and the test proves nothing.
const thief   = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const PAYEE   = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'; // anvil #3

const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const chain = { id: CHAIN_ID, name: 'coston2-fork', nativeCurrency: { name: 'C2FLR', symbol: 'C2FLR', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const relayerWallet  = createWalletClient({ account: relayer,  chain, transport: http(RPC, { timeout: 60_000 }) });
const thiefWallet    = createWalletClient({ account: thief,    chain, transport: http(RPC, { timeout: 60_000 }) });
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC, { timeout: 60_000 }) });

await pub.getBlockNumber().catch(() => {
  console.error(`No fork reachable at ${RPC}. Start one with:\n` +
    '  anvil --fork-url https://coston2-api.flare.network/ext/C/rpc --port 8546');
  process.exit(1);
});

const FXRP = await pub.readContract({
  address: ASSET_MANAGER_FXRP,
  abi: parseAbi(['function fAsset() view returns (address)']),
  functionName: 'fAsset',
});
console.log(`FXRP resolved from AssetManagerFXRP: ${FXRP}\n`);

const rpc = (method, params) => fetch(RPC, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then(r => r.json());

const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
]);

const facAbi = parseAbi([
  'struct PaymentIntent { bytes32 invoiceId; address payer; address payee; uint256 amount; uint256 deadline; }',
  'struct Signature { uint8 v; bytes32 r; bytes32 s; }',
  'function settle(PaymentIntent intent, Signature permitSig, Signature intentSig)',
  'function settled(bytes32 invoiceId, address payer) view returns (bool)',
  'function settlementKey(bytes32 invoiceId, address payer) pure returns (bytes32)',
  'event PaymentSettled(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 requested, uint256 delivered)',
  // Without these viem cannot decode a revert and every failure looks identical.
  'error AlreadySettled(bytes32 invoiceId)',
  'error Underdelivered(uint256 requested, uint256 delivered)',
  'error Expired(uint256 deadline, uint256 nowTime)',
  'error IntentNotSignedByPayer(address recovered, address payer)',
  'error MalleableSignature()',
  'error BadSignatureV(uint8 v)',
  'error InsufficientAllowance(uint256 have, uint256 need)',
  'error TransferFailed()',
  'error ZeroPayee()',
  'error ZeroAmount()',
]);

const split = (sig) => ({
  r: sig.slice(0, 66),
  s: '0x' + sig.slice(66, 130),
  v: parseInt(sig.slice(130, 132), 16),
});

const ok = (cond, msg) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!cond) process.exitCode = 1;
};

// --- deploy onto the fork --------------------------------------------------
const artifactPath = new URL('../out/ScripFacilitator.sol/ScripFacilitator.json', import.meta.url);
let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch {
  console.error('No build artifact. Run `forge build` first.');
  process.exit(1);
}
const deployHash = await deployerWallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [FXRP],
});
const { contractAddress: FACILITATOR } = await pub.waitForTransactionReceipt({ hash: deployHash });
console.log(`facilitator deployed to fork at ${FACILITATOR}\n`);

// --- arrange -------------------------------------------------------------
const decimals = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'decimals' });
const AMOUNT = 1_500_000n;               // 1.5 FXRP at 6 decimals
const FUND   = 10_000_000n;              // 10 FXRP

// Give the payer FXRP by writing the balances mapping directly. Minting FAssets
// legitimately needs an XRP payment proof, which is not something a test can
// produce - so the funding is synthetic even though the token is not.
const balSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [payer.address, FXRP_BALANCE_SLOT]));
await rpc('anvil_setStorageAt', [FXRP, balSlot, pad(toHex(FUND), { size: 32 })]);

// The whole premise: the payer holds no gas token at all.
await rpc('anvil_setBalance', [payer.address, '0x0']);

const payerNativeBefore = await pub.getBalance({ address: payer.address });
const payerFxrpBefore   = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [payer.address] });
const payeeFxrpBefore   = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [PAYEE] });

if (thief.address.toLowerCase() === PAYEE.toLowerCase()) {
  throw new Error('thief === payee; the substitution test would be vacuous');
}
if (payerFxrpBefore !== FUND) {
  console.error(`Funding the payer failed: balanceOf reports ${payerFxrpBefore}, expected ${FUND}.\n` +
    `FXRP's balance mapping is probably no longer at slot ${FXRP_BALANCE_SLOT}.`);
  process.exit(1);
}

console.log('setup');
console.log(`  FXRP decimals      ${decimals}`);
console.log(`  payee              ${PAYEE}`);
console.log(`  thief              ${thief.address}`);
console.log(`  payer FXRP         ${payerFxrpBefore}`);
console.log(`  payer native       ${payerNativeBefore}  <- must be 0`);
console.log(`  invoice amount     ${AMOUNT}`);

// --- sign (offchain, no gas, no transaction) -----------------------------
const domainRaw = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'eip712Domain' });
const tokenDomain = { name: domainRaw[1], version: domainRaw[2], chainId: Number(domainRaw[3]), verifyingContract: domainRaw[4] };
const nonce = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'nonces', args: [payer.address] });
const block = await pub.getBlock();
const deadline = block.timestamp + 3600n;
// Unique per run: a fixed ID makes the second run collide with the first and
// report AlreadySettled, which looks like a failure of settle() rather than of
// the test.
const invoiceId = keccak256(toHex(`invoice-scrip-${Date.now()}-${Math.random()}`));

console.log('\nsigning');
console.log(`  token domain       ${JSON.stringify(tokenDomain)}`);
console.log(`  payer nonce        ${nonce}`);

const permitSig = split(await payer.signTypedData({
  domain: tokenDomain,
  types: { Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { owner: payer.address, spender: FACILITATOR, value: AMOUNT, nonce, deadline },
}));

const intent = { invoiceId, payer: payer.address, payee: PAYEE, amount: AMOUNT, deadline };
const intentTypes = { PaymentIntent: [
  { name: 'invoiceId', type: 'bytes32' }, { name: 'payer', type: 'address' },
  { name: 'payee', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }] };
const intentDomain = { name: 'Scrip', version: '1', chainId: CHAIN_ID, verifyingContract: FACILITATOR };

const intentSig = split(await payer.signTypedData({
  domain: intentDomain, types: intentTypes, primaryType: 'PaymentIntent', message: intent,
}));
console.log(`  permit v           ${permitSig.v}`);
console.log(`  intent v           ${intentSig.v}`);

// --- attack: relayer redirects the payment to itself ---------------------
console.log('\nattack: relayer substitutes itself as payee');
try {
  await thiefWallet.writeContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settle',
    args: [{ ...intent, payee: thief.address }, permitSig, intentSig],
  });
  ok(false, 'payee substitution was REJECTED');
} catch (e) {
  const reverted = /IntentNotSignedByPayer/.test(e.message || '');
  ok(reverted, `payee substitution rejected with IntentNotSignedByPayer`);
  if (!reverted) console.log('    unexpected:', (e.message || '').split('\n')[0]);
}

// --- act: the relayer settles honestly ------------------------------------
console.log('\nsettle');
const hash = await relayerWallet.writeContract({
  address: FACILITATOR, abi: facAbi, functionName: 'settle', args: [intent, permitSig, intentSig],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`  status             ${receipt.status}`);
console.log(`  gas used           ${receipt.gasUsed}`);
console.log(`  gas paid by        ${receipt.from}`);

const log = receipt.logs
  .filter(l => l.address.toLowerCase() === FACILITATOR.toLowerCase())
  .map(l => decodeEventLog({ abi: facAbi, data: l.data, topics: l.topics }))[0];

// --- assert ----------------------------------------------------------------
const payerNativeAfter = await pub.getBalance({ address: payer.address });
const payerFxrpAfter   = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [payer.address] });
const payeeFxrpAfter   = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [PAYEE] });

console.log('\nassertions');
ok(receipt.status === 'success', 'settle() succeeded');
ok(log?.eventName === 'PaymentSettled', 'PaymentSettled emitted');
ok(log?.args.delivered === AMOUNT, `delivered == requested (${log?.args.delivered} == ${AMOUNT})`);
ok(log?.args.payee.toLowerCase() === PAYEE.toLowerCase(), 'payee is the signed payee');
ok(payeeFxrpAfter - payeeFxrpBefore === AMOUNT, `payee received ${payeeFxrpAfter - payeeFxrpBefore}`);
ok(payerFxrpBefore - payerFxrpAfter === AMOUNT, `payer debited ${payerFxrpBefore - payerFxrpAfter}`);
ok(payerNativeAfter === 0n, `payer native balance still 0 - the payment was gasless`);
ok(receipt.from.toLowerCase() === relayer.address.toLowerCase(), 'relayer paid the gas');

// --- replay ---------------------------------------------------------------
console.log('\nreplay: same invoice again');
try {
  await relayerWallet.writeContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settle', args: [intent, permitSig, intentSig],
  });
  ok(false, 'replay was rejected');
} catch (e) {
  ok(/AlreadySettled/.test(e.message || ''), 'replay rejected with AlreadySettled');
}

// --- invoice burn ----------------------------------------------------------
// `settled` is keyed on (invoiceId, payer), not on the invoice alone. Invoice
// ids travel the x402 HTTP path in the clear, so keyed on the invoice by itself
// anyone who saw one could settle their own payment against it first and burn it
// for the payer it was issued to.
//
// The invoice above is settled, for `payer`. What matters is that it is settled
// *only* for them: the same id in anyone else's hands is a different slot, still
// open. That is the whole property - had the stranger gone first, the payer's
// slot would have been the one still open, and the quote would still have been
// payable.
console.log('\nburn: the same invoice id in another payer\'s hands');
ok(
  (await pub.readContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settled', args: [invoiceId, payer.address],
  })) === true,
  'the invoice is settled for the payer who signed it',
);
ok(
  (await pub.readContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settled', args: [invoiceId, thief.address],
  })) === false,
  'the same invoice id is untouched for anyone else - the burn is closed',
);
ok(
  (await pub.readContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settlementKey', args: [invoiceId, payer.address],
  })) !== (await pub.readContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settlementKey', args: [invoiceId, thief.address],
  })),
  'and the two settle under different keys, by construction',
);

// --- zero amount -----------------------------------------------------------
// A zero-amount payment moves nothing and delivers nothing, but still occupies
// an invoice and still costs whoever relayed it their gas.
console.log('\nzero amount: a payment that moves nothing');
const zeroInvoice = keccak256(toHex(`invoice-zero-${Date.now()}-${Math.random()}`));
const zeroBlock = await pub.getBlock();
const zeroDeadline = zeroBlock.timestamp + 3600n;
const zeroIntent = { invoiceId: zeroInvoice, payer: payer.address, payee: PAYEE, amount: 0n, deadline: zeroDeadline };
const zeroIntentSig = split(await payer.signTypedData({
  domain: intentDomain, types: intentTypes, primaryType: 'PaymentIntent', message: zeroIntent,
}));
try {
  await relayerWallet.writeContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settle',
    // The permit is irrelevant: the amount is rejected before it is reached.
    args: [zeroIntent, { v: 27, r: pad('0x0', { size: 32 }), s: pad('0x0', { size: 32 }) }, zeroIntentSig],
  });
  ok(false, 'zero-amount settlement was rejected');
} catch (e) {
  ok(/ZeroAmount/.test(e.message || ''), 'zero-amount settlement rejected with ZeroAmount');
}

// --- front-runner grief ----------------------------------------------------
// The reason permit is wrapped in try/catch. A front-runner lifts the permit
// out of the mempool and submits it straight to FXRP, consuming the nonce. A
// bare permit call inside settle() would then revert and the payment would be
// dead. It must still settle.
console.log('\nfront-runner replays the permit directly to FXRP');
const permitAbi = parseAbi(['function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']);
const inv2 = keccak256(toHex(`invoice-frontrun-${Date.now()}-${Math.random()}`));
const nonce2 = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'nonces', args: [payer.address] });
const block2 = await pub.getBlock();
const deadline2 = block2.timestamp + 3600n;

const permitSig2 = split(await payer.signTypedData({
  domain: tokenDomain,
  types: { Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { owner: payer.address, spender: FACILITATOR, value: AMOUNT, nonce: nonce2, deadline: deadline2 },
}));
const intent2 = { invoiceId: inv2, payer: payer.address, payee: PAYEE, amount: AMOUNT, deadline: deadline2 };
const intentSig2 = split(await payer.signTypedData({
  domain: intentDomain, types: intentTypes, primaryType: 'PaymentIntent', message: intent2,
}));

// The griefer burns the nonce.
const frontrunHash = await thiefWallet.writeContract({
  address: FXRP, abi: permitAbi, functionName: 'permit',
  args: [payer.address, FACILITATOR, AMOUNT, deadline2, permitSig2.v, permitSig2.r, permitSig2.s],
});
await pub.waitForTransactionReceipt({ hash: frontrunHash });
const nonceAfter = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'nonces', args: [payer.address] });
ok(nonceAfter === nonce2 + 1n, `front-runner consumed the nonce (${nonce2} -> ${nonceAfter})`);

const payeeBefore2 = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [PAYEE] });
try {
  const h2 = await relayerWallet.writeContract({
    address: FACILITATOR, abi: facAbi, functionName: 'settle', args: [intent2, permitSig2, intentSig2],
  });
  const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
  const payeeAfter2 = await pub.readContract({ address: FXRP, abi: tokenAbi, functionName: 'balanceOf', args: [PAYEE] });
  ok(r2.status === 'success', 'settle() still succeeded after the permit was front-run');
  ok(payeeAfter2 - payeeBefore2 === AMOUNT, `payee still received ${payeeAfter2 - payeeBefore2}`);
} catch (e) {
  ok(false, `settle() was griefed: ${(e.message || '').split('\n')[0]}`);
}

console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
