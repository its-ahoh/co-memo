const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {spawnSync}=require('node:child_process');
const {MemoryEngine,Catalog}=require('../dist');
const cli=join(__dirname,'../dist/cli.js');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'co-memo-cli-'));const db=join(dir,'memory.sqlite');const engine=new MemoryEngine(db),catalog=new Catalog(db);const a=catalog.add('agents','A'),b=catalog.add('agents','B'),p=catalog.add('projects','P');return{dir,db,engine,catalog,a,b,p,close(){catalog.close();engine.close();rmSync(dir,{recursive:true,force:true});}};}
function run(args,input=''){return spawnSync(process.execPath,[cli,...args],{input,encoding:'utf8',timeout:10000});}
test('CLI proposal, scope isolation and fresh reads across independent invocations',()=>{const f=fixture();try{
 const scope=['--db',f.db,'--agent',f.a.id,'--project',f.p.id];
 const proposed=run(['propose',...scope,'--content','Prefer short answers','--evidence','User requested short answers']);assert.equal(proposed.status,0,proposed.stderr);const m=JSON.parse(proposed.stdout);assert.equal(m.audience,'private');assert.equal(m.state,'candidate');
 assert.equal(JSON.parse(run(['recall',...scope,'--json']).stdout).entries.length,0);
 f.engine.revise(m.id,1,{state:'active'},'user:confirm');
 assert.equal(JSON.parse(run(['recall',...scope,'--json']).stdout).entries[0].id,m.id);
 assert.equal(run(['get','--db',f.db,'--agent',f.b.id,'--project',f.p.id,'--id',m.id]).status,1);
 f.engine.revise(m.id,2,{audience:'shared',sharedWith:[f.b.id]},'user:share');
 assert.equal(JSON.parse(run(['get','--db',f.db,'--agent',f.b.id,'--project',f.p.id,'--id',m.id]).stdout).version,3);
 assert.equal(run(['get','--db',f.db,'--agent',f.b.id,'--id',m.id]).status,1);
}finally{f.close();}});
test('hooks bind identity from config, reject forged input and skip empty extraction',()=>{const f=fixture();try{
 const config=join(f.dir,'host.json');writeFileSync(config,JSON.stringify({db:'memory.sqlite',agentId:f.a.id,projectId:f.p.id,stageId:'stage-build',purposeId:'purpose-knowledge'}));
 const end=input=>run(['hook-end','--config',config],JSON.stringify(input));
 assert.equal(JSON.parse(end({}).stdout).status,'skipped');assert.equal(f.engine.list().length,0);
 for(const input of [{agentId:f.b.id,content:'bad',evidence:'quote'},{content:'bad',evidence:'quote',audience:'global'},{content:'missing evidence'},{content:'bad',evidence:'quote',state:'active'}])assert.equal(end(input).status,1);
 const m=JSON.parse(end({content:'Validate inputs',evidence:'Observed invalid inputs'}).stdout);assert.equal(m.ownerId,f.a.id);assert.equal(m.stageId,'stage-build');assert.deepEqual(m.purposeIds,['purpose-knowledge']);assert.equal(m.state,'candidate');
 const start=input=>run(['hook-start','--config',config],JSON.stringify(input));
 assert.deepEqual(JSON.parse(start({query:'inputs'}).stdout).memories,[]);
 f.engine.revise(m.id,1,{state:'active'},'user:confirm');assert.equal(JSON.parse(start({query:'inputs'}).stdout).memories[0].version,2);
 assert.equal(start({query:'inputs',agentId:f.b.id}).status,1);
 f.catalog.edit('agents',f.a.id,1,{archived:true});assert.equal(start({query:'inputs'}).status,1);
}finally{f.close();}});
test('CLI refuses typo databases, invalid options and oversized hook input',()=>{const f=fixture();try{
 const absent=join(f.dir,'typo.sqlite');assert.equal(run(['catalog','--db',absent]).status,1);assert.equal(existsSync(absent),false);
 assert.equal(run(['recall','--db',f.db,'--agent',f.a.id,'--audience','global']).status,1);
 assert.equal(run(['catalog','--db',f.db,'--db',f.db]).status,1);
 const config=join(f.dir,'host.json');writeFileSync(config,JSON.stringify({db:f.db,agentId:f.a.id}));
 assert.equal(run(['hook-end','--config',config],JSON.stringify({content:'x'.repeat(66000),evidence:'q'})).status,1);
 assert.equal(run(['hook-start','--config',config],'invalid-json').status,1);
 assert.equal(f.engine.list().length,0);
}finally{f.close();}});
