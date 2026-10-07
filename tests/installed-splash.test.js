const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script id="installed-app-launch">([\s\S]*?)<\/script>/)[1];
for(const standalone of [true,false,undefined]){
 test(`iOS launch detection: standalone=${standalone}`,()=>{
  const classes=[];
  vm.runInNewContext(script,{navigator:{standalone},document:{documentElement:{classList:{add:c=>classes.push(c)}}}});
  assert.deepEqual(classes,standalone===true?['installed-app']:[]);
 });
}
test('installed splash suppression is applied before first paint; browser splash remains',()=>{
 assert.ok(html.indexOf('id="installed-app-launch"')<html.indexOf('<body>'));
 assert.match(html,/@media \(display-mode: standalone\)\s*\{\s*#splashScreen\{ display:none; \}/);
 assert.match(html,/html\.installed-app #splashScreen\{ display:none; \}/);
 assert.match(html,/#splashScreen\{[^}]*display:flex;/);
 assert.ok(html.includes('Make the right choice'));
});
