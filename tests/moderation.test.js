const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
function setup({identity={uid:'admin',email_verified:true},admins='admin',suspended=false,deleted=false,revoked=false}={}) {
  const file=path.resolve(__dirname,'../netlify/functions/moderate-reports.js');
  const localRequire=createRequire(file);const result={};let reportsRead=false;
  const db={collection:name=>({doc:()=>({get:async()=>({exists:name==='accountDeletions'?deleted:name==='accountSuspensions'?suspended:false})}),
    where:()=>{reportsRead=true;return {orderBy:()=>({limit:()=>({get:async()=>({docs:[],size:0})})})};}})};
  vm.compileFunction(fs.readFileSync(file,'utf8'),['exports','require','process'],{filename:file})(result,
    name=>name==='./_shared/firebase-admin'?{authenticatedUser:async(_event,check)=>{
      assert.equal(check,true);if(revoked)throw {code:'auth/id-token-revoked'};return identity;
    },firestore:()=>db}:localRequire(name),{env:{MODERATOR_UIDS:admins}});
  return {...result,reportsRead:()=>reportsRead};
}
test('report access fails closed for missing, unverified, revoked, deleted and suspended administrators',async()=>{
  for(const options of [{identity:null},{admins:''},{identity:{uid:'other',email_verified:true,admin:true}},
    {identity:{uid:'admin',email_verified:false}},{revoked:true},{deleted:true},{suspended:true}]) {
    const app=setup(options);const response=await app.handler({httpMethod:'GET'});
    assert.ok([401,403].includes(response.statusCode));assert.equal(app.reportsRead(),false);
  }
});
test('an exact configured verified UID can list reports; suspension defaults off',async()=>{
  const app=setup();assert.equal((await app.handler({httpMethod:'GET'})).statusCode,200);
  assert.equal(app.reportsRead(),true);
  const access=JSON.parse((await app.handler({httpMethod:'GET',queryStringParameters:{action:'access'}})).body);
  assert.deepEqual(access,{allowed:true,suspended:false,suspensionEnabled:false});
});
test('invalid mutation inputs and unactivated suspension are rejected before any transaction',async()=>{
  const {applyAction}=setup();const valid={reportId:'report',action:'status',version:0,status:'resolved',note:'Reviewed'};
  for(const body of [null,[],{}, {...valid,reportId:'../member'}, {...valid,note:''}, {...valid,status:'invalid'},
    {...valid,version:-1}, {...valid,action:'suspend',confirmation:'wrong'}]) {
    await assert.rejects(applyAction({},'admin',body,['admin'],true),error=>error.status===400);
  }
  await assert.rejects(applyAction({},'admin',{...valid,action:'suspend',confirmation:'SUSPEND'},['admin'],false),error=>error.status===503);
});
