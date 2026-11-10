import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{unzipSync,strFromU8}=require('fflate');
const temp=await mkdtemp(path.join(tmpdir(),'dmm-archive-'));
await build({entryPoints:[fileURLToPath(new URL('../archive.ts',import.meta.url))],outfile:path.join(temp,'archive.cjs'),bundle:true,alias:{fflate:require.resolve('fflate')},platform:'node',format:'cjs'});
await build({entryPoints:[fileURLToPath(new URL('../export.ts',import.meta.url))],outfile:path.join(temp,'export.cjs'),bundle:true,alias:{fflate:require.resolve('fflate')},platform:'node',format:'cjs'});
const {buildArchive}=require(path.join(temp,'archive.cjs')),{defaultTheme}=require(path.join(temp,'export.cjs'));
after(()=>rm(temp,{recursive:true,force:true}));
const owner='1113854342517243904',channel='333333333333333333',channel2='444444444444444444';
const attachment='https://cdn.discordapp.com/attachments/333333333333333333/555555555555555555/photo.png?ex=1&is=2&hm=example';
const message={id:'1420000000000000000',channel_id:channel,author:{id:owner,username:'Example',avatar:'a'.repeat(32),primary_guild:{identity_guild_id:channel,identity_enabled:true,tag:'TEST',badge:'b'.repeat(32)}},content:'Hello **archive** <:smile:666666666666666666>',timestamp:'2026-10-31T12:00:00Z',type:0,attachments:[{id:'555555555555555555',filename:'photo.png',url:attachment,content_type:'image/png'}]};
const plan={owner,channels:[{id:channel,name:'Example DM'}],messages:[message],range:{before:Date.now()},ownCount:1,scanned:1};
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8sAAAAASUVORK5CYII=','base64'));
function hooks(){const aborter=new AbortController();return{aborter,signal:aborter.signal,checkpoint:async()=>{aborter.signal.throwIfAborted();},progress:()=>{}};}
const fakeFetch=async(url,options)=>{assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);return new Response(png,{headers:{'content-type':'image/png'}});};
const text=(files,p)=>strFromU8(files[p]);
test('ZIP has two main folders and every downloaded URL resolves to a local asset',async()=>{
 const out=await buildArchive(plan,defaultTheme,hooks(),fakeFetch),files=unzipSync(out.bytes);
 assert.ok(files['avatars/']);assert.ok(files['conversations/']);assert.ok(files['index.html']);
 const page=Object.keys(files).find(p=>p.startsWith('conversations/')&&p.endsWith('index.html')),html=text(files,page);
 assert.match(html,/TEST/);assert.match(html,/img-src 'self' file:/);assert.match(html,/script-src 'none'/);
 assert.match(html,/src="\.\.\/\.\.\/avatars\//);assert.match(html,/src="media\//);
 const refs=[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m=>m[1]).filter(p=>!p.startsWith('https:'));
 for(const ref of refs)assert.ok(files[path.posix.normalize(path.posix.join(path.posix.dirname(page),ref))],ref);
 assert.equal(out.downloaded,4);assert.equal(out.missed,0);
 assert.equal(Object.keys(files).filter(p=>p.startsWith('avatars/')&&!p.endsWith('/')).length,1);
 // The original data is unchanged for JSON and online HTML exports.
 assert.equal(plan.messages[0].attachments[0].url,attachment);
 await writeFile('/tmp/dmm-example-archive.zip',out.bytes);
});
test('shared assets download once across DMs and unsafe channel names cannot escape their folder',async()=>{
 let requests=0;const input={...plan,channels:[{id:channel,name:'../CON/<script>'},{id:channel2,name:'Second DM'}],messages:[message,{...message,id:'1420000000000000001',channel_id:channel2}]};
 const out=await buildArchive(input,defaultTheme,hooks(),async(...args)=>{requests++;return fakeFetch(...args);}),files=unzipSync(out.bytes);
 assert.equal(requests,4);assert.equal(Object.keys(files).filter(p=>p.endsWith('/index.html')).length,2);
 assert.ok(Object.keys(files).every(p=>!p.split('/').includes('..')));assert.doesNotMatch(text(files,'index.html'),/<script>/);
 assert.equal(Object.keys(files).filter(p=>p.startsWith('avatars/')&&!p.endsWith('/')).length,1);
});
test('unavailable and oversized media are reported while original links remain available',async()=>{
 const out=await buildArchive(plan,defaultTheme,hooks(),async url=>url.includes('/attachments/')?new Response('gone',{status:404}):new Response(png),{file:10,total:100,files:20});
 const files=unzipSync(out.bytes),report=JSON.parse(text(files,'media-report.json'));
 assert.equal(out.downloaded,0);assert.equal(out.missed,4);assert.ok(report.unavailable.some(r=>r.reason==='HTTP 404'));
 const page=Object.keys(files).find(p=>p.startsWith('conversations/')&&p.endsWith('index.html'));
 assert.match(text(files,page),/https:\/\/cdn.discordapp.com\/attachments\//);
});
test('archive limits also include duplicated media stored in separate conversation folders',async()=>{
 const input={...plan,channels:[...plan.channels,{id:channel2,name:'Second DM'}],messages:[message,{...message,id:'1420000000000000001',channel_id:channel2}]};
 const out=await buildArchive(input,defaultTheme,hooks(),fakeFetch,{file:png.length,total:png.length*4,files:20}),files=unzipSync(out.bytes),report=JSON.parse(text(files,'media-report.json'));
 assert.ok(out.missed>0);assert.ok(report.storedBytes<=png.length*4);
});
test('external websites are not crawled, and cancellation prevents producing an archive',async()=>{
 const input={...plan,messages:[{...message,attachments:[{id:'555555555555555555',filename:'external.png',url:'https://example.com/private.png',content_type:'image/png'}]}]};
 await buildArchive(input,defaultTheme,hooks(),async(url,options)=>{assert.equal(new URL(url).hostname,'cdn.discordapp.com');return fakeFetch(url,options);});
 const h=hooks();let calls=0;
 await assert.rejects(buildArchive(plan,defaultTheme,h,async(...args)=>{calls++;h.aborter.abort(Error('Account changed.'));return fakeFetch(...args);}),/Account changed/);
 assert.equal(calls,1);
});
test('browser-blocked files use the desktop fallback, and unavailable files get a readable report',async()=>{
 let calls=0;const h={...hooks(),fallback:async(url,max,signal)=>{calls++;assert.equal(signal.aborted,false);if(url.includes('/attachments/'))throw Error('Desktop download: HTTP 404');return png;}};
 const out=await buildArchive(plan,defaultTheme,h,async()=>{throw new TypeError('Failed to fetch');}),files=unzipSync(out.bytes);
 assert.equal(calls,4);assert.equal(out.downloaded,3);assert.equal(out.missed,1);assert.ok(files['media-report.html']);
 assert.match(text(files,'media-report.html'),/photo.png/);assert.match(text(files,'media-report.html'),/HTTP 404/);assert.match(text(files,'media-report.html'),/Example DM/);
 const page=Object.keys(files).find(p=>p.startsWith('conversations/')&&p.endsWith('index.html'));assert.match(text(files,page),/View download report/);
});
