# Runbook: disable, recover or delete an alumni account (`disabled` state)

Owner: infrastructure operator, acting only on a written decision of an authorised board member (Super Admin).
Requirements: PRD 2.2 ("disabled: approved recovery"), F-14 (deletion is always possible), F-17 (audit).

## What `disabled` means

`users.status = disabled` blocks an alumni account completely: no session, no regular API, no socket. Login with the
right password answers `next: account_disabled` without a session, and the app and the web page `/delete-account`
show the help contact. Moderation (suspend) is a different, in-product tool for members: use
`POST /admin/members/{userId}/suspend` for conduct issues. Use `disabled` only for cases such as an account that is
being misused or is under a security investigation.

There is no admin-portal button for this state. Every change goes through the audited CLI `account:status` (worker
environment, connection as `kapdh_worker`). Each run writes one transaction: the status change with the account row
locked, and an audit entry with actor `system`, the reason and the approver.

| Action | Transition | Effects | Audit action |
| --- | --- | --- | --- |
| `disable` | `active` -> `disabled` | session_version +1, all sessions revoked, push tokens revoked, open OTP challenges cancelled, sockets disconnected (`session.revoked`, reason `account_disabled`) | `account.disabled` |
| `enable` | `disabled` -> `active` | The owner signs in again with their own password (approved recovery, PRD 2.2) | `account.enabled` |
| `delete` | `disabled` -> `deletion_pending` | A normal deletion request (source `web`, deadline 7 days, request number `DEL-...`), the `account.deletion` job and the deletion ledger, exactly as F-14 | `account.deletion_requested` and `account.deletion_requested_by_operator` |

The CLI refuses (exit 1, nothing changed) when the email is not an alumni account or the account is not in the
required state (`disable` needs `active`; `enable` and `delete` need `disabled`). Admin identities are managed with
`PATCH /admin/admins/{adminId}` instead.

## Steps

1. **Record the decision.** Open a support ticket. It names the account (email), the action, the reason and the
   board member who approved it. For `enable` and `delete`, verify the owner's identity first: the request must come
   from the account's email address, or the owner proves control of it (for example by replying to a message sent to
   that address).

2. **Run the CLI** from the API image or a checkout with the production worker environment:

   ```sh
   pnpm --filter @kapdh/api account:status -- \
     --action disable \
     --email "member@example.org" \
     --reason "BANTUAN-2026-0042: account reported as misused" \
     --approved-by "Super Admin <name>"
   ```

   Use `--action enable` to recover the account, or `--action delete` to start its deletion. Exit codes: 0 done,
   1 refused or failed (the message says why), 2 wrong arguments. The output shows the account id, the transition and,
   for `delete`, the deletion request number. It never prints the email.

3. **Close the ticket** with the output. For `delete`, give the owner the request number. The deletion job emails the
   confirmation and, when done, the completion notice to the account's address (F-14), and finishes within 7 days.

4. **Check the audit trail** in the admin portal (Audit, filter on entity `user` and the account id): the entry shows
   actor `system`, the reason and `approved_by`.

## Evidence

- `kapdh-platform/apps/api/test/account/account-status.e2e.test.ts` (D1-01): disable revokes sessions and login
  answers `account_disabled`; enable lets the owner sign in again; delete creates a web deletion request and the job
  removes all personal data; refusals; CLI exit codes and output without the email.
- `kapdh-platform/apps/api/test/pg/account-status.pg.test.ts`: the built CLI as `kapdh_worker` on PostgreSQL 17
  (disable, enable, disable, delete; every step audited with role `system`; refusal exits 1 without a change).
