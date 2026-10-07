const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('legacy and current manifests share identity and new icons',()=>{
 for(const name of ['manifest.webmanifest','manifest-v77.webmanifest','manifest-v78.webmanifest']){
  const m=JSON.parse(read(name)); assert.equal(m.id,'./'); assert.equal(m.start_url,'./');
  assert.deepEqual(m.icons.map(i=>i.src),['icon-192-v78.png','icon-512-v78.png']);
 }
 assert.ok(read('index.html').includes('icon:"./icon-192-v78.png"'));
});
test('cache upgrade and ordinary reload fetch current branding',async()=>{
 const handlers={},removed=[],fetched=[];
 const cache={addAll:async requests=>{for(const r of requests) assert.ok(fs.existsSync(path.join(root,r.url==='./'?'index.html':r.url)));},put:async()=>{}};
 vm.runInNewContext(read('sw.js'),{self:{location:{origin:'https://example.com'},addEventListener:(n,f)=>handlers[n]=f,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>['fod-riq-v75-cache','fod-riq-v77-cache','fod-riq-v78-cache','unrelated'],delete:async k=>removed.push(k),match:async()=>({cached:true})},Request:class{constructor(url){this.url=url;}},URL,Response,fetch:async(req,options)=>{fetched.push(options);return{ok:true,clone:()=>({})};}});
 let pending;handlers.install({waitUntil:p=>pending=p});await pending;
 handlers.activate({waitUntil:p=>pending=p});await pending;
 assert.deepEqual(removed,['fod-riq-v75-cache','fod-riq-v77-cache']);
 for(const route of ['/','/manifest.webmanifest','/manifest-v77.webmanifest','/manifest-v78.webmanifest','/icon-192.png','/icon-512-v77.png']){
  const before=fetched.length;
  handlers.fetch({request:{url:'https://example.com'+route,method:'GET',mode:route==='/'?'navigate':'cors',destination:''},respondWith:p=>pending=p});await pending;
  assert.equal(fetched.length,before+1);assert.equal(fetched.at(-1).cache,'no-store');
 }
});
