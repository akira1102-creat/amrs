import test from 'node:test';import assert from 'node:assert/strict';
let boot;try{boot=await import('../bootstrap.mjs');}catch{}
const bundle={version:'test',html:'<html><body>Private Interface</body></html>',assets:{'app.js':'void 0;'}};
test('loading the interface requires session authorization and does not expose credentials in a URL',async()=>{
 assert.equal(typeof boot?.loadProtectedClient,'function');
 const calls=[];
 const result=await boot.loadProtectedClient('synthetic-credential',{baseURL:'https://api.example.test',fetchImpl:async(url,options)=>{
  calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/session')?{success:true,token:'synthetic-session'}:{success:true,...bundle}));
 }});
 assert.deepEqual(result,bundle);assert.equal(calls.length,2);
 assert.ok(calls.every(c=>!c.url.includes('synthetic-credential')));
 assert.equal(calls[1].options.headers.authorization,'Bearer synthetic-session');
});
test('a denied credential never falls back to a previously cached private interface',async()=>{
 assert.equal(typeof boot?.loadProtectedClient,'function');
 let removed=false;
 await assert.rejects(()=>boot.loadProtectedClient('revoked',{baseURL:'https://api.example.test',cache:{read:async()=>bundle,remove:async()=>removed=true},fetchImpl:async()=>new Response(JSON.stringify({success:false}),{status:401})}),/401/);
 assert.equal(removed,true);
});
test('an offline return can reuse only the cache associated with the same saved credential',async()=>{
 assert.equal(typeof boot?.loadProtectedClient,'function');
 const cache={read:async c=>c==='saved'?bundle:null};
 const fetchImpl=async()=>{throw new TypeError('Network offline');};
 assert.deepEqual(await boot.loadProtectedClient('saved',{baseURL:'https://api.example.test',cache,fetchImpl}),bundle);
 await assert.rejects(()=>boot.loadProtectedClient('different',{baseURL:'https://api.example.test',cache,fetchImpl}));
});
test('an unchanged bundle is reused only after successful reauthorization',async()=>{
 assert.equal(typeof boot?.loadProtectedClient,'function');
 const result=await boot.loadProtectedClient('saved',{baseURL:'https://api.example.test',cache:{read:async()=>bundle},fetchImpl:async url=>url.includes('/session')?new Response(JSON.stringify({token:'authorized'})):new Response(null,{status:304})});
 assert.deepEqual(result,bundle);
});
