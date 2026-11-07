/**
 * Creates/checks/removes a mock-only local demo profile.
 * This profile is separate from .env and contains no credentials.
 */
import {chmodSync,existsSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const profile=resolve(root,".env.demo.local");
const mode=process.argv[2]??"status";
const lines=[
"# Generated mock-only demo profile. No secrets or spend keys.",
"SELLER_PORT=4001","HEDERA_MERCHANT_ACCOUNT_ID=0.0.4242","HEDERA_X402_ASSET_ID=0.0.0",
"HEDERA_X402_PRICE_SMALLEST_UNITS=10000","RPC_MODE=mock","SELLER_ENTITLEMENT_DB_PATH=neverdown-demo-seller.sqlite",
"GATEWAY_PORT=8787","GATEWAY_CHAIN_ID=11155111","GATEWAY_PRIMARY_RPC_URL=http://127.0.0.1:8788",
"GATEWAY_STANDBY_RPC_URL=http://127.0.0.1:8789","GATEWAY_HEALTH_INTERVAL_MS=1000","GATEWAY_REQUEST_TIMEOUT_MS=1000",
"GATEWAY_FAILURE_THRESHOLD=2","GATEWAY_RECOVERY_THRESHOLD=2","GATEWAY_STALE_BLOCK_TOLERANCE=100",
"GATEWAY_FAILOVER_COOLDOWN_MS=1000","GATEWAY_INTERNAL_API=false","GATEWAY_URL=http://127.0.0.1:8787",
"WEB_PORT=3000","INCIDENT_DB_PATH=neverdown-demo-incidents.sqlite","AGENT_LIVE=false",""
].join("\n");
async function probe(label,url){try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});return {label,status:r.status,ok:r.ok}}catch{return {label,status:"not running",ok:false}}}
if(mode==="setup"){
 if(existsSync(profile)){console.error(".env.demo.local already exists; refusing to overwrite.");process.exit(1)}
 writeFileSync(profile,lines,{encoding:"utf8",flag:"wx",mode:0o600});chmodSync(profile,0o600);
 console.log("Created .env.demo.local (mock-only, no credentials).");
}else if(mode==="status"){
 const results=await Promise.all([
  probe("Seller","http://127.0.0.1:4001/health"),
  probe("Gateway","http://127.0.0.1:8787/health"),
  probe("Gateway ready","http://127.0.0.1:8787/ready"),
  probe("Website","http://127.0.0.1:3000/")
 ]);
 console.log("Local profile:",existsSync(profile)?"present":"missing");
 for(const r of results)console.log((r.ok?"PASS":"--")+" "+r.label+": "+r.status);
 console.log("This check performs no payment or external chain write.");
}else if(mode==="reset"){
 if(existsSync(profile))rmSync(profile);
 for(const file of ["neverdown-demo-seller.sqlite","neverdown-demo-seller.sqlite-shm","neverdown-demo-seller.sqlite-wal","neverdown-demo-incidents.sqlite","neverdown-demo-incidents.sqlite-shm","neverdown-demo-incidents.sqlite-wal"]){
  const path=resolve(root,file);if(existsSync(path))rmSync(path);
 }
 console.log("Removed local demo profile and demo databases only.");
}else{console.error("Usage: node scripts/demo-local.mjs setup|status|reset");process.exit(2)}
