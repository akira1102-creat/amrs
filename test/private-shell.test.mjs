import test from 'node:test';
import assert from 'node:assert/strict';
let gateway;try{gateway=await import('../protected-shell.mjs');}catch{}
test('private interface is not returned without a currently valid session',async()=>{
 assert.equal(typeof gateway?.createProtectedShell,'function');
 const shell=createFixture();
 for(const authorization of ['', 'Bearer invalid', 'Bearer revoked']){
  const response=await shell(new Request('https://api.example.test/client-shell',{headers:{authorization}}),{});
  assert.equal(response.status,401);
  assert.doesNotMatch(await response.text(),/Private Interface|Venue Example/);
 }
});
function createFixture(){
 return gateway.createProtectedShell({bundle:{version:'test',html:'<h1>Private Interface</h1><p>Venue Example</p>',assets:{}},
  authorize:async request=>{if(request.headers.get('authorization')!=='Bearer valid')throw Object.assign(Error('Unauthorized'),{status:401});},
  cors:()=>({'access-control-allow-origin':'https://app.example.test'})});
}
test('authorized interface responses cannot be cached by a shared CDN and never put credentials in URLs',async()=>{
 assert.equal(typeof gateway?.createProtectedShell,'function');
 const response=await createFixture()(new Request('https://api.example.test/client-shell',{headers:{authorization:'Bearer valid'}}),{});
 assert.equal(response.status,200);
 assert.match(response.headers.get('cache-control'),/no-store/);
 assert.equal(response.headers.get('access-control-allow-origin'),'https://app.example.test');
 const body=await response.json();assert.equal(body.html,'<h1>Private Interface</h1><p>Venue Example</p>');
 assert.doesNotMatch(JSON.stringify(body),/Bearer valid/);
});
test('private interface supports preflight but rejects URL credentials and POST',async()=>{
 assert.equal(typeof gateway?.createProtectedShell,'function');
 const handler=createFixture();
 assert.equal((await handler(new Request('https://api.example.test/client-shell',{method:'OPTIONS'}),{})).status,204);
 assert.equal((await handler(new Request('https://api.example.test/client-shell?token=valid'),{})).status,401);
 assert.equal((await handler(new Request('https://api.example.test/client-shell?version=test'),{})).status,401);
 assert.equal((await handler(new Request('https://api.example.test/client-shell?version=test',{headers:{authorization:'Bearer valid'}}),{})).status,304);
 assert.equal((await handler(new Request('https://api.example.test/client-shell',{method:'POST',headers:{authorization:'Bearer valid'}}),{})).status,405);
});
