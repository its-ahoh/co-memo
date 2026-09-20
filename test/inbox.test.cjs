const {test}=require('node:test');const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync,symlinkSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');
const {MemoryEngine,Catalog}=require('../dist');const {Inbox}=require('../dist/inbox');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'co-memo-inbox-')),db=join(dir,'memory.sqlite');const engine=new MemoryEngine(db),catalog=new Catalog(db);const agent=catalog.add('agents','Writer'),project=catalog.add('projects','Project');let inbox=new Inbox(db,engine,catalog);return{dir,db,engine,catalog,agent,project,get inbox(){return inbox;},restart(){inbox.close();inbox=new Inbox(db,engine,catalog);},close(){inbox.close();engine.close();catalog.close();rmSync(dir,{recursive:true,force:true});}};}
test('file imports require stable snapshots, preserve provenance and never auto-activate or delete',()=>{const f=fixture();try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'Use short answers.\n\nKeep tests focused.');
 const source=f.inbox.add(path,{agentId:f.agent.id,projectId:f.project.id});f.inbox.scan();assert.equal(f.engine.list().length,0);f.inbox.scan();assert.equal(f.engine.list().length,2);
 for(const m of f.engine.list()){assert.equal(m.state,'candidate');assert.equal(m.audience,'private');assert.equal(m.evidence.filePath,path);assert.equal(m.projectId,f.project.id);}
 f.inbox.scan();assert.equal(f.engine.list().length,2);
 const first=f.engine.list().find(m=>m.content==='Use short answers.');f.engine.revise(first.id,1,{state:'active'},'user:confirm');
 writeFileSync(path,'Use detailed answers.\n\nKeep tests focused.');f.inbox.scan();f.inbox.scan();assert.equal(f.engine.list().length,3);assert.equal(f.engine.get({agentId:f.agent.id,projectId:f.project.id},first.id).state,'active');
 assert.match(f.inbox.sources()[0].previous,/short/);assert.match(f.inbox.sources()[0].content,/detailed/);
 f.restart();f.inbox.scan();assert.equal(f.engine.list().length,3);
 f.inbox.enable(source.id,false);writeFileSync(path,'Do not import while paused.');f.inbox.scan();f.inbox.scan();assert.equal(f.engine.list().length,3);
 f.inbox.enable(source.id,true);f.inbox.scan();f.inbox.scan();assert.equal(f.engine.list().length,4);
 rmSync(path);f.inbox.scan();assert.ok(f.inbox.sources()[0].error);assert.equal(f.engine.list().length,4);
}finally{f.close();}});
test('unread versions survive restart and stale acknowledgements never hide newer changes',()=>{const f=fixture();try{
 const m=f.engine.recordPrivate({agentId:f.agent.id},{kind:'lesson',content:'A lesson',evidence:{source:'assistant',eventId:'test',excerpt:'A quote'}});
 assert.equal(f.inbox.seen()[m.id],undefined);f.inbox.mark(m.id,1);f.restart();assert.equal(f.inbox.seen()[m.id],1);
 f.engine.revise(m.id,1,{content:'A better lesson'},'user:edit');assert.equal(f.inbox.seen()[m.id],1);f.inbox.mark(m.id,2);f.inbox.mark(m.id,1);assert.equal(f.inbox.seen()[m.id],2);
 assert.throws(()=>f.inbox.mark(m.id,99));assert.throws(()=>f.inbox.mark('missing',1));
}finally{f.close();}});
test('watcher rejects unregistered scope, symlinks and oversized files and checks archived agents',()=>{const f=fixture();try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'A lesson');const actor={agentId:f.agent.id};
 assert.throws(()=>f.inbox.add(path,{agentId:'missing'}));assert.throws(()=>f.inbox.add('relative.md',actor));
 const link=join(f.dir,'link.md');symlinkSync(path,link);assert.throws(()=>f.inbox.add(link,actor));
 f.inbox.add(path,actor);assert.throws(()=>f.inbox.add(path,actor));f.inbox.scan();writeFileSync(path,'x'.repeat(65537));f.inbox.scan();assert.equal(f.engine.list().length,0);assert.match(f.inbox.sources()[0].error,/64 KiB/);
 writeFileSync(path,'A lesson');f.catalog.edit('agents',f.agent.id,1,{archived:true});f.inbox.scan();f.inbox.scan();assert.equal(f.engine.list().length,0);assert.match(f.inbox.sources()[0].error,/archived/);
}finally{f.close();}});

