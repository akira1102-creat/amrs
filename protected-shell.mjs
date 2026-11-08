export function createProtectedShell({bundle,authorize,cors}){
 return async function protectedShell(request,env){
  const headers={...cors(request,env),'cache-control':'no-store, private','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','vary':'Origin, Authorization'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='GET')return new Response(JSON.stringify({success:false,message:'Method not allowed'}),{status:405,headers});
  try{
   await authorize(request,env);
   if(new URL(request.url).searchParams.get('version')===bundle.version)return new Response(null,{status:304,headers});
   return new Response(JSON.stringify({success:true,...bundle}),{status:200,headers});
  }catch(error){
   const status=error.status===403?403:401;
   return new Response(JSON.stringify({success:false,message:status===403?'Missing permission':'Unauthorized'}),{status,headers});
  }
 };
}
