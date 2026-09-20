/** Synthetic preview data only. Never opens a Codey database or user agent configuration. */
import { resolve } from 'node:path';
import { Catalog } from './catalog';
import { MemoryEngine, MemoryDraft } from './engine';
import { createMemoryServer } from './server';
const filename = resolve('.data/demo.sqlite');
const catalog = new Catalog(filename); const memory = new MemoryEngine(filename);
if (!catalog.list('agents').length) {
  const planner=catalog.add('agents','Atlas','Research & planning');
  const builder=catalog.add('agents','Forge','Implementation & delivery');
  const reviewer=catalog.add('agents','Lens','Review & quality');
  const project=catalog.add('projects','Co-memo','An independent home for agent memory');
  const other=catalog.add('projects','Harbor Website','A fictional project for this demo');
  const add=(content:string, options:Partial<MemoryDraft>)=>memory.add({ownerId:planner.id,audience:'global',kind:'preference',state:'active',content,evidence:{eventId:'demo:'+content,source:'user',excerpt:'Synthetic example — '+content},...options});
  add('Keep explanations concise. Start with the decision, then explain the tradeoffs.',{purposeIds:['purpose-preferences']});
  add('Memory ownership, sharing, and project applicability are separate concepts. Changing a stage must never change who can read a note.',{projectId:project.id,stageId:'stage-build',purposeIds:['purpose-decisions'],kind:'fact'});
  add('The memory engine should work without an agent framework or a model provider. Keep the core independent of the dashboard.',{projectId:project.id,ownerId:builder.id,purposeIds:['purpose-decisions'],kind:'fact'});
  add('For accessibility reviews, check keyboard navigation before visual polish.',{ownerId:reviewer.id,audience:'shared',sharedWith:[builder.id],stageId:'stage-build',purposeIds:['purpose-knowledge']});
  add('Explore two contrasting directions before choosing the final visual language.',{projectId:other.id,stageId:'stage-explore',purposeIds:['purpose-knowledge']});
  add('Release checklist: reconnect each agent and verify its project scope.',{ownerId:builder.id,audience:'private',projectId:project.id,stageId:'stage-maintain',kind:'lesson',state:'candidate'});
  add('Harbor content approval is ready for review.',{projectId:other.id,kind:'fact',reviewAfter:Date.now()-86400000});
}
memory.close();catalog.close();process.env.CO_MEMO_DEMO='1';
const server=createMemoryServer(filename);
server.listen(Number(process.env.PORT??4317),'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`Co-memo demo: http://127.0.0.1:${address.port}/demo\nSynthetic data only.\n`);});
server.on('error',e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
process.on('SIGINT',()=>server.close());process.on('SIGTERM',()=>server.close());
