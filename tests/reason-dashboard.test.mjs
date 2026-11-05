import test from 'node:test';
import assert from 'node:assert/strict';
let mod;try{mod=(await import('../reason-dashboard.js')).default;}catch{}
test('company exclusions affect only matching historical reasons and have an honest denominator',()=>{
 assert.equal(typeof mod?.summarize,'function','reason dashboard calculation must exist');
 const data={total:8,blankReasons:1,reasons:[{reason:'PM',count:4},{reason:'Wrong Reading',count:2},{reason:'PO',count:1}]};
 const r=mod.summarize(data,[' pm ','PO']);
 assert.equal(r.included,2);assert.equal(r.excluded,5);
 assert.deepEqual(r.reasons,[{reason:'Wrong Reading',count:2,share:100}]);
 assert.equal(mod.summarize(data,[]).included,7);
 assert.equal(mod.summarize(data,['PM','PO','Wrong Reading']).reasons.length,0);
 assert.equal(mod.summarize({total:0,blankReasons:0,reasons:[]},[]).included,0);
});
