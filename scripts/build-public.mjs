import {mkdirSync,copyFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2]||join(root,'dist'));
if(existsSync(output)&&readdirSync(output).length)throw Error('Output directory is not empty; refusing to overwrite');
mkdirSync(output,{recursive:true});
for(const [source,name] of [['public/index.html','index.html'],['public/bootstrap.css','bootstrap.css'],['public/sw.js','sw.js'],...['bootstrap.mjs','access-control.js','manifest.json','icon.png','apple-touch-icon.png'].map(n=>[n,n])])copyFileSync(join(root,source),join(output,name));
console.log('Public login entry built. Private runtime and business modules are excluded.');
