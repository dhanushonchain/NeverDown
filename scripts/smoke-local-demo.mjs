/**
 * End-to-end smoke test of the no-credentials local demo.
 * Uses fixed loopback ports and refuses to overwrite existing demo profile/db files.
 */
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";

const root=fileURLToPath(new URL("../",import.meta.url));
const profile=resolve(root,".env.demo.local");
const dbFiles=["neverdown-demo-seller.sqlite","neverdown-demo-incidents.sqlite","neverdown-demo-seller.sqlite-shm","neverdown-demo-seller.sqlite-wal","neverdown-demo-incidents.sqlite-shm","neverdown-demo-incidents.sqlite-wal"];
if(existsSync(profile)||dbFiles.some(file=>existsSync(resolve(root,file)))){
  throw new Error("Local demo profile/database already exists; run pnpm demo:local:reset or move existing files before smoke testing.");
}
const children=new Map();
const logs=new Map();
function start(name){
  const child=spawn(process.execPath,["scripts/demo-service.mjs",name],{cwd:root,stdio:["ignore","pipe","pipe"]});
  let output="";
  child.stdout.on("data",chunk=>{output+=chunk.toString();});
  child.stderr.on("data",chunk=>{output+=chunk.toString();});
  children.set(name,child);logs.set(name,()=>output);
  child.once("exit",(code,signal)=>{
    if(code!==null&&code!==0&&code!==143&&code!==130) output+=`\nexit=${code} signal=${signal}`;
  });
  return child;
}
async function stop(name){
  const child=children.get(name);if(!child)return;
  if(child.exitCode===null&&!child.killed)child.kill("SIGTERM");
  if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once("exit",resolve)),delay(2000)]);
  children.delete(name);
}
async function request(url,init){
  return fetch(url,{...init,signal:AbortSignal.timeout(2000)});
}
async function waitFor(label,fn,timeoutMs=12000){
  const until=Date.now()+timeoutMs;let last;
  while(Date.now()<until){
    const childFailures=[...children.entries()].filter(([,c])=>c.exitCode!==null);
    if(childFailures.length)throw new Error("Demo service exited: "+childFailures.map(([n])=>n+" "+logs.get(n)()).join("\n"));
    try{last=await fn();if(last)return last;}catch{}
    await delay(250);
  }
  throw new Error("Timed out waiting for "+label+"; logs: "+[...logs.entries()].map(([n,get])=>n+": "+get()).join("\n"));
}
try{
  const setup=spawnSync(process.execPath,["scripts/demo-local.mjs","setup"],{cwd:root,encoding:"utf8"});
  assert.equal(setup.status,0,setup.stderr||setup.stdout);

  start("rpc-primary");
  start("rpc-standby");
  start("gateway");
  start("seller");
  start("web");

  await waitFor("seller /health",async()=>{const r=await request("http://127.0.0.1:4001/health");return r.ok?r:null;});
  await waitFor("gateway /ready",async()=>{const r=await request("http://127.0.0.1:8787/ready");return r.ok?r:null;});
  await waitFor("web homepage",async()=>{const r=await request("http://127.0.0.1:3000/");return r.ok?r:null;});

  const probe=await request("http://127.0.0.1:4001/probe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})});
  assert.equal(probe.status,200);
  assert.equal((await probe.json()).result,"0x7a69"); // Seller RPC_MODE=mock uses the repository mock chain (31337).

  const initial=await request("http://127.0.0.1:8787/status");
  assert.equal((await initial.json()).active,"primary");
  const primaryRpc=await request("http://127.0.0.1:8787/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})});
  assert.equal((await primaryRpc.json()).result,"0x3e8");

  await stop("rpc-primary");
  await waitFor("failover to standby",async()=>{
    const r=await request("http://127.0.0.1:8787/status");const body=await r.json();return body.active==="standby"?body:null;
  });
  const standbyRpc=await request("http://127.0.0.1:8787/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:2,method:"eth_blockNumber",params:[]})});
  assert.equal((await standbyRpc.json()).result,"0x3e7");

  start("rpc-primary");
  await waitFor("failback to primary",async()=>{
    const r=await request("http://127.0.0.1:8787/status");const body=await r.json();return body.active==="primary"?body:null;
  },15000);

  const consolePage=await request("http://127.0.0.1:3000/console.html");
  assert.equal(consolePage.status,200);
  const status=await request("http://127.0.0.1:3000/api/status");
  assert.equal(status.status,200);

  const deny=await request("http://127.0.0.1:3000/api/run-agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scenario:"deny"})});
  assert.equal(deny.status,200);
  const denyResult=await deny.json();
  assert.equal(denyResult.mode,"hermetic");
  assert.equal(denyResult.receipt?.success,true);

  console.log("Local demo smoke passed: seller probe, gateway RPC, failover, failback, website, console and hermetic deny.");
}finally{
  for(const name of [...children.keys()].reverse())await stop(name);
  const cleanup=spawnSync(process.execPath,["scripts/demo-local.mjs","reset"],{cwd:root,encoding:"utf8"});
  if(cleanup.status!==0)console.error("Demo cleanup warning:",cleanup.stderr||cleanup.stdout);
}
