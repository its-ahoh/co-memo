const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { MemoryEngine, Catalog, callMemoryTool, MemoryLearner } = require('../dist');
const { createMemoryServer } = require('../dist/server');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'co-memo-test-')); const file=join(dir,'memory.sqlite');
  const engine=new MemoryEngine(file); const catalog=new Catalog(file);
  const a=catalog.add('agents','Writer'); const b=catalog.add('agents','Reviewer'); const c=catalog.add('agents','Other');
  const project=catalog.add('projects','Launch');
  const note=(content,overrides={})=>({ownerId:a.id,audience:'private',kind:'preference',state:'active',content,evidence:{eventId:content,source:'user',excerpt:content},...overrides});
  return {dir,file,engine,catalog,a,b,c,project,note,close(){engine.close();catalog.close();rmSync(dir,{recursive:true,force:true});}};
}
test('selected-agent sharing remains constrained by project, stage and purpose',()=>{
  const f=fixture();try {
    const shared=f.engine.add(f.note('Use concise headings',{audience:'shared',sharedWith:[f.b.id],projectId:f.project.id,stageId:'stage-build',purposeIds:['purpose-preferences']}));
    const actor={agentId:f.b.id,projectId:f.project.id,stageId:'stage-build',purposeId:'purpose-preferences'};
    assert.equal(f.engine.get(actor,shared.id).id,shared.id);
    for(const bad of [{...actor,agentId:f.c.id},{...actor,projectId:undefined},{...actor,stageId:'stage-explore'},{...actor,purposeId:'purpose-decisions'}]){
      assert.equal(f.engine.get(bad,shared.id),undefined);assert.equal(f.engine.recall(bad,'concise').length,0);
    }
    assert.equal(f.engine.get({...actor,agentId:f.a.id},shared.id).id,shared.id);
    f.engine.add(f.note('Shared within this project',{audience:'global',projectId:f.project.id}));
    assert.equal(f.engine.recall({agentId:f.c.id,projectId:f.project.id},'').length,1);
    assert.equal(f.engine.recall({agentId:f.c.id},'').length,0);
  }finally{f.close();}
});
test('classification is independent of lifecycle and deduplication scopes',()=>{
  const f=fixture();try {
    const one=f.engine.add(f.note('Review requirements',{stageId:'stage-explore'}));
    const two=f.engine.add(f.note('Review requirements',{stageId:'stage-build'}));
    assert.notEqual(one.id,two.id);
    assert.throws(()=>f.engine.add(f.note('Requirements review',{stageId:'stage-build',duplicateOf:one.id,relatedVersion:1})),/scope/);
    f.engine.revise(two.id,1,{state:'candidate'},'review');
    assert.equal(f.engine.recall({agentId:f.a.id,stageId:'stage-build'},'').length,0);
    f.engine.revise(one.id,1,{state:'forgotten'},'forget');
    assert.equal(f.engine.add(f.note('Review requirements',{stageId:'stage-explore'})).state,'forgotten');
  }finally{f.close();}
});
test('renaming taxonomy preserves stable references and rejects stale edits',()=>{
  const f=fixture();try {
    f.engine.add(f.note('Launch preference',{projectId:f.project.id,stageId:'stage-build'}));
    f.catalog.edit('projects',f.project.id,1,{name:'Release'});
    f.catalog.edit('stages','stage-build',1,{name:'Implementation'});
    assert.equal(f.engine.list()[0].projectId,f.project.id);
    assert.equal(f.catalog.get('projects',f.project.id).name,'Release');
    assert.throws(()=>f.catalog.edit('projects',f.project.id,1,{name:'Old'}),/changed/);
    assert.throws(()=>f.catalog.validateMemory(f.note('bad',{stageId:'missing'})),/not found/);
  }finally{f.close();}
});
test('agent tools cannot change identity or promote a candidate',()=>{
  const f=fixture();try {
    const actor={agentId:f.a.id,projectId:f.project.id,stageId:'stage-build',purposeId:'purpose-knowledge'};
    assert.throws(()=>callMemoryTool(f.engine,actor,'memory_record',{content:'A note',evidence:'Observed a note',agentId:f.b.id}),/identity/);
    const m=callMemoryTool(f.engine,actor,'memory_record',{content:'Use validation',evidence:'Observed missing validation'});
    assert.equal(m.state,'candidate');assert.equal(m.audience,'private');assert.equal(m.stageId,'stage-build');assert.deepEqual(m.purposeIds,['purpose-knowledge']);
    assert.equal(f.engine.recall(actor,'validation').length,0);
  }finally{f.close();}
});
test('learning keeps classifications host-bound and candidates private',async()=>{
  const f=fixture();try {
    const learner=new MemoryLearner(f.engine);
    const prompt='Remember to prefer brief answers';
    learner.enqueue({agentId:f.a.id,projectId:f.project.id,stageId:'stage-build',purposeId:'purpose-preferences',eventId:'learning',prompt,output:'Noted',success:true},async()=>({memories:[{content:'Prefer brief answers',quote:prompt,source:'user',kind:'preference',lifetime:'durable',relation:'new',audience:'global',stageId:'stage-explore'}]}));
    await learner.flush(); const m=f.engine.list()[0];
    assert.equal(m.ownerId,f.a.id);assert.equal(m.stageId,'stage-build');assert.equal(m.audience,'private');assert.deepEqual(m.purposeIds,['purpose-preferences']);
  }finally{f.close();}
});
test('HTTP app supports management, scoped recall, export and local request protection',async()=>{
  const f=fixture();const server=createMemoryServer(f.file);try {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
    const html=await(await fetch(base)).text();const token=html.match(/name="memory-session" content="([^"]+)"/)[1];
    const send=(url,method,body,extra={})=>fetch(base+url,{method,headers:{origin:base,'content-type':'application/json','x-memory-token':token,...extra},body:JSON.stringify(body)});
    assert.equal((await send('/api/memories','POST',{}, {'x-memory-token':'wrong'})).status,403);
    assert.equal((await send('/api/demo/record','POST',{agentId:f.a.id,content:'demo'})).status,403);
    assert.match(await(await fetch(base+'/demo')).text(),/Co-memo/);
    assert.equal((await send('/api/memories','POST',{}, {origin:'https://evil.example'})).status,403);
    const rejectedHost=await new Promise((resolve,reject)=>{const req=require('node:http').get(base+'/api/state',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rejectedHost,403);
    const created=await send('/api/memories','POST',{ownerId:f.a.id,audience:'shared',sharedWith:[f.b.id],projectId:f.project.id,stageId:'stage-build',purposeIds:['purpose-knowledge'],kind:'fact',content:'Validation uses Zod',state:'active'});
    assert.equal(created.status,201);const m=await created.json();
    const recall=await(await send('/api/recall','POST',{agentId:f.b.id,projectId:f.project.id,stageId:'stage-build',purposeId:'purpose-knowledge',query:'Validation'})).json();assert.equal(recall.entries[0].id,m.id);
    assert.equal((await send('/api/memories/'+m.id,'PATCH',{version:1,patch:{content:'Validation uses schemas'}})).status,200);
    assert.equal((await send('/api/memories/'+m.id,'PATCH',{version:1,patch:{content:'stale'}})).status,409);
    assert.equal((await(await fetch(base+'/api/memories/'+m.id+'/history')).json()).length,2);
    const exported=await(await fetch(base+'/api/export')).json();assert.equal(exported.format,'co-memo-v1');assert.equal(exported.memories.length,1);
    assert.equal((await send('/api/memories/'+m.id,'PATCH',{version:2,patch:{state:'forgotten'}})).status,200);
    assert.equal((await(await send('/api/recall','POST',{agentId:f.b.id,projectId:f.project.id,query:''})).json()).entries.length,0);
  }finally{await new Promise(r=>server.close(r));f.close();}
});
test('MCP subprocess runs independently of Codey with a fixed registered identity',async()=>{
  const f=fixture();try {
    f.engine.add(f.note('Private note'));
    const child=spawn(process.execPath,[join(__dirname,'../dist/engine/mcp.js'),'--db',f.file,'--agent',f.b.id],{stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_search',arguments:{query:'note'}}})+'\n');
    const exit=await new Promise((r,j)=>{child.on('close',r);child.on('error',j);});assert.equal(exit,0);
    assert.deepEqual(JSON.parse(JSON.parse(output).result.content[0].text),[]);
  }finally{f.close();}
});

test('two persistent MCP clients see committed sharing, revisions and withdrawal on their next read',async()=>{
  const f=fixture();const children=[];
  function client(agentId){
    const child=spawn(process.execPath,[join(__dirname,'../dist/engine/mcp.js'),'--db',f.file,'--agent',agentId,'--project',f.project.id],{stdio:['pipe','pipe','pipe']});children.push(child);child.stderr.resume();
    let seq=0,buffer='';const pending=new Map();
    child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const job=pending.get(message.id);if(job){pending.delete(message.id);clearTimeout(job.timer);job.resolve(message);}}});
    return async(name,args)=>{const id=++seq;const message=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP response timeout'));},5000);pending.set(id,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');});assert.ok(!message.result.isError,JSON.stringify(message));return JSON.parse(message.result.content[0].text);};
  }
  try{
    const claude=client(f.a.id),codex=client(f.b.id);
    assert.deepEqual(await codex('memory_search',{query:'handoff'}),[]);
    const draft=await claude('memory_record',{content:'handoff: write short explanations',evidence:'User asked for concise explanations'});
    assert.deepEqual(await codex('memory_search',{query:'handoff'}),[]);
    const published=f.engine.revise(draft.id,draft.version,{state:'active',audience:'shared',sharedWith:[f.b.id]},'user:share');
    const snapshot=await codex('memory_get',{id:draft.id});assert.equal(snapshot.version,published.version);
    const revised=f.engine.revise(draft.id,published.version,{content:'handoff: explain tradeoffs first'},'user:edit');
    assert.equal(snapshot.content,'handoff: write short explanations');
    assert.equal((await codex('memory_get',{id:draft.id})).content,revised.content);
    assert.throws(()=>f.engine.revise(draft.id,snapshot.version,{content:'stale edit'},'user:edit'),/changed|stale/);
    f.engine.revise(draft.id,revised.version,{state:'forgotten'},'user:forget');
    assert.deepEqual(await codex('memory_search',{query:'handoff'}),[]);
  }finally{await Promise.all(children.map(child=>new Promise(resolve=>{child.once('close',resolve);child.stdin.end();})));f.close();}
});
