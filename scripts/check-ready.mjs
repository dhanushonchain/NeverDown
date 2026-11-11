const mode=process.argv[2]??"--demo";
if(mode!=="--demo"&&mode!=="--live"){console.error("Usage: node scripts/check-ready.mjs --demo|--live");process.exit(2)}
const targets=mode==="--demo"?[
 ["seller","http://127.0.0.1:4001/health"],
 ["gateway","http://127.0.0.1:8787/health"],
 ["gateway ready","http://127.0.0.1:8787/ready"],
 ["website","http://127.0.0.1:3000/"]
]:[
 ["seller",(process.env.SELLER_URL??"http://localhost:4001").replace(/\/+$/,"")+"/health"],
 ["gateway ready",(process.env.GATEWAY_URL??"http://localhost:8787").replace(/\/+$/,"")+"/ready"]
];
let failed=false;
for(const [name,url] of targets){
 try{const response=await fetch(url,{signal:AbortSignal.timeout(2500)});console.log((response.ok?"PASS ":"FAIL ")+name+": HTTP "+response.status);if(!response.ok)failed=true}
 catch{console.log("FAIL "+name+": not reachable");failed=true}
}
if(failed)process.exitCode=1;
