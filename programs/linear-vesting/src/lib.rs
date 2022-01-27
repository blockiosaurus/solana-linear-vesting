use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, SetAuthority, TokenAccount, Transfer};
use spl_token::instruction::AuthorityType;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

const VAULT_PDA_SEED: &[u8] = b"token-vault";
const VAULT_AUTHORITY_PDA_SEED: &[u8] = b"vault-authority";

#[error]
pub enum ErrorCode {
    #[msg("Not yet past the cliff!")]
    NotPastCliff,
    #[msg("The vesting account is already empty!")]
    AlreadyEmpty,
    #[msg("Account already revoked!")]
    AlreadyRevoked,
    #[msg("Account is not revocable!")]
    NotRevocable,
    #[msg("Cannot revoke a fully vested account!")]
    FullyVested,
}

#[program]
pub mod linear_vesting {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        amount: u64,
        start_ts: i64,
        cliff_ts: i64,
        duration: i64,
        revocable: bool,
    ) -> ProgramResult {
        ctx.accounts.vesting_account.start_ts = start_ts;
        ctx.accounts.vesting_account.cliff_ts = cliff_ts;
        ctx.accounts.vesting_account.duration = duration;
        ctx.accounts.vesting_account.revocable = revocable;

        ctx.accounts.vesting_account.beneficiary = *ctx.accounts.beneficiary.key;
        ctx.accounts.vesting_account.owner = *ctx.accounts.owner.key;
        ctx.accounts.vesting_account.mint = *ctx.accounts.mint.to_account_info().key;

        ctx.accounts.vesting_account.total_deposited_amount = amount;
        ctx.accounts.vesting_account.released_amount = 0;

        let (vault_authority, _vault_authority_bump) =
            Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], ctx.program_id);

        token::set_authority(
            ctx.accounts.into_set_authority_context(),
            AuthorityType::AccountOwner,
            Some(vault_authority),
        )?;

        token::transfer(
            ctx.accounts.into_transfer_to_pda_context(),
            ctx.accounts.vesting_account.total_deposited_amount,
        )?;

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> ProgramResult {
        let current_time = Clock::get().unwrap().unix_timestamp;
        msg!("Clock time is {}.", current_time);
        // Check if the account is revoked before withdrawing.
        if ctx.accounts.vesting_account.revoked {
            let return_amount = ctx.accounts.vesting_account.total_deposited_amount
                - ctx.accounts.vesting_account.released_amount;
            msg!("Returning full amount.");
            msg!("Withdrawing {} tokens.", return_amount);
            ctx.accounts.vesting_account.released_amount =
                ctx.accounts.vesting_account.total_deposited_amount;

            let (_vault_authority, vault_authority_bump) =
                Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], ctx.program_id);

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_account.to_account_info().clone(),
                to: ctx.accounts.beneficiary_ata.to_account_info().clone(),
                authority: ctx.accounts.vault_authority.clone(),
            };

            let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
            let signer = &[&seeds[..]];

            // The beneficiary is fully vested so return remaining tokens.
            let context = CpiContext::new_with_signer(
                ctx.accounts.token_program.clone(),
                cpi_accounts,
                signer,
            );

            if return_amount > 0 {
                token::transfer(context, return_amount)
            } else {
                Err(ErrorCode::AlreadyEmpty.into())
            }
        }
        // Don't allow withdrawal if we're not past the cliff.
        else if current_time
            < (ctx.accounts.vesting_account.start_ts + ctx.accounts.vesting_account.cliff_ts)
        {
            // We haven't reached the cliff, the user can't withdraw the vested amount.
            msg!("Not yet past the cliff!");
            Err(ErrorCode::NotPastCliff.into())
        }
        // Calculate the amount to withdrawal if we're past the duration.
        else if current_time
            < (ctx.accounts.vesting_account.start_ts + ctx.accounts.vesting_account.duration)
        {
            let vested_return = ctx.accounts.vesting_account.vested_amount(current_time)
                - ctx.accounts.vesting_account.released_amount;
            ctx.accounts.vesting_account.released_amount += vested_return;

            let (_vault_authority, vault_authority_bump) =
                Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], ctx.program_id);

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_account.to_account_info().clone(),
                to: ctx.accounts.beneficiary_ata.to_account_info().clone(),
                authority: ctx.accounts.vault_authority.clone(),
            };

            let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
            let signer = &[&seeds[..]];
            let context = CpiContext::new_with_signer(
                ctx.accounts.token_program.clone(),
                cpi_accounts,
                signer,
            );

            msg!("Withdrawing {} tokens.", vested_return);
            token::transfer(context, vested_return)
        }
        // If we're past the duration return any unreleased tokens.
        else {
            let (_vault_authority, vault_authority_bump) =
                Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], ctx.program_id);

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_account.to_account_info().clone(),
                to: ctx.accounts.beneficiary_ata.to_account_info().clone(),
                authority: ctx.accounts.vault_authority.clone(),
            };

            let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
            let signer = &[&seeds[..]];

            // The beneficiary is fully vested so return remaining tokens.
            let context = CpiContext::new_with_signer(
                ctx.accounts.token_program.clone(),
                cpi_accounts,
                signer,
            );

            let return_amount = ctx.accounts.vesting_account.total_deposited_amount
                - ctx.accounts.vesting_account.released_amount;
            msg!("Returning full amount.");
            msg!("Withdrawing {} tokens.", return_amount);
            ctx.accounts.vesting_account.released_amount =
                ctx.accounts.vesting_account.total_deposited_amount;

            if return_amount > 0 {
                token::transfer(context, return_amount)
            } else {
                Err(ErrorCode::AlreadyEmpty.into())
            }
        }
    }

    pub fn revoke(ctx: Context<Revoke>) -> ProgramResult {
        let current_time = Clock::get().unwrap().unix_timestamp;
        msg!("Clock time is {}.", current_time);
        // Make sure it's a revocable account first.
        if ctx.accounts.vesting_account.revocable {
            // Check that the account hasn't already been revoked.
            if ctx.accounts.vesting_account.revoked {
                Err(ErrorCode::AlreadyRevoked.into())
            }
            // Otherwise return any unvested tokens if we're not past the duration.
            else if current_time
                < (ctx.accounts.vesting_account.start_ts + ctx.accounts.vesting_account.duration)
            {
                msg!("Clock time is {}.", current_time);
                let revoke_return = ctx.accounts.vesting_account.total_deposited_amount
                    - ctx.accounts.vesting_account.vested_amount(current_time);

                ctx.accounts.vesting_account.revoked = true;

                let (_vault_authority, vault_authority_bump) =
                    Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], ctx.program_id);

                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault_account.to_account_info().clone(),
                    to: ctx.accounts.owner_token_account.to_account_info().clone(),
                    authority: ctx.accounts.vault_authority.clone(),
                };

                let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
                let signer = &[&seeds[..]];
                let context = CpiContext::new_with_signer(
                    ctx.accounts.token_program.clone(),
                    cpi_accounts,
                    signer,
                );

                msg!("Revoking {} tokens.", revoke_return);
                ctx.accounts.vesting_account.released_amount += revoke_return;
                if revoke_return > 0 {
                    token::transfer(context, revoke_return)
                } else {
                    Err(ErrorCode::AlreadyEmpty.into())
                }
            }
            // If the user is fully vested then there's nothing to revoke.
            else {
                Err(ErrorCode::FullyVested.into())
            }
        } else {
            Err(ErrorCode::NotRevocable.into())
        }
    }
}

