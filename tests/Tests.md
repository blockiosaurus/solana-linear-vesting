# Withdrawal
## User
* As the beneficiary I should be able to withdraw all vested tokens.
* As the beneficiary I should be able to get the same amount of tokens regardless of whether I withdraw in increments or all at once.
* As the beneficiary I should not be able to withdraw before the cliff has been reached.
* As the beneficiary I should not be able to withdraw any more than the vested amount.
## Security
* As a third party I should not be able to withdraw any amount.

# Revoke
## Owner
* As the owner I should be able to revoke and receive all unvested tokens.
* As the owner I should receive no return if revoking after the vestment period is over.
* As the beneficiary I should not be able to receive any more than the vested amount when the treasury is revoked.
* As the owner I should be able to receive the full amount before the cliff is reached.
* As the owner I should not be able to revoke at all if revoke is set to false.
* As the owner I should not be able to revoke twice.
## Security
* As a third party I should not be able to invoke the revoke functionality.