const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const client = fs.readFileSync(require.resolve('../firebase-client.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function ui() {
  const profile = deferred(), matches = deferred(), events = [];
  const context = {
    state: { authUser: { uid: 'viewer', emailVerified: true }, relationshipType: 'type', screen: 'matches', matchView: 'connections', connections: [{ id: 'stale' }] },
    app: {}, render: () => events.push('render'),
    startIncomingCallWatches: async () => {},
    window: { ljtFirebase: {
      getMyDatingProfile: () => { events.push('profile'); return profile.promise; },
      getMutualMatches: () => { events.push('matches'); return matches.promise; }
    } }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('  let connectionsRequest ='), html.indexOf('  function formatMessageTime(')), context);
  return { context, profile, matches, events };
}
test('profile and matches start together; cards stay hidden until the profile check finishes', async () => {
  const { context: c, profile, matches, events } = ui();
  c.renderMatches();
  assert.deepEqual(events, ['matches', 'profile']);
  assert.match(c.app.innerHTML, /Loading your matching preferences/);
  assert.equal(c.state.connections.length, 0);
  matches.resolve([{ id: 'new' }]); await settle();
  assert.equal(c.state.connections[0].id, 'new');
  assert.equal(events.includes('render'), false);
  profile.resolve({ ownerId: 'viewer' }); await settle();
  assert.equal(events.at(-1), 'render');
});
test('profile finishing first does not wait for matches to update loading state', async () => {
  const { context: c, profile, matches, events } = ui();
  c.renderMatches(); profile.resolve({ ownerId: 'viewer' }); await settle();
  assert.equal(c.state.datingProfileLoaded, true);
  assert.equal(c.state.connectionsLoading, true);
  assert.equal(events.at(-1), 'render');
  matches.resolve([]); await settle();
  assert.equal(c.state.connectionsLoaded, true);
});
test('loading and failed requests never retain old match cards; failures allow a retry', async () => {
  const { context: c, matches } = ui();
  c.loadConnections(); c.loadConnections();
  assert.equal(c.state.connections.length, 0);
  matches.reject(new Error('Offline')); await settle();
  assert.equal(c.state.connections.length, 0);
  assert.equal(c.state.connectionsError, 'Offline');
  assert.equal(c.state.connectionsLoading, false);
});
test('responses from a previous signed-in account cannot populate the new account', async () => {
  const { context: c, profile, matches, events } = ui();
  c.renderMatches(); c.state.authUser = { uid: 'other', emailVerified: true };
  matches.resolve([{ id: 'private' }]); profile.resolve({ ownerId: 'viewer' }); await settle();
  assert.equal(c.state.connections.length, 0);
  assert.equal(c.state.datingProfile, undefined);
  assert.equal(events.includes('render'), false);
});
function matchClient() {
  const reads = [], auth = { currentUser: { uid: 'viewer' } };
  const c = { auth, requireUser: () => auth.currentUser, db: {}, collection: () => 'matches', where: (...v) => v, limit: v => v, query: (...v) => v,
    getDocs: () => { const d = deferred(); reads.push(d); return d.promise; } };
  vm.createContext(c);
  vm.runInContext(client.slice(client.indexOf('let mutualMatchesRequest ='), client.indexOf('async function getFreeCallAllowance(')), c);
  return { c, reads, snapshot: rows => ({ forEach: fn => rows.forEach(row => fn({ id: row.id, data: () => row })) }) };
}
test('concurrent callers share one read, closed matches stay hidden, and later opens read fresh data', async () => {
  const { c, reads, snapshot } = matchClient();
  const a = c.getMutualMatches(), b = c.getMutualMatches();
  assert.equal(reads.length, 1);
  reads[0].resolve(snapshot([{ id: 'active', status: 'active' }, { id: 'removed', status: 'closed' }]));
  assert.deepEqual(Array.from(await a, m => m.id), ['active']); assert.equal(await a, await b);
  const next = c.getMutualMatches(); assert.equal(reads.length, 2);
  reads[1].resolve(snapshot([])); assert.equal((await next).length, 0);
});
test('failed shared reads are not cached and can be retried', async () => {
  const { c, reads, snapshot } = matchClient();
  const pending = c.getMutualMatches(); reads[0].reject(new Error('Denied'));
  await assert.rejects(pending, /Denied/);
  const next = c.getMutualMatches(); reads[1].resolve(snapshot([])); await next;
  assert.equal(reads.length, 2);
});
test('a query completing after an account switch is rejected', async () => {
  const { c, reads, snapshot } = matchClient();
  const pending = c.getMutualMatches(); c.auth.currentUser = { uid: 'other' };
  reads[0].resolve(snapshot([{ id: 'private', status: 'active' }]));
  await assert.rejects(pending, /account changed/);
});
test('match photos wait until near the viewport and detached photos release their URLs', async () => {
  const pending = deferred(), loads = [], observed = [], revoked = [];
  let notify;
  const image = { isConnected: true, dataset: { photoPath: 'private' }, hasAttribute: () => true };
  class Observer { constructor(callback) { notify = callback; } observe(item) { observed.push(item); } unobserve() {} disconnect() {} }
  const c = { document: { querySelectorAll: () => [image] }, window: { IntersectionObserver: Observer, ljtFirebase: { loadProfilePhoto: path => { loads.push(path); return pending.promise; } } }, IntersectionObserver: Observer, URL: { revokeObjectURL: value => revoked.push(value) } };
  vm.createContext(c); vm.runInContext(html.slice(html.indexOf('  let matchPhotoObserver ='), html.indexOf('  let heroCarouselTimer =')), c);
  await c.hydrateProfilePhotos(); assert.equal(loads.length, 0); assert.equal(observed.length, 1);
  notify([{ target: image, isIntersecting: true }]); assert.deepEqual(loads, ['private']);
  image.isConnected = false; pending.resolve('blob:old'); await settle();
  assert.deepEqual(revoked, ['blob:old']); assert.equal(image.src, undefined);
});
