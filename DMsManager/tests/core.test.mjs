import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild');
const temp=await mkdtemp(join(tmpdir(),'dms-manager-'));
await build({entryPoints:[fileURLToPath(new URL('../core.ts',import.meta.url))],outfile:join(temp,'core.cjs'),bundle:true,platform:'node',format:'cjs'});
await build({entryPoints:[fileURLToPath(new URL('../export.ts',import.meta.url))],outfile:join(temp,'export.cjs'),bundle:true,platform:'node',format:'cjs'});
const {Job,snowflakeAt,normalizeMessage,describeError}=require(join(temp,'core.cjs'));
const {renderExport,defaultTheme,guildTag,safeUrl}=require(join(temp,'export.cjs'));
after(()=>rm(temp,{recursive:true,force:true}));
const owner='1113854342517243904',other='222222222222222222',channel='333333333333333333';
const time=Date.parse('2026-10-20T12:00:00Z'),range={after:time-86400000,before:time+86400000};
const message=(n=1,author=owner,type=0)=>({id:(BigInt(snowflakeAt(time))+BigInt(n)).toString(),channel_id:channel,author:{id:author,username:'Perish'},type,content:'hello',timestamp:new Date(time).toISOString()});
function fixture(rows=[message()]){
 let current=owner,calls=0;const deleted=[],delays=[];
 const api={owner:()=>current,privateChannel:()=>true,page:async()=>++calls===1?rows:[],message:async(c,id)=>rows.find(m=>m.id===id),remove:async(c,id)=>{deleted.push([c,id]);}};
 const job=new Job(api,()=>{},1000);job.sleep=async ms=>{job.assertAccount();delays.push(ms);};
 return{api,job,deleted,delays,switch:()=>current=other};
}
const scope=[{id:channel,name:'My DM'}];
test('Discord response objects display the actual HTTP status and message',()=>{
 assert.equal(describeError({status:405,body:{message:'Method not allowed',code:0}}),'Method not allowed (HTTP 405, code 0)');
 assert.equal(describeError({response:{status:403,body:{message:'Missing Access',code:50001}}}),'Missing Access (HTTP 403, code 50001)');
 assert.equal(describeError(Error('Account changed.')),'Account changed.');
});
test('preview includes only own ordinary messages/replies and performs no deletes',async()=>{
 const f=fixture([message(5),message(4,other),message(3,owner,19),message(2,owner,7)]);
 const plan=await f.job.scan(scope,range,'purge');assert.equal(plan.scanned,4);assert.equal(plan.messages.length,2);assert.equal(plan.ownCount,2);assert.deepEqual(f.deleted,[]);
 await f.job.purge(plan);assert.equal(f.deleted.length,2);assert.ok(f.deleted.every(([,id])=>[message(5).id,message(3).id].includes(id)));
});
test('export reads every author; date bounds and snapshots exclude outside messages',async()=>{
 const rows=[message(5),message(4,other),{...message(3),timestamp:new Date(range.before).toISOString()},{...message(2),timestamp:new Date(range.after-1).toISOString()}];
 const f=fixture(rows);const plan=await f.job.scan(scope,range,'export');assert.equal(plan.messages.length,2);assert.deepEqual(f.deleted,[]);
});
test('forged preview owner, foreign candidates and guild channels are refused',async()=>{
 const f=fixture();const plan=await f.job.scan(scope,range,'purge');
 await assert.rejects(f.job.purge({...plan,owner:other}),/another account/);
 await assert.rejects(f.job.purge({...plan,messages:[message(2,other)]}),/invalid candidate/);
 f.api.privateChannel=()=>false;await assert.rejects(f.job.purge(plan),/accessible DM/);assert.deepEqual(f.deleted,[]);
});
test('fresh ownership verification prevents a delete even if a preview was stale or altered',async()=>{
 const f=fixture();const plan=await f.job.scan(scope,range,'purge');f.api.message=async()=>message(1,other);
 await assert.rejects(f.job.purge(plan),/ownership/);assert.deepEqual(f.deleted,[]);
});
test('account switch during verification sends no delete request',async()=>{
 const f=fixture();const plan=await f.job.scan(scope,range,'purge');f.api.message=async()=>{f.switch();return message();};
 await assert.rejects(f.job.purge(plan),/Account changed/);assert.deepEqual(f.deleted,[]);
});
test('account switch during a history request cannot return a usable plan',async()=>{
 const f=fixture();f.api.page=async()=>{f.switch();return[message()];};await assert.rejects(f.job.scan(scope,range,'purge'),/Account changed/);
});
test('cancel wakes a paused job and prevents any history requests',async()=>{
 const f=fixture();let reads=0;f.api.page=async()=>{reads++;return[];};f.job.pause();const pending=f.job.scan(scope,range,'purge');
 await Promise.resolve();f.job.cancel('Stopped');await assert.rejects(pending,/Stopped/);assert.equal(reads,0);
});
test('rate limits respect retry_after and resume sequentially',async()=>{
 const f=fixture();let reads=0;f.api.page=async()=>{if(++reads===1)throw{status:429,body:{retry_after:3}};return[];};
 await f.job.scan(scope,range,'purge');assert.equal(reads,2);assert.ok(f.delays.includes(3000));
});
test('missing messages are counted; other errors stop further deletions',async()=>{
 const f=fixture([message(2),message(1)]),plan=await f.job.scan(scope,range,'purge');f.api.message=async()=>{throw{status:404};};await f.job.purge(plan);assert.equal(f.job.progress.missing,2);assert.equal(f.deleted.length,0);
 const g=fixture([message(2),message(1)]),p=await g.job.scan(scope,range,'purge');let attempts=0;g.api.remove=async()=>{attempts++;throw{status:403};};await assert.rejects(g.job.purge(p));assert.equal(attempts,1);
});
test('invalid pages, scan limits and repeated pagination cannot start deletion',async()=>{
 const f=fixture([message(2),message(1)]);await assert.rejects(f.job.scan(scope,range,'purge',1),/Scan limit/);
 const g=fixture();g.api.page=async()=>[message()];await assert.rejects(g.job.scan(scope,range,'purge'),/stopped advancing/);
 const h=fixture();h.api.page=async()=>({message:'unauthorized'});await assert.rejects(h.job.scan(scope,range,'purge'),/unexpected/);
 assert.equal(f.deleted.length+g.deleted.length+h.deleted.length,0);
});
test('normalization excludes account-private fields from archives',()=>{
 const raw={...message(),token:'bad-secret',author:{...message().author,email:'private@example.com',phone:'secret',token:'secret'}};
 const clean=JSON.stringify(normalizeMessage(raw,channel));assert.doesNotMatch(clean,/bad-secret|private@example|phone|token/);
});
test('HTML includes visible guild tag text/badge and excludes removed tags',async()=>{
 const m=message();m.author.primary_guild={identity_guild_id:'444444444444444444',identity_enabled:true,tag:'TEST',badge:'a'.repeat(32)};
 const f=fixture([m]),plan=await f.job.scan(scope,range,'export');const html=renderExport(plan,{...defaultTheme,background:'#102030',font:'Example Font'});
 assert.match(html,/clan-badges\/444444444444444444\/a{32}\.png/);assert.match(html,/>TEST<\/span>/);assert.match(html,/#102030/);assert.match(html,/Example Font/);
 assert.equal(guildTag({...m.author,primary_guild:{...m.author.primary_guild,identity_enabled:false}}),'');
});
test('hostile content, attachment links and theme values cannot create executable HTML',async()=>{
 const m=message();m.content='<script>alert(1)</script> **hello**';m.author.username='<img src=x onerror=evil()>';
 m.attachments=[{id:'1',filename:'<bad>',url:'javascript:alert(1)',content_type:'image/png'}];
 const f=fixture([m]),plan=await f.job.scan(scope,range,'export');const html=renderExport(plan,{...defaultTheme,font:'</style><script>evil()</script>'});
 assert.doesNotMatch(html,/<script|<img src=x|src="javascript:/);assert.match(html,/&lt;script&gt;/);assert.match(html,/<strong>hello<\/strong>/);assert.match(html,/script-src 'none'/);
 assert.equal(safeUrl('javascript:alert(1)'),'');assert.equal(safeUrl('https://user:pass@example.com/a'),'');
});
test('HTML makes links clickable, keeps code literal, and supports audio and reply navigation',()=>{
 const first=message(1),reply={...message(2),content:'Visit https://example.com/a?x=1&y=2. [A link](https://example.com/b) `https://code.example/`',referenced_message:{id:first.id,content:'hello',author:first.author},attachments:[{id:'555555555555555555',filename:'voice.ogg',url:'https://cdn.discordapp.com/attachments/333333333333333333/555555555555555555/voice.ogg',content_type:'audio/ogg',size:2048}]};
 const html=renderExport({owner,channels:scope,range,messages:[first,reply],scanned:2,ownCount:2},defaultTheme);
 assert.match(html,/href="https:\/\/example.com\/a\?x=1&amp;y=2"/);assert.match(html,/href="https:\/\/example.com\/b"[^>]*>A link<\/a>/);
 assert.doesNotMatch(html,/href="https:\/\/code.example/);assert.match(html,/<audio class="media" controls/);assert.match(html,/2.0 KB/);assert.match(html,new RegExp('href="#m-'+first.id+'"'));
});
test('text-filtered server preview matches exact text and skips messages edited after scan',async()=>{
 const exact={...message(3),content:'Hi'}, substring={...message(2),content:'hi there'}, foreign={...message(1,other),content:'hi'};
 const f=fixture([exact,substring,foreign]);
 const serverScope=[{...scope[0],guildId:other}];
 let validations=0;
 f.api.validateChannel=async target=>{assert.equal(target.guildId,other);validations++;};
 const plan=await f.job.scan(serverScope,range,'purge',undefined,{text:'hi',mode:'exact'});
 assert.deepEqual(plan.messages.map(m=>m.id),[exact.id]);
 f.api.message=async()=>({...exact,content:'bye'});
 await f.job.purge(plan);
 assert.equal(f.job.progress.skipped,1);
 assert.deepEqual(f.deleted,[]);
 assert.equal(validations,2);
 const contains=await fixture([exact,substring,foreign]).job.scan(scope,range,'purge',undefined,{text:'HI',mode:'contains'});
 assert.deepEqual(contains.messages.map(m=>m.id),[exact.id,substring.id]);
});
