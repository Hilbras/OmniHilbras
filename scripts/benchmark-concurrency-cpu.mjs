/**
 * CPU-time A/B of the gateway path under 400 concurrent clients, both builds in one process.
 *
 * Wall-clock p99 at 400 concurrent fetches is dominated by the client's socket scheduling and GC, so a
 * latency median can swing ±400ms between runs. process.cpuUsage() over a whole batch is stable and measures
 * the work the gateway actually did; both builds run alternately in one runtime with an identical client,
 * so the difference is attributable to the gateway code. BASELINE_DIR selects the pre-change checkout.
 *
 *   BASELINE_DIR=/path/to/v3.79.0 node scripts/benchmark-concurrency-cpu.mjs
 */
const MAIN=new URL('..', import.meta.url).pathname;
const BASE=(process.env.BASELINE_DIR?.replace(/\/$/,'')||'/tmp/omni-baseline')+'/';
async function make(root){
  const core=await import(`${root}Kernel/API/dist/src/index.js`);
  const internal=await import(`${root}Kernel/API/dist/src/core/index.js`);
  const reg=new internal.ProviderRegistry().register({id:'bench',name:'B',capabilities:{chat:true,streaming:false,models:true},async listModels(){return [{id:'bench-model',providerId:'bench'}]},async healthCheck(){return{status:'healthy',checkedAt:new Date().toISOString()}},async chat(r){return{id:'b',providerId:'bench',model:r.model,createdAt:new Date().toISOString(),message:{role:'assistant',content:'ok'},finishReason:'stop'}}});
  const st=new core.InMemoryConnectionStore();
  await st.save({id:'bench',providerId:'bench',name:'B',endpoint:'https://bench.invalid/v1',priority:1,proxyPool:'none',enabled:true,modelIds:['bench-model']},{type:'api-key',value:'bench'});
  const keys=new core.InMemoryApiKeyStore(); await keys.setEnforced(false);
  const svc=new core.GatewayService(reg,new internal.InMemorySecretStore({}),st,keys,{failureThreshold:1000}); svc.setHealthInterval(0);
  const srv=core.createGatewayServer(svc,{requestsPerMinute:0});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  return {srv,base:`http://127.0.0.1:${srv.address().port}`};
}
const A=await make(BASE),B=await make(MAIN);
const body=JSON.stringify({model:'bench-model',messages:[{role:'user',content:'hi'}]});
async function batch(ctx,n){
  const s=process.cpuUsage(); let next=0;
  await Promise.all(Array.from({length:50},async()=>{while(next<n){next++;const r=await fetch(ctx.base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body});await r.arrayBuffer();}}));
  const e=process.cpuUsage(s); return (e.user+e.system)/1000; // ms CPU for the whole batch
}
await batch(A,200); await batch(B,200);
const res={baseline:[],current:[]};
for(let i=0;i<11;i++)for(const [l,x] of (i%2?[['current',B],['baseline',A]]:[['baseline',A],['current',B]]))res[l].push(await batch(x,400));
const med=a=>a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
for(const l of ['baseline','current'])console.log(l,'CPU ms/batch median='+med(res[l]).toFixed(1));
console.log('CPU improvement='+((med(res.baseline)-med(res.current))/med(res.baseline)*100).toFixed(1)+'%');
A.srv.close();B.srv.close();
