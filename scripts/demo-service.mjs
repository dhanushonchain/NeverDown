/**
 * Start one local demo service using .env.demo.local only.
 * It intentionally does not read .env or pass signing credentials.
 */
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const profile=resolve(root,".env.demo.local");
const service=process.argv[2];
const commands={
 seller:["--import","tsx","apps/sellers/src/server.ts"],
 gateway:["--import","tsx","apps/gateway/src/server.ts"],
 web:["--import","tsx","src/server.ts"],
 "rpc-primary":["scripts/mock-rpc.mjs"],
 "rpc-standby":["scripts/mock-rpc.mjs"]
};
if(!service||!(service in commands)){console.error("Usage: node scripts/demo-service.mjs seller|gateway|web|rpc-primary|rpc-standby");process.exit(2)}
const safeProfileKeys=new Set([
 "SELLER_PORT","HEDERA_MERCHANT_ACCOUNT_ID","HEDERA_X402_ASSET_ID","HEDERA_X402_PRICE_SMALLEST_UNITS",
 "RPC_MODE","SELLER_ENTITLEMENT_DB_PATH","GATEWAY_PORT","GATEWAY_CHAIN_ID",
 "GATEWAY_PRIMARY_RPC_URL","GATEWAY_STANDBY_RPC_URL","GATEWAY_HEALTH_INTERVAL_MS",
 "GATEWAY_REQUEST_TIMEOUT_MS","GATEWAY_FAILURE_THRESHOLD","GATEWAY_RECOVERY_THRESHOLD",
 "GATEWAY_STALE_BLOCK_TOLERANCE","GATEWAY_FAILOVER_COOLDOWN_MS","GATEWAY_INTERNAL_API",
 "GATEWAY_URL","WEB_PORT","INCIDENT_DB_PATH","AGENT_LIVE"
]);
// Preserve OS essentials (notably SystemRoot/TEMP on Windows), but strip all known secrets.
const env={...process.env};
for(const key of [
 "HEDERA_SPEND_KEY","HEDERA_OPERATOR_KEY","ARKIV_PRIVATE_KEY","ARKIV_ACCESS_KEY",
 "RECLAIM_PRIVATE_KEY","ENS_OWNER_PRIVATE_KEY","OPENAI_API_KEY","GATEWAY_INTERNAL_TOKEN",
 "PAYMENT_WORKER_ENV_FILE","DATABASE_URL"
])delete env[key];
env.NODE_ENV="development";
for(const line of readFileSync(profile,"utf8").split(/\r?\n/)){
 const value=line.trim();if(!value||value.startsWith("#"))continue;
 const index=value.indexOf("=");if(index<=0)continue;
 const key=value.slice(0,index);
 if(!safeProfileKeys.has(key)){console.error("Unsupported key in .env.demo.local: "+key);process.exit(1)}
 env[key]=value.slice(index+1);
}
if(service==="rpc-primary"){env.DEMO_RPC_PORT="8788";env.DEMO_RPC_STATE="healthy"}
if(service==="rpc-standby"){env.DEMO_RPC_PORT="8789";env.DEMO_RPC_STATE="healthy";env.DEMO_RPC_BLOCK="999"}
const cwd=service==="web"?resolve(root,"apps/web"):root;
const child=spawn(process.execPath,commands[service],{cwd,env,stdio:"inherit"});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
child.on("error",error=>{console.error(error.message);process.exitCode=1});
child.on("exit",(code,signal)=>{process.exitCode=code??(signal?128:1)});