test('clearing, deletion and restoration create durable reviewable changes without erasing memories',()=>{const f=fixture();try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'Keep this lesson.');const source=f.inbox.add(path,{agentId:f.agent.id});
 f.inbox.scan();f.inbox.scan();f.inbox.reviewSource(source.id,1);
 writeFileSync(path,'');f.inbox.scan();f.inbox.scan();let s=f.inbox.sources()[0];assert.equal(s.change.kind,'cleared');assert.deepEqual(s.change.removed,['Keep this lesson.']);assert.equal(s.version,2);assert.equal(s.reviewedVersion,1);
 rmSync(path);f.inbox.scan();f.inbox.scan();s=f.inbox.sources()[0];assert.equal(s.change.kind,'deleted');assert.equal(s.version,3);f.inbox.scan();assert.equal(f.inbox.sources()[0].version,3);
 f.restart();writeFileSync(path,'Keep this lesson.');f.inbox.scan();f.inbox.scan();s=f.inbox.sources()[0];assert.equal(s.change.kind,'restored');assert.equal(s.version,4);assert.equal(s.error,undefined);assert.equal(f.engine.list().length,1);
 f.inbox.reviewSource(source.id,4);f.inbox.reviewSource(source.id,2);assert.equal(f.inbox.sources()[0].reviewedVersion,4);assert.throws(()=>f.inbox.reviewSource(source.id,5));
}finally{f.close();}});
test('atomic file replacements and concurrent scanner instances do not duplicate imports',()=>{const f=fixture();const second=new Inbox(f.db,f.engine,f.catalog);try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'Old paragraph');f.inbox.add(path,{agentId:f.agent.id});f.inbox.scan();second.scan();f.inbox.scan();second.scan();assert.equal(f.engine.list().length,1);assert.equal(f.inbox.sources()[0].version,1);
 const temp=join(f.dir,'replacement.md');writeFileSync(temp,'New paragraph');require('node:fs').renameSync(temp,path);second.scan();f.inbox.scan();second.scan();f.inbox.scan();assert.equal(f.engine.list().length,2);assert.equal(f.inbox.sources()[0].version,2);
}finally{second.close();f.close();}});
test('standalone watcher imports and observes updates without HTTP, then stops on SIGTERM',async()=>{const f=fixture();let child;try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'First standalone lesson');const cli=join(__dirname,'../dist/cli.js');
 const added=require('node:child_process').spawnSync(process.execPath,[cli,'source-add','--db',f.db,'--agent',f.agent.id,'--file',path],{encoding:'utf8'});assert.equal(added.status,0,added.stderr);
 child=require('node:child_process').spawn(process.execPath,[cli,'watch','--db',f.db,'--interval','60000'],{stdio:['ignore','pipe','pipe']});let output='',error='',updated=false;
 child.stderr.on('data',b=>error+=b);
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('Watcher timeout: '+output+error));},8000);
 child.stdout.on('data',b=>{output+=b;if(output.includes('"change":"imported"')&&!updated){updated=true;writeFileSync(path,'Second standalone lesson');}if(output.includes('"change":"modified"')&&!child.killed)child.kill('SIGTERM');});
 child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);try{assert.equal(code,0,error);assert.match(output,/"status":"stopped"/);assert.equal(f.engine.list().length,2);resolve();}catch(e){reject(e);}});});
}finally{if(child&&!child.killed)child.kill();f.close();}});

test('interrupted changes must become stable again before import',()=>{const f=fixture();try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'Baseline');f.inbox.add(path,{agentId:f.agent.id});f.inbox.scan();f.inbox.scan();
 writeFileSync(path,'Transient edit');f.inbox.scan();writeFileSync(path,'Baseline');f.inbox.scan();writeFileSync(path,'Transient edit');f.inbox.scan();assert.equal(f.engine.list().length,1);f.inbox.scan();assert.equal(f.engine.list().length,2);
}finally{f.close();}});

test('hook-only dashboard leaves files untouched until a one-shot scanner is invoked',async()=>{const f=fixture();const prior=process.env.CO_MEMO_WATCH;let server;try{
 const path=join(f.dir,'MEMORY.md');writeFileSync(path,'Import only on the hook.');f.inbox.add(path,{agentId:f.agent.id});process.env.CO_MEMO_WATCH='0';server=require('../dist/server').createMemoryServer(f.db);
 if(prior===undefined)delete process.env.CO_MEMO_WATCH;else process.env.CO_MEMO_WATCH=prior;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>setTimeout(resolve,700));assert.equal(f.engine.list().length,0);
 const result=require('node:child_process').spawnSync(process.execPath,[join(__dirname,'../dist/cli.js'),'watch','--db',f.db,'--once'],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"status":"stopped"/);assert.equal(f.engine.list().length,1);
}finally{if(prior===undefined)delete process.env.CO_MEMO_WATCH;else process.env.CO_MEMO_WATCH=prior;if(server)await new Promise(resolve=>server.close(resolve));f.close();}});
