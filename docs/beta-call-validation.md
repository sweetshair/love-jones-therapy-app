# UAT 57: simultaneous-call protection

Delivery branch: `codex/voice-video-beta`, PR #5. This is a beta change.

## Behavior

- Call creation checks membership, active match status and both block directions.
- A Firestore transaction reserves one call per match. Concurrent attempts receive HTTP 409.
- The transaction checks existing calls, including calls made before UAT 57. Ringing attempts older than 20 seconds become missed. Active calls are never expired by this check.
- Terminal calls permit another call. Reconnection retains remaining free time; paid reservation requires a balance and does not deduct it.
- The UI keeps an incoming call available after a rejected outgoing attempt. It prevents answering while outgoing setup is still running and closes a newly created outgoing call if setup subsequently fails.
- Build label and service-worker cache version are 57.

## Required database rollout

Netlify deploy previews do **not** publish `firestore.rules`.

Publish the bundled rule that denies direct client call creation to the intended beta database, after confirming the Firebase project and deployment scope. Calls must be created by `create-call-signal`; the server transaction cannot protect creation requests that bypass that function while older rules remain deployed. Client answer, decline, end and candidate permissions remain in place.

The checked-in Firebase project is `love-jones-therapy-app`. No separate beta Firebase project is configured in this repository. Do not assume a database deployment is isolated from production. This change does not deploy database rules.

## Automated checks

Install project dependencies with `npm ci`. With Java 17 and Node installed, run:

```sh
npm exec --yes --package firebase-tools@13.35.1 -- firebase emulators:exec --only firestore --config firebase.emulator.json --project demo-fod-call-tests 'npm run test:calls'
```

The tests refuse a nonlocal Firestore emulator address and use only a `demo-` project. Netlify authentication is stubbed; database transactions and rules use the real Firestore emulator. UI tests execute the production call functions with mocked media and network dependencies. These checks do not verify real Firebase authentication, cameras, audio, TURN or Stripe checkout.

## Preview and two-device acceptance

1. Confirm UAT 57 appears after loading UAT 56 and checking for updates. Confirm a normal reload keeps UAT 57.
2. With two verified, mutually matched test accounts, start calls at the same time. Exactly one attempt should ring; the other person can answer it. Repeat for voice and video and on different networks.
3. Check answer, decline, early hang-up, unanswered calls, camera/microphone denial, refresh and dropped connection. A later call should start after the prior call ends. Reconnection within 60 seconds must retain only the remaining free time.
4. Check incoming alerts from Home and Matches, sound, mute, camera controls and countdown.
5. In Stripe test mode, verify purchase, wallet credit once, and caller-only deduction of actual time. Verify cancellation and failure. No real charges.
6. Verify new and returning accounts, saved age/body-type preferences across sign-out and another device, the Terms gate, photos, Relationship IQ, Likes and matching.

Do not mark full calling verification or public launch ready until the intended database rules are deployed and these account/device checks pass.
