import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=resolve(process.argv[2]||join(root,'.private-runtime/source'));
const html=readFileSync(join(source,'index.html'),'utf8');
const names=[...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']\.\/([^"'?]+)[^"']*["'][^>]*>/g)].map(m=>m[1]).filter(n=>/\.(?:js|css)$/.test(n));
const assets={};
for(const name of new Set(names)){
 if(!/^[a-z0-9.-]+\.(js|css)$/i.test(name))throw Error('Unexpected private asset path');
 assets[name]=readFileSync(join(source,name),'utf8');
}
if(!Object.keys(assets).length)throw Error('Private source assets not found');
const output=join(root,'.private-runtime/client-bundle.json');mkdirSync(dirname(output),{recursive:true});
const version=html.match(/const _APP_VERSION=['"]([^'"]+)['"]/)?.[1];if(!version)throw Error('Private application version is missing');
const digest=createHash('sha256').update(JSON.stringify({html,assets})).digest('hex').slice(0,16);
writeFileSync(output,JSON.stringify({version:version+'-'+digest,html,assets}));
console.log('Private interface bundle built. It must not be committed or published as a static file.');
