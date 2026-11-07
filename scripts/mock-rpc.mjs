/**
 * Deterministic Sepolia-shaped local JSON-RPC mock.
 * It is not connected to Ethereum. Set DEMO_RPC_STATE=down to simulate failure.
 */
import {createServer} from "node:http";
const port=Number(process.env.DEMO_RPC_PORT??8788);
const state=(process.env.DEMO_RPC_STATE??"healthy").toLowerCase();
const block=Number(process.env.DEMO_RPC_BLOCK??1000);
const server=createServer(async(req,res)=>{
 if(req.method!=="POST"){res.writeHead(405).end();return}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"))}catch{res.writeHead(400).end();return}
 if(state==="down"){res.writeHead(503,{"content-type":"application/json"}).end(JSON.stringify({error:"mock provider down"}));return}
 const {id,method}=body;let result;
 if(method==="eth_chainId")result="0xaa36a7";
 else if(method==="eth_blockNumber")result="0x"+block.toString(16);
 else if(method==="net_version")result="11155111";
 else{res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:id??null,error:{code:-32601,message:"method not supported by mock RPC"}}));return}
 res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}).end(JSON.stringify({jsonrpc:"2.0",id:id??null,result}));
});
server.listen(port,"127.0.0.1",()=>console.log("Mock Sepolia-shaped RPC ("+state+") at http://127.0.0.1:"+port+" — not a live chain"));
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>server.close(()=>process.exit(0)));
