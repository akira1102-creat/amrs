import {COMPANIES,companySchema} from './config.mjs';
import {normalizeDateParam} from './domain.mjs';
const text=v=>String(v??'').trim();
export function reasonStatsFromRows(rows,{company,month,timeZone='Asia/Hong_Kong'}={},templates=[]){
 if(!COMPANIES.includes(company))throw Object.assign(new Error('Invalid company'),{status:400});
 if(month!=='all'&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||''))throw Object.assign(new Error('Invalid month'),{status:400});
 const counts=new Map(),options=new Map();
 for(const item of templates){const reason=text(item.reason);if(reason&&!options.has(reason.toUpperCase()))options.set(reason.toUpperCase(),reason);}
 const schema=companySchema(company),index=schema.fields.indexOf('reason');
 let total=0,blankReasons=0;
 for(const row of rows||[]){
  const date=normalizeDateParam(row?.[1],timeZone),sn=text(row?.[4]),model=text(row?.[3]);
  if(!date||!sn||!model||(month!=='all'&&date.slice(0,7).replace('/','-')!==month))continue;
  total++;
  const reason=text(row[index]);
  if(!reason){blankReasons++;continue;}
  const key=reason.toUpperCase();
  if(!counts.has(key))counts.set(key,{reason:options.get(key)||reason,count:0});
  counts.get(key).count++;
  if(!options.has(key))options.set(key,reason);
 }
 return {success:true,company,month,total,blankReasons,reasons:[...counts.values()].sort((a,b)=>b.count-a.count||a.reason.localeCompare(b.reason)),reasonOptions:[...options.values()],templateReasons:templates.map(r=>text(r.reason)).filter(Boolean)};
}
