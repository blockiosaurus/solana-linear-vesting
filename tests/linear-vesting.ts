import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { LinearVesting } from '../target/types/linear_vesting';

import {
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
  Commitment,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, Token } from '@solana/spl-token';
import { assert, expect } from 'chai';
import NodeWallet from '@project-serum/anchor/dist/cjs/nodewallet';

const SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID: PublicKey = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

async function findAssociatedTokenAddress(
  walletAddress: PublicKey,
  tokenMintAddress: PublicKey
): Promise<PublicKey> {
  return (
    await PublicKey.findProgramAddress(
      [
        walletAddress.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        tokenMintAddress.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
    )
  )[0];
}

// Adding a sleep function for time-based delays. I'm sure there's a way to mock the Clock in Rust
// but I'm not aware of how to do it.
async function sleepSeconds(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

// Await a specific timestamp so we can get exact time offsets for the linear vesting tests.
function awaitTimestamp(timestamp) {
  while ((Date.now() / 1000) < timestamp);
}

describe('linear-vesting', () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LinearVesting as Program<LinearVesting>;

  let mint = null as Token;
  let ownerTokenAccount = null;

  const amount = 1000000 * 10 ** 9;

  const owner = (provider.wallet as NodeWallet).payer;
  const beneficiary = anchor.web3.Keypair.generate();
  const mintAuthority = owner;

  it('Initialize vesting account', async () => {

    const startTs = new anchor.BN(Date.now() / 1000);
    const cliffTs = new anchor.BN(0);
    const duration = new anchor.BN(100);
    const revocable = true;

    let { mint, ownerTokenAccount, beneficiaryTokenAccount, vaultAccount, vestingAccount, vaultAuthority } =
      await setupVestingAccount(startTs, cliffTs, duration, revocable);

    let _vestingAccount = await program.account.vestingAccount.fetch(
      vestingAccount
    );

    let _vault = await mint.getAccountInfo(vaultAccount);
    let _owner = await mint.getAccountInfo(ownerTokenAccount.address);

    // check token has been transferred to vault
    assert.ok(_vault.amount.toNumber() == amount);
    assert.ok(_owner.amount.toNumber() === 0);

    // check that the vault's authority is the program
    assert.ok(vaultAuthority.equals(_vault.owner));

    // check the vesting account has the correct data
    assert.ok(_vestingAccount.totalDepositedAmount.toNumber() === amount);
    assert.ok(_vestingAccount.releasedAmount.toNumber() === 0);
    assert.ok(_vestingAccount.startTs.eq(startTs));
    assert.ok(_vestingAccount.cliffTs.eq(cliffTs));
    assert.ok(_vestingAccount.duration.eq(duration));
    assert.ok(_vestingAccount.revocable);
    assert.ok(_vestingAccount.beneficiary.equals(beneficiary.publicKey));
    assert.ok(_vestingAccount.owner.equals(owner.publicKey));
    assert.ok(_vestingAccount.mint.equals(mint.publicKey));
  });

  it("Withdraw all at once", async () => {
    const startTs = new anchor.BN(Date.now() / 1000);
    const cliffTs = new anchor.BN(0);
    const duration = new anchor.BN(100);
    const revocable = true;

    let { beneficiaryTokenAccount, vaultAccount, vestingAccount, vaultAuthority } =
      await setupVestingAccount(startTs, cliffTs, duration, revocable);

    // Wait for the full duration (in seconds) to pass.
    await sleepSeconds(duration);
    await program.rpc.withdraw({
      accounts: {
        beneficiary: beneficiary.publicKey,
        mint: mint.publicKey,
        beneficiaryAta: beneficiaryTokenAccount.address,
        vaultAccount: vaultAccount,
        vestingAccount: vestingAccount,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [beneficiary],
    });

    let _vestingAccount = await program.account.vestingAccount.fetch(
      vestingAccount
    );

    // Check that beneficiary has received all their promised tokens.
    assert.ok(
      (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() === amount,
      "The beneficiary has not received all of the tokens."
    );
    // Check that the released amount corresponds to the full amount.
    assert.ok(
      _vestingAccount.releasedAmount.toNumber() === amount,
      "Not all funds have been released at completion."
    );
    // Check that the total deposited amount, released amount, and beneficiary balance all match.
    // This is probably redundant after the previous two checks, but it makes me feel better.
    assert.ok(
      _vestingAccount.totalDepositedAmount.toNumber() === _vestingAccount.releasedAmount.toNumber() &&
      _vestingAccount.totalDepositedAmount.toNumber() === (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber(),
      "There's a conflict between the total deposited amount and amount released to beneficiaries."
    );
  });

  it("Withdraw each second and attempt to overdraw", async () => {
    const startTs = new anchor.BN(Date.now() / 1000);
    const cliffTs = new anchor.BN(0);
    const duration = new anchor.BN(100);
    const revocable = true;

    let { beneficiaryTokenAccount, vaultAccount, vestingAccount, vaultAuthority } =
      await setupVestingAccount(startTs, cliffTs, duration, revocable);

    for (let i = 0; i <= (101); i += 1) {
      // Using sleepSeconds causes drift because of the time taken to fetch data from the chain
      // extending loop iterations.
      awaitTimestamp(startTs.toNumber() + i);
      await program.rpc.withdraw({
        accounts: {
          beneficiary: beneficiary.publicKey,
          mint: mint.publicKey,
          beneficiaryAta: beneficiaryTokenAccount.address,
          vaultAccount: vaultAccount,
          vestingAccount: vestingAccount,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [beneficiary],
      });

      let _vestingAccount = await program.account.vestingAccount.fetch(
        vestingAccount
      );

      //const expectedReturn = i * (amount / duration.toNumber());
      const expectedReturnMin = (i - 2) * (amount / duration.toNumber());
      const expectedReturnMax = (i + 2) * (amount / duration.toNumber());
      // NOTE: We're going to do some fuzzy matching here for two reasons:
      // 1. Execution time is non-deterministic so it's not guaranteed the exact time-offset we'll be withdrawing at.
      // 2. Solana's Clock sysvar is set at the beginning of each slot and each slot is at least 400ms which doesn't divide
      //  evenly into one second, so we can't guarantee that the expected value matches up with the test code timestamp.
      // Check that beneficiary has received all vested tokens at this time.
      assert.ok(
        (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() >= expectedReturnMin &&
        (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() <= expectedReturnMax,
        "The beneficiary has not received all of the vested tokens."
      );
      // Check that the released amount corresponds to the expected return.
      assert.ok(
        _vestingAccount.releasedAmount.toNumber() >= expectedReturnMin &&
        _vestingAccount.releasedAmount.toNumber() <= expectedReturnMax,
        "Not all vested funds have been released."
      );
    }

    // Verify that the account is fully drained.
    let _vestingAccount = await program.account.vestingAccount.fetch(
      vestingAccount
    );
    // Check that beneficiary has received all their promised tokens.
    assert.ok(
      (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() === amount,
      "The beneficiary has not received all of the tokens."
    );
    // Check that the released amount corresponds to the full amount.
    assert.ok(
      _vestingAccount.releasedAmount.toNumber() === amount,
      "Not all funds have been released at completion."
    );
    // Check that the total deposited amount, released amount, and beneficiary balance all match.
    // This is probably redundant after the previous two checks, but it makes me feel better.
    assert.ok(
      _vestingAccount.totalDepositedAmount.toNumber() === _vestingAccount.releasedAmount.toNumber() &&
      _vestingAccount.totalDepositedAmount.toNumber() === (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber(),
      "There's a conflict between the total deposited amount and amount released to beneficiaries."
    );

    try {
      // Attempt to withdraw again to verify you can't overdraw without getting an error.
      await program.rpc.withdraw({
        accounts: {
          beneficiary: beneficiary.publicKey,
          mint: mint.publicKey,
          beneficiaryAta: beneficiaryTokenAccount.address,
          vaultAccount: vaultAccount,
          vestingAccount: vestingAccount,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [beneficiary],
      });
      assert.ok(false, "Withdrawal should fail when the vesting account has already been emptied!");
    }
    catch (err) {
      assert.ok(err.msg === "The vesting account is already empty!",
        "The vesting account should not try to transfer once it's already empty.");
    }
  });

  it("Withdraw before the cliff and third party withdraw", async () => {
    const startTs = new anchor.BN(Date.now() / 1000);
    const cliffTs = new anchor.BN(100);
    const duration = new anchor.BN(100);
    const revocable = true;

    let { beneficiaryTokenAccount, vaultAccount, vestingAccount, vaultAuthority } =
      await setupVestingAccount(startTs, cliffTs, duration, revocable);

    try {
      await program.rpc.withdraw({
        accounts: {
          beneficiary: beneficiary.publicKey,
          mint: mint.publicKey,
          beneficiaryAta: beneficiaryTokenAccount.address,
          vaultAccount: vaultAccount,
          vestingAccount: vestingAccount,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [beneficiary],
      });
      assert.ok(false, "Withdrawal should fail when we're not past the cliff!");
    }
    catch (err) {
      assert.ok(err.msg === "Not yet past the cliff!",
        "Withdrawal should fail when we're not past the cliff!");
    }

    try {
      // Wait for the full duration (in seconds) to pass.
      await sleepSeconds(duration);
      await program.rpc.withdraw({
        accounts: {
          beneficiary: beneficiary.publicKey,
          mint: mint.publicKey,
          beneficiaryAta: beneficiaryTokenAccount.address,
          vaultAccount: vaultAccount,
          vestingAccount: vestingAccount,
          vaultAuthority: vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [anchor.web3.Keypair.generate()],
      });
      assert.ok(false, "A third party should not be able to withdraw any tokens");
    }
    catch (err) {
      console.log(err);
      assert.ok(err.message.indexOf("unknown signer") !== -1,
        "A third party should not be able to withdraw any tokens");
    }

    let _vestingAccount = await program.account.vestingAccount.fetch(
      vestingAccount
    );

    // Check that beneficiary hasn't received any tokens.
    assert.ok(
      (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() === 0,
      "The beneficiary should not have received any tokens."
    );
    // Check that the released amount is still zero.
    assert.ok(
      _vestingAccount.releasedAmount.toNumber() === 0,
      "No funds should have been released."
    );

    await program.rpc.withdraw({
      accounts: {
        beneficiary: beneficiary.publicKey,
        mint: mint.publicKey,
        beneficiaryAta: beneficiaryTokenAccount.address,
        vaultAccount: vaultAccount,
        vestingAccount: vestingAccount,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [beneficiary],
    });

    _vestingAccount = await program.account.vestingAccount.fetch(
      vestingAccount
    );

    // Check that beneficiary has received all their promised tokens.
    console.log((await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber());
    assert.ok(
      (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber() === amount,
      "The beneficiary has not received all of the tokens."
    );
    // Check that the released amount corresponds to the full amount.
    assert.ok(
      _vestingAccount.releasedAmount.toNumber() === amount,
      "Not all funds have been released at completion."
    );
    // Check that the total deposited amount, released amount, and beneficiary balance all match.
    // This is probably redundant after the previous two checks, but it makes me feel better.
    assert.ok(
      _vestingAccount.totalDepositedAmount.toNumber() === _vestingAccount.releasedAmount.toNumber() &&
      _vestingAccount.totalDepositedAmount.toNumber() === (await mint.getAccountInfo(beneficiaryTokenAccount.address)).amount.toNumber(),
      "There's a conflict between the total deposited amount and amount released to beneficiaries."
    );
  });

  async function setupVestingAccount(
    startTs: anchor.BN,
    cliffTs: anchor.BN,
    duration: anchor.BN,
    revocable: boolean
  ) {
    mint = await Token.createMint(
      provider.connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      9,
      TOKEN_PROGRAM_ID
    );

    ownerTokenAccount = await mint.getOrCreateAssociatedAccountInfo(
      owner.publicKey
    );

    await mint.mintTo(
      ownerTokenAccount.address,
      mintAuthority.publicKey,
      [mintAuthority],
      amount
    );

    let beneficiaryTokenAccount = await mint.getOrCreateAssociatedAccountInfo(
      beneficiary.publicKey
    );

    let vaultAccount = (await PublicKey.findProgramAddress(
      [
        Buffer.from(anchor.utils.bytes.utf8.encode('token-vault')),
        beneficiaryTokenAccount.address.toBuffer(),
      ],

      program.programId
    ))[0];

    let vaultAuthority = (await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode('vault-authority'))],
      program.programId
    ))[0];

    let vestingAccount = (await PublicKey.findProgramAddress(
      [beneficiaryTokenAccount.address.toBuffer()],
      program.programId
    ))[0];

    await program.rpc.initialize(
      new anchor.BN(amount),
      startTs,
      cliffTs,
      duration,
      revocable,
      {
        accounts: {
          owner: owner.publicKey,
          beneficiary: beneficiary.publicKey,
          mint: mint.publicKey,
          beneficiaryAta: beneficiaryTokenAccount.address,
          vaultAccount: vaultAccount,
          ownerTokenAccount: ownerTokenAccount.address,
          vestingAccount: vestingAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [owner],
      }
    );

    return { mint, ownerTokenAccount, beneficiaryTokenAccount, vaultAccount, vestingAccount, vaultAuthority };
  }
});