#[derive(Accounts)]
#[instruction(amount: u64,
  start_ts: i64,
  cliff_ts: i64,
  duration: i64,
  revocable: bool)]
pub struct Initialize<'info> {
    #[account(mut, signer)]
    pub owner: AccountInfo<'info>,
    pub beneficiary: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub beneficiary_ata: Account<'info, TokenAccount>,
    #[account(
        init,
        seeds = [VAULT_PDA_SEED, &beneficiary_ata.to_account_info().key.to_bytes()], bump,
        payer = owner,
        token::mint = mint,
        token::authority = owner,
    )]
    pub vault_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_token_account.amount >= amount
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        seeds = [&beneficiary_ata.to_account_info().key.to_bytes()],
        bump,
        payer = owner,
        space = 8 * 19
    )]
    pub vesting_account: Account<'info, VestingAccount>,
    pub system_program: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(signer)]
    pub beneficiary: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub beneficiary_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vesting_account: Account<'info, VestingAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(signer)]
    pub owner: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vesting_account: Account<'info, VestingAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[account]
pub struct VestingAccount {
    /// The investor who will received vested tokens
    pub beneficiary: Pubkey,
    /// The timestamp for when the lock ends and vesting begins
    pub start_ts: i64,
    /// The timestamp for when the cliff ends (vesting happens during cliff!)
    pub cliff_ts: i64,
    /// The duration of the vesting period
    pub duration: i64,
    /// Whether this vesting account is revocable
    pub revocable: bool,
    /// Owner that can revoke the account
    pub owner: Pubkey,
    /// The mint of the SPL token locked up.
    pub mint: Pubkey,
    /// Total amount to be vested
    pub total_deposited_amount: u64,
    /// Amount that has been released
    pub released_amount: u64,
    /// Whether or not the contract has been revoked
    pub revoked: bool,
}

