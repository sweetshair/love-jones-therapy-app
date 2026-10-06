# Beta member report administration

The Member Reports page is `/moderation.html`. It uses a verified Firebase ID token and the server's exact `MODERATOR_UIDS` allowlist. Browser flags and email strings cannot grant access. With no configured UIDs, nobody can read reports. Reports and audit entries remain inaccessible through client Firestore APIs.

## Activation

1. Obtain the owner's current account UID from Firebase Authentication. Verify the account belongs to the owner; never reuse a deleted test account's UID or infer ownership from a screenshot.
2. Set `MODERATOR_UIDS` to that UID in Netlify's **Deploy Previews** environment only. Multiple explicitly approved administrators may be comma-separated. Redeploy the beta. Sign in as the configured owner and open **Member Reports** on Home.
3. Publish this commit's complete `firestore.rules` and `storage.rules` through Firebase. Rules affect the shared Firebase project, so verify the project before publishing. Run the emulator suite before publishing.
4. Only after both rules updates are published, set `MODERATION_SUSPENSION_ENABLED=true` in **Deploy Previews** and redeploy. Leave it unset or false in production. Until then report review works but suspension and restoration are disabled.
5. Test with a disposable reported member: review, suspend, verify messaging/calling/profile upload are denied, then restore. Confirm a normal account cannot open the report list. Check an active voice/video call on two devices: loss of Firestore permission closes local media in the updated beta client. Older already-open clients must reload; suspension is not a remote device wipe.

No production deployment, administrator activation, rule publication, real member suspension, or real payment is performed by adding these files.

## Operation

Open the page and refresh to see reports. There are no automatic email alerts. Filter by New, Under review or Resolved; pages contain up to 25 records ordered by report ID, not date. A review note is mandatory. Every successful decision adds a server-only audit entry. Version checks reject stale edits. A report is an allegation; review before acting.

Suspension requires typing SUSPEND and confirming the exact member. It hides the dating profile and denies application data and backend access, including new calls and purchases. The member can still sign in and use Delete Account. Administrator accounts cannot be suspended here. The target always comes from the saved report, never from a client-provided member ID.

RESTORE removes the restriction but leaves the profile hidden until the member republishes it. Suspension does not delete personal data, issue refunds, or remove already downloaded content. Existing payment receipts and balances are retained; do not use moderation to adjust billing. Contact: support@firstoptiondating.com.

The feature is gated until manual activation. Code/emulator validation does not prove dashboard configuration or live two-device behavior.

## UAT 66: authenticated photo delivery

Cloud Storage rules allow only two distinct Firestore document lookups per
request. The deletion, suspension and both-direction block checks exceed that
limit for other members' photos. Emulator success did not establish production
compatibility with that limit.

`profile-photo.mjs` now authenticates a verified, non-revoked Firebase token and
checks both members' deletion/suspension records and both block directions using
the Admin SDK before reading the photo. Responses are private/no-store streamed
bytes, never public download URLs. Object paths, content types, sizes and object
generations are validated. Local photo drafts remain local; upload/delete flows
are unchanged. Existing Storage rules stay fail-closed; this beta fix does not
require republishing rules or migrating member data.

Validation: `npm run test:unit` includes authenticated photo-delivery tests. A
signed-in beta check must still confirm a previously unavailable photo returns
and a blocked/suspended member remains unable to fetch it. The authenticated
endpoint uses the same configured service account/bucket as account deletion.
