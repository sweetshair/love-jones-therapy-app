const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('browser and installed app open directly without a custom splash',()=>{
 assert.doesNotMatch(html,/splashScreen|splashCard|splashLogo|removeSplash|installed-app-launch/);
 assert.match(html,/<div class="card" id="app"><\/div>/);
 assert.match(html,/first-option-logo-v58\.png/);
 assert.match(html,/Make the right choice/);
 assert.match(html,/\n  render\(\);/);
});
