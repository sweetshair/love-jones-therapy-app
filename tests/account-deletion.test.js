const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function setup({ enabled = true, identity = { uid: 'own-id', auth_time: Date.now()/1000 }, status, revoked = false } = {}) {
  const file = path.resolve(__dirname, '../netlify/functions/delete-account.js');
  const localRequire = createRequire(file);
  const seen = [];
  const result = {};
  const dependencies = {
    authenticatedUser: async (_event, check) => { if (check && revoked) throw {code:'auth/id-token-revoked'}; return identity; },
    firestore: () => ({collection: name => ({doc: uid => { seen.push([name,uid]); return {get: async () => ({exists:!!status, data:()=>({status})})}; }})})
  };
  vm.compileFunction(fs.readFileSync(file,'utf8'), ['exports','require','process'], {filename:file})(result,
    name => name === './_shared/firebase-admin' ? dependencies : name === 'firebase-admin/storage' ? {} : localRequire(name),
    {env:{ACCOUNT_DELETION_ENABLED:enabled?'true':'false'}});
  return { handler: result.handler, seen };
}
const post = body => ({httpMethod:'POST',body:JSON.stringify(body || {confirmation:'DELETE'})});
test('deletion is fail-closed until rules activation and rejects unsupported methods', async () => {
  const {handler,seen}=setup({enabled:false});
  assert.equal((await handler(post())).statusCode,503);
  assert.equal((await handler({httpMethod:'DELETE'})).statusCode,405);
  assert.deepEqual(seen,[]);
});
test('explicit confirmation is required and client target IDs are rejected', async () => {
  for(const body of [{confirmation:'delete'},{confirmation:'DELETE',uid:'victim'}]) {
    const {handler,seen}=setup(); assert.equal((await handler(post(body))).statusCode,400); assert.deepEqual(seen,[]);
  }
});
test('missing, revoked, or old authentication cannot start deletion', async () => {
  for(const options of [{identity:null},{revoked:true},{identity:{uid:'own-id',auth_time:0}}]) {
    assert.equal((await setup(options).handler(post())).statusCode,401);
  }
});
test('completion retry only reads the signed token owner tombstone', async () => {
  const {handler,seen}=setup({status:'complete'});
  assert.equal((await handler(post())).statusCode,200);
  assert.deepEqual(seen,[['accountDeletions','own-id']]);
});
test('client reauthenticates before destructive request; cancel/invalid confirmation makes no request', async () => {
  const source=fs.readFileSync(path.resolve(__dirname,'../firebase-client.js'),'utf8');
  const user={uid:'me',email:'me@example.test'};const calls=[];
  const context={requireUser:()=>user,EmailAuthProvider:{credential:()=>({})},
    reauthenticateWithCredential:async()=>{calls.push('reauth');throw Error('bad password');},
    clearDeletedAccountDrafts:async()=>calls.push('drafts'),getIdToken:async()=>calls.push('token'),fetch:async()=>calls.push('request')};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function deleteMyAccount('),source.indexOf('async function resetPassword(')),context);
  await assert.rejects(context.deleteMyAccount('password','CANCEL'));
  assert.deepEqual(calls,[]);
  await assert.rejects(context.deleteMyAccount('password','DELETE'),/bad password/);
  assert.deepEqual(calls,['reauth']);
});
