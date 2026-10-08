const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../auth-action.js'), 'utf8');
const handler = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture(operation) {
  const calls = [], statuses = [];
  const sdk = {
    checkActionCode: async (...args) => { calls.push(['check', ...args]); return { operation }; },
    applyActionCode: async (...args) => calls.push(['apply', ...args]),
    verifyPasswordResetCode: async (...args) => { calls.push(['verifyReset', ...args]); return 'member@example.com'; },
    confirmPasswordReset: async (...args) => calls.push(['reset', ...args])
  };
  const view = {
    status: (...args) => statuses.push(args),
    reset: submit => { view.submit = submit; },
    hideReset: () => { view.hidden = true; },
    busy: value => { view.saving = value; },
    clearPasswords: () => { view.cleared = true; }
  };
  return { sdk, view, calls, statuses };
}

test('missing, duplicate, unsupported or foreign-project links are rejected', async () => {
  const { parseAction } = await handler;
  for (const query of ['', '?mode=verifyEmail', '?mode=signIn&oobCode=a',
    '?mode=verifyEmail&mode=resetPassword&oobCode=a', '?mode=verifyEmail&oobCode=a&oobCode=b',
    '?mode=verifyEmail&oobCode=a&apiKey=foreign']) assert.throws(() => parseAction(query));
});

for (const [mode, operation, title] of [
  ['verifyEmail', 'VERIFY_EMAIL', 'Email verified'],
  ['recoverEmail', 'RECOVER_EMAIL', 'Email address restored'],
  ['verifyAndChangeEmail', 'VERIFY_AND_CHANGE_EMAIL', 'Email address updated']
]) test(`${mode} completes only after Firebase accepts the matching code`, async () => {
  const { parseAction, handleAction } = await handler;
  const f = fixture(operation);
  await handleAction(parseAction(`?mode=${mode}&oobCode=sample`), f.sdk, 'auth', f.view);
  assert.deepEqual(f.calls, [['check', 'auth', 'sample'], ['apply', 'auth', 'sample']]);
  assert.equal(f.statuses.at(-1)[0], title);
});

test('a mismatched or expired code cannot apply an action or expose the reset form', async () => {
  const { parseAction, handleAction } = await handler;
  for (const expired of [false, true]) {
    const f = fixture('PASSWORD_RESET');
    if (expired) f.sdk.checkActionCode = async () => { throw { code: 'auth/expired-action-code' }; };
    await handleAction(parseAction('?mode=verifyEmail&oobCode=sample'), f.sdk, 'auth', f.view);
    assert.equal(f.calls.some(c => c[0] === 'apply'), false);
    assert.equal(f.view.submit, undefined);
    assert.match(f.statuses.at(-1)[1], /invalid, expired/);
  }
});

test('reset waits for matching passwords and saves the code once on duplicate submit', async () => {
  const { parseAction, handleAction } = await handler;
  const f = fixture('PASSWORD_RESET');
  let finish;
  f.sdk.confirmPasswordReset = (...args) => {
    f.calls.push(['reset', ...args]);
    return new Promise(resolve => { finish = resolve; });
  };
  await handleAction(parseAction('?mode=resetPassword&oobCode=sample'), f.sdk, 'auth', f.view);
  assert.equal(f.calls.filter(c => c[0] === 'reset').length, 0);
  await f.view.submit('abc', 'abc');
  await f.view.submit('long-password', 'different');
  assert.equal(f.calls.filter(c => c[0] === 'reset').length, 0);
  const first = f.view.submit('long-password', 'long-password');
  await f.view.submit('long-password', 'long-password');
  assert.equal(f.calls.filter(c => c[0] === 'reset').length, 1);
  finish(); await first;
  assert.equal(f.statuses.at(-1)[0], 'Password updated');
  assert.equal(f.view.hidden, true);
  assert.equal(f.view.cleared, true);
});

test('password policy failure allows retry without claiming success', async () => {
  const { parseAction, handleAction } = await handler;
  const f = fixture('PASSWORD_RESET');
  f.sdk.confirmPasswordReset = async () => { throw { code: 'auth/password-does-not-meet-requirements' }; };
  await handleAction(parseAction('?mode=resetPassword&oobCode=sample'), f.sdk, 'auth', f.view);
  await f.view.submit('password', 'password');
  assert.equal(f.statuses.at(-1)[0], 'Password not updated');
  assert.match(f.statuses.at(-1)[1], /stronger password/);
  assert.equal(f.view.saving, false);
  assert.equal(f.view.hidden, undefined);
});

test('untrusted continue URLs cannot redirect users; private action requests bypass service worker', async () => {
  const { parseAction } = await handler;
  assert.deepEqual(parseAction('?mode=verifyEmail&oobCode=sample&continueUrl=https://evil.example'),
    { mode: 'verifyEmail', code: 'sample', operation: 'VERIFY_EMAIL' });
  const events = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8'), {
    self: { addEventListener: (name, fn) => { events[name] = fn; } }, URL
  });
  for (const route of ['/auth-action.html?oobCode=private', '/auth-action.js']) {
    events.fetch({ request: { method: 'GET', url: 'https://firstoptiondating.com' + route },
      respondWith: () => assert.fail('Account links must not enter the cache') });
  }
});
