import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
test('the public deployment contains only the login entry, not private implementation or data',()=>{
 const output=mkdtempSync(join(tmpdir(),'public-entry-'));
 try{
  execFileSync(process.execPath,['scripts/build-public.mjs',output],{cwd:new URL('..',import.meta.url)});
  assert.deepEqual(readdirSync(output).sort(),['access-control.js','apple-touch-icon.png','bootstrap.css','bootstrap.mjs','icon.png','index.html','manifest.json','sw.js']);
  const html=readFileSync(join(output,'index.html'),'utf8');assert.match(html,/請輸入 PIN/);assert.doesNotMatch(html,/id="companyMenu"|id="casino"/);
  assert.throws(()=>execFileSync(process.execPath,['scripts/build-public.mjs',output],{cwd:new URL('..',import.meta.url),stdio:'pipe'}));
 }finally{rmSync(output,{recursive:true,force:true});}
});
