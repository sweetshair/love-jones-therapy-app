const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPhotoHandler}=require('../netlify/functions/_shared/profile-photo');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(options={}) {
  const reads=[];let storageCalls=0;
  const bytes=options.bytes || Buffer.from('photo');
  const handler=createPhotoHandler({
    authenticatedUser:async(event,revoked)=>{
      assert.equal(revoked,true);
      if(options.revoked) throw Error('revoked');
      return event.headers.authorization ? (options.user || {uid:'viewer',email_verified:true}) : null;
    },
    firestore:()=>({doc:path=>path,getAll:async(...paths)=>{
      reads.push(...paths);if(options.dbError)throw Error('private database details');
      return paths.map(path=>({exists:path===options.denied}));
    }}),
    bucket:()=>({file:(path,version)=>{
      storageCalls++;assert.equal(path,'profilePhotos/owner/photo.jpg');
      return {getMetadata:async()=>{
        if(options.missing) throw {code:404};
        return [{size:bytes.length,contentType:'image/jpeg',generation:'123',...options.metadata}];
      },download:async range=>{
        assert.equal(version.generation,'123');assert.equal(range.end,5*1024*1024);return [bytes];
      }};
    }})
  });
  const request=(path='profilePhotos/owner/photo.jpg',authenticated=true,method='GET')=>handler(new Request(
    `https://example.test/.netlify/functions/profile-photo?path=${encodeURIComponent(path)}`,
    {method,headers:authenticated?{authorization:'Bearer test'}:{}}));
  return {request,reads,storageCalls:()=>storageCalls};
}
test('allowed member gets private streamed photo after all six checks',async()=>{
  const app=setup();const response=await app.request();assert.equal(response.status,200);
  assert.equal(await response.text(),'photo');assert.equal(app.reads.length,6);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('netlify-cdn-cache-control'),'no-store');
});
test('deletion, suspension and either block direction deny before touching Storage',async()=>{
  for(const denied of ['accountDeletions/viewer','accountSuspensions/viewer','accountDeletions/owner',
    'accountSuspensions/owner','blocks/viewer_owner','blocks/owner_viewer']){
    const app=setup({denied});assert.equal((await app.request()).status,403);assert.equal(app.storageCalls(),0);
  }
});
test('owner still reads own photo with just own account checks',async()=>{
  const app=setup({user:{uid:'owner',email_verified:true}});assert.equal((await app.request()).status,200);
  assert.deepEqual(app.reads,['accountDeletions/owner','accountSuspensions/owner']);
});
test('missing, unverified or revoked credentials cannot read photos',async()=>{
  for(const options of [{revoked:true},{user:{uid:'viewer',email_verified:false}}]){
    const app=setup(options);assert.equal((await app.request()).status,401);assert.equal(app.storageCalls(),0);
  }
  assert.equal((await setup().request(undefined,false)).status,401);
});
test('rejects foreign paths, traversal, URLs, and wrong methods',async()=>{
  for(const path of ['other/owner/photo.jpg','profilePhotos/../photo.jpg','profilePhotos/owner/../photo.jpg',
    'https://example.test/photo.jpg','profilePhotos/owner/a/b.jpg']){
    const app=setup();assert.equal((await app.request(path)).status,400);assert.equal(app.storageCalls(),0);
  }
  assert.equal((await setup().request(undefined,true,'POST')).status,405);
});
test('missing objects, unsupported content, oversize and database failure fail closed',async()=>{
  for(const options of [{missing:true},{metadata:{contentType:'text/html'}},{metadata:{size:5242881}},
    {metadata:{size:10}},{metadata:{generation:null}}]) assert.equal((await setup(options).request()).status,404);
  const app=setup({dbError:true});const response=await app.request();assert.equal(response.status,503);
  assert.equal(await response.text(),'Photo unavailable.');assert.equal(app.storageCalls(),0);
});
test('existing photos up to 5 MB can be streamed without base64',async()=>{
  const app=setup({bytes:Buffer.alloc(5*1024*1024)});const response=await app.request();
  assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,5*1024*1024);
});
const source=fs.readFileSync(require.resolve('../firebase-client.js'),'utf8');
function client(fetchImpl,currentUser={uid:'viewer'}){
  const context={auth:{currentUser},requireUser:()=>({uid:'viewer'}),draftPhotoKey:()=>false,
    getIdToken:async()=> 'test-token',fetch:fetchImpl,URL:{createObjectURL:()=> 'blob:photo'}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function loadProfilePhoto('),source.indexOf('async function deleteProfilePhoto(')),context);
  return context;
}
test('client sends auth with no-store and never falls back on a denied response',async()=>{
  let calls=0;const app=client(async(url,options)=>{
    calls++;assert.match(url,/^\/\.netlify\/functions\/profile-photo\?path=/);
    assert.equal(options.headers.Authorization,'Bearer test-token');assert.equal(options.cache,'no-store');
    return new Response('denied',{status:403});
  });
  await assert.rejects(app.loadProfilePhoto('profilePhotos/owner/photo.jpg'),/unavailable/);assert.equal(calls,1);
});
test('client rejects a response when the signed-in account changes',async()=>{
  const app=client(async()=>new Response('photo'),{uid:'different'});
  await assert.rejects(app.loadProfilePhoto('profilePhotos/owner/photo.jpg'),/account changed/);
});
