/**
 * Controlled A/B of the gateway's own request path under 400 concurrent clients.
 *
 * Measures server-side processing time (request arrival -> response finish), not round-trip: at high
 * concurrency the client's undici socket scheduling dominates round-trip and swamps gateway changes.
 * Both builds are loaded in one process and measured alternately, so the runtime is identical.
 *
 *   BASELINE_DIR=/path/to/v3.79.0/checkout node scripts/benchmark-concurrency-ab.mjs
 */
const MAIN=new URL('..', import.meta.url).pathname;
const BASE=process.env.BASELINE_DIR?.replace(/\/$/,'')+'/' || '/tmp/omni-baseline/';
async function make(root){
  const core=await import(`${root}Kernel/API/dist/src/index.js`);
  const internal=await import(`${root}Kernel/API/dist/src/core/index.js`);
  const reg=new internal.ProviderRegistry().register({id:'bench',name:'B',capabilities:{chat:true,streaming:false,models:true},async listModels(){return [{id:'bench-model',providerId:'bench'}]},async healthCheck(){return{status:'healthy',checkedAt:new Date().toISOString()}},async chat(r){return{id:'b',providerId:'bench',model:r.model,createdAt:new Date().toISOString(),message:{role:'assistant',content:'ok'},finishReason:'stop'}}});
  const st=new core.InMemoryConnectionStore();
  await st.save({id:'bench',providerId:'bench',name:'B',endpoint:'https://bench.invalid/v1',priority:1,proxyPool:'none',enabled:true,modelIds:['bench-model']},{type:'api-key',value:'bench'});
  const keys=new core.InMemoryApiKeyStore(); await keys.setEnforced(false);
  const svc=new core.GatewayService(reg,new internal.InMemorySecretStore({}),st,keys,{failureThreshold:1000}); svc.setHealthInterval(0);
  const srv=core.createGatewayServer(svc,{requestsPerMinute:0});
  const lat=[];
  const orig=srv.listeners('request')[0];
  srv.removeAllListeners('request');
  srv.on('request',(req,res)=>{const s=performance.now();res.once('finish',()=>lat.push(performance.now()-s));orig(req,res)});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  return {srv,base:`http://127.0.0.1:${srv.address().port}`,lat};
}
async function measure(ctx,n){
  ctx.lat.length=0;
  const body=JSON.stringify({model:'bench-model',messages:[{role:'user',content:'hi'}]});
  let next=0;
  await Promise.all(Array.from({length:400},async()=>{while(next<n){next++;const r=await fetch(ctx.base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body});await r.arrayBuffer();}}));
  const a=[...ctx.lat].sort((x,y)=>x-y);
  return [a[Math.floor(a.length/2)],a[Math.floor(a.length*0.99)]];
}
const A=await make(BASE),B=await make(MAIN);
await measure(A,200);await measure(B,200);
const res={baseline:[],current:[]};
for(let i=0;i<9;i++)for(const [l,x] of (i%2?[['current',B],['baseline',A]]:[['baseline',A],['current',B]]))res[l].push(await measure(x,400));
const med=(a,i)=>a.map(x=>x[i]).sort((p,q)=>p-q)[4];
for(const l of ['baseline','current'])console.log(l,'server p50='+med(res[l],0).toFixed(2)+'ms','p99='+med(res[l],1).toFixed(2)+'ms');
const gain=(i)=>((med(res.baseline,i)-med(res.current,i))/med(res.baseline,i)*100).toFixed(1);
console.log('gateway-side improvement p50='+gain(0)+'% p99='+gain(1)+'%');
A.srv.close();B.srv.close();
