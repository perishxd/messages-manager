import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild');
const temp=await mkdtemp(join(tmpdir(),'dmm-media-'));
await build({entryPoints:[fileURLToPath(new URL('../native.ts',import.meta.url))],outfile:join(temp,'native.cjs'),bundle:true,platform:'node',format:'cjs',plugins:[{name:'electron-mock',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'exports.net={fetch:(...args)=>globalThis.__nativeFetch(...args)}',loader:'js'}));}}]});
await build({entryPoints:[fileURLToPath(new URL('../desktopMedia.ts',import.meta.url))],outfile:join(temp,'desktop.cjs'),bundle:true,platform:'node',format:'cjs'});
const native=require(join(temp,'native.cjs')),{downloadDesktopMedia}=require(join(temp,'desktop.cjs'));
after(()=>rm(temp,{recursive:true,force:true}));
const event={sender:{id:1,getUserAgent:()=> 'Discord desktop test'}},url='https://cdn.discordapp.com/attachments/333333333333333333/555555555555555555/file.zip',id=()=>crypto.randomUUID();
test('desktop helper accepts CDN files without credentials and refuses arbitrary URLs or oversized limits',async()=>{
 let calls=0;globalThis.__nativeFetch=async(u,options)=>{calls++;assert.equal(u,url);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{'User-Agent':'Discord desktop test'});return new Response(new Uint8Array([1,2,3]));};
 const result=await native.downloadMedia(event,url,10,id());assert.equal(result.ok,true);assert.deepEqual([...result.bytes],[1,2,3]);
 for(const invalid of ['https://example.com/file.zip','https://cdn.discordapp.com.evil.test/file','https://user:pass@cdn.discordapp.com/file','http://cdn.discordapp.com/file','https://cdn.discordapp.com:444/file'])assert.equal((await native.downloadMedia(event,invalid,10,id())).ok,false);
 assert.equal((await native.downloadMedia(event,url,26*1024*1024,id())).ok,false);assert.equal(calls,1);
});
test('native streaming enforces limits even without a Content-Length header and reports HTTP failures',async()=>{
 globalThis.__nativeFetch=async()=>new Response(new Uint8Array(20));assert.match((await native.downloadMedia(event,url,10,id())).error,/size limit/);
 globalThis.__nativeFetch=async()=>new Response('gone',{status:404});assert.match((await native.downloadMedia(event,url,10,id())).error,/HTTP 404/);
});
test('cancelling native media is scoped to the requesting window',async()=>{
 let signal;globalThis.__nativeFetch=async(u,options)=>{signal=options.signal;return await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const request=id(),pending=native.downloadMedia(event,url,10,request);
 await native.cancelMedia({sender:{id:2}},request);assert.equal(signal.aborted,false);
 await native.cancelMedia(event,request);assert.equal(signal.aborted,true);assert.equal((await pending).ok,false);
});
test('renderer fallback propagates job cancellation to native downloads and refuses late bytes',async()=>{
 const controller=new AbortController();let request,cancelled=false,finish;
 globalThis.VencordNative={pluginHelpers:{MessagesManager:{downloadMedia:async(u,max,r)=>{request=r;return await new Promise(resolve=>finish=()=>resolve({ok:true,bytes:new Uint8Array([1])}));},cancelMedia:async r=>{assert.equal(r,request);cancelled=true;}}}};
 const pending=downloadDesktopMedia(url,10,controller.signal);controller.abort(Error('Account changed.'));finish();await assert.rejects(pending,/Account changed/);assert.equal(cancelled,true);delete globalThis.VencordNative;
});