impl VestingAccount {
    fn vested_amount(&self, current_time: i64) -> u64 {
        // Return the current amount vested.
        // We vest during the cliff so use the start_ts rather than the cliff_ts as the start.
        let multiplier = (current_time - self.start_ts) as f64 / self.duration as f64;
        return ((self.total_deposited_amount as f64) * multiplier) as u64;
    }
}

impl<'info> Initialize<'info> {
    fn into_transfer_to_pda_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.owner_token_account.to_account_info().clone(),
            to: self.vault_account.to_account_info().clone(),
            authority: self.owner.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_set_authority_context(&self) -> CpiContext<'_, '_, '_, 'info, SetAuthority<'info>> {
        let cpi_accounts = SetAuthority {
            account_or_mint: self.vault_account.to_account_info().clone(),
            current_authority: self.owner.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

// TODO: Figure out the signer lifetime so we can reduce duplicated code.
impl<'info> Withdraw<'info> {
    //     fn withdraw_to_beneficiary_context(
    //         &self,
    //         program_id: &Pubkey,
    //     ) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
    //         let (_vault_authority, vault_authority_bump) =
    //             Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], program_id);

    //         let cpi_accounts = Transfer {
    //             from: self.vault_account.to_account_info().clone(),
    //             to: self.beneficiary_ata.to_account_info().clone(),
    //             authority: self.vault_authority.clone(),
    //         };

    //         let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
    //         let signer = &[&seeds[..]];
    //         //CpiContext::new_with_signer(self.token_program.clone(), cpi_accounts, signer)
    //     }
}

// TODO: Figure out the signer lifetime so we can reduce duplicated code.
impl<'info> Revoke<'info> {
    // fn revoke_to_owner_context(
    //     &self,
    //     program_id: &Pubkey,
    // ) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
    //     let (_vault_authority, vault_authority_bump) =
    //         Pubkey::find_program_address(&[VAULT_AUTHORITY_PDA_SEED], program_id);

    //     let cpi_accounts = Transfer {
    //         from: self.vault_account.to_account_info().clone(),
    //         to: self.owner_token_account.to_account_info().clone(),
    //         authority: self.vault_authority.clone(),
    //     };

    //     let seeds = &[VAULT_AUTHORITY_PDA_SEED, &[vault_authority_bump]];
    //     let signer = &[&seeds[..]];
    //     //CpiContext::new_with_signer(self.token_program.clone(), cpi_accounts, signer)
    // }
}
