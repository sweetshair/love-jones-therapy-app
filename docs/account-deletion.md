# Account deletion (UAT 64 beta)

Home → Delete Account opens a dedicated confirmation screen. Members enter their current password and type DELETE. Cancel performs no deletion. Unverified email/password accounts can also delete their own account. An active/recent call must end first.

## Deployment gate

Deletion intentionally defaults OFF. Publishing the beta code alone does not authorize destructive cleanup. Before enabling:

1. Publish this commit's complete `firestore.rules` in Firebase → Firestore Database → Rules.
2. Publish this commit's complete `storage.rules` in Firebase → Storage → Rules. Storage cross-service Firestore access must be enabled (the existing block rules already use it).
3. Set `ACCOUNT_DELETION_ENABLED=true` for **Deploy Previews only** in Netlify, available to Functions/runtime, then redeploy PR #5. Do not enable it for production.
4. Confirm the beta shows UAT 64 and `/.netlify/functions/delete-account` returns `{"enabled":true}`. Test only with a disposable account after the emulator checks pass.

These are shared Firebase rules: they preserve ordinary access but deny a member with an `accountDeletions/{uid}` record. Never enable the environment flag before BOTH rules are published. No automatic Firebase rules deployment is configured.

## Data handling

- Server derives the target UID exclusively from a verified Firebase ID token. Password reauthentication must be no older than ten minutes. Client-supplied target IDs are rejected.
- A server-only persistent tombstone immediately prevents stale-session access/recreation and new calls. The profile is hidden in the same transaction.
- Cleanup removes shared matches and their messages/calls/ICE subcollections and cached translations derived from those messages, incoming/outgoing swipes and blocks, own reservations/paid sessions, exact `profilePhotos/{uid}/` objects, private user data/results, public profile and wallet. Shared conversations disappear for both members.
- Authentication is deleted last. Retry resumes incomplete cleanup; parents remain discoverable until their subcollections are deleted. Requests process 20 messages with their translation cache entries, one remaining match, 100 relation records, or 100 photos at a time. The page repeats until done. Large individual conversations may require a retry after a function timeout.
- Payment receipts (`callPurchases`, including processor identifiers) and safety reports are retained. Late Stripe checkout events record a payment receipt with status `paid_account_deleted` and do not restore a wallet; any refund needs separate handling. No refund is performed by deletion.
- A minimal UID/status/timestamp deletion record remains to block stale sessions. It has no client read/write rule.
- Local private draft photos, profile drafts and reconnect data are cleared for the current member on this browser. Reload discards in-memory profile/quiz/media state. Other devices may hold local drafts; members should clear site data there.

## Verification and operational follow-up

Automated tests cover authorization, explicit confirmation, recent authentication, stale-token denial, cleanup retry, subcollection deletion, isolation, and retained records. Storage and Auth deletion are mocked in cleanup integration tests; a disposable-account end-to-end test is still required.

Verify on that account: cancel keeps data; wrong password fails; successful deletion signs out; profile disappears on another account; old password cannot sign in; user/profile/photos/results and shared conversation children are gone. Check no unrelated account was changed. Never delete a real member to test this feature.

If the page/network closes mid-cleanup, sign in with that same account and retry Delete Account. Admins can identify incomplete work by server-only `accountDeletions` status `pending`; never erase a tombstone to restore access. No background retry worker is installed. Review retention periods and deletion/refund wording with qualified counsel before launch.
