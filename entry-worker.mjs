import runtime from './.private-runtime/source/worker/src/index.mjs';
import {requireSession} from './.private-runtime/source/worker/src/auth.mjs';
import {corsHeaders} from './.private-runtime/source/worker/src/http.mjs';
import bundle from './.private-runtime/client-bundle.json';
import {createProtectedShell} from './protected-shell.mjs';
const serveShell=createProtectedShell({bundle,authorize:requireSession,cors:corsHeaders});
export default {fetch(request,env,context){
 if(new URL(request.url).pathname.replace(/\/+$/,'')==='/client-shell')return serveShell(request,env);
 return runtime.fetch(request,env,context);
}};
