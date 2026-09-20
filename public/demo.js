const el=id=>document.getElementById(id);
const token=document.querySelector('meta[name=memory-session]').content;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let step=1,ready=false,busy=false,owner,recipient,project,memory,recalled;
let note='Start with the conclusion, then explain the tradeoffs.';
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Memory-Token':token},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(value.error||'Request failed');return value;}
function render(focus=false){
  document.querySelectorAll('[data-step]').forEach(item=>{const n=Number(item.dataset.step);item.classList.toggle('done',n<step);if(n===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});
  const flow='<div class="flow"><span class="agent">Claude Code</span><span aria-hidden="true">→</span><span class="agent">Codex</span></div>';
  let content;
  if(step===1)content=`<p class="eyebrow">Step 1 · Remember</p><h1 id="step-title" tabindex="-1">Tell your agent once.</h1><p class="description">Give Claude Code one preference worth keeping.</p><label for="note">Your preference</label><textarea id="note" maxlength="2400" ${memory?'readonly':''}>${esc(note)}</textarea><div class="actions"><button class="primary" id="next">${memory?'Continue':'Save this memory'}</button></div>`;
  else if(step===2)content=`<p class="eyebrow">Step 2 · Share</p><h1 id="step-title" tabindex="-1">You choose who knows.</h1><p class="description">${memory.state==='candidate'?'This note is private. Approve it to let Codex use it too.':'This note is now shared with Codex.'}</p><blockquote class="note">${esc(memory.content)}</blockquote>${flow}<div class="actions"><button class="back" id="back">Back</button><button class="primary" id="next">${memory.state==='candidate'?'Share with Codex':'Continue'}</button></div>`;
  else if(!recalled)content=`<p class="eyebrow">Step 3 · Continue</p><h1 id="step-title" tabindex="-1">Switch agents. Keep context.</h1><p class="description">Codex can now look up the preference you shared.</p>${flow}<div class="actions"><button class="back" id="back">Back</button><button class="primary" id="next">Let Codex read it</button></div>`;
  else content=`<span class="success">✓ Memory received</span><h1 id="step-title" tabindex="-1">No need to explain again.</h1><p class="description">Codex retrieved your preference from Co-memo.</p><blockquote class="note">${esc(recalled.content)}</blockquote><div class="actions"><button class="again" id="again">Try again</button><a class="result-link" href="/">Explore the library ↗</a></div>`;
  el('stage').innerHTML=content;
  const input=el('note');if(input)input.oninput=()=>{note=input.value;el('next').disabled=!ready||!note.trim();};
  const back=el('back');if(back)back.onclick=()=>{step--;el('error').textContent='';render(true);};
  const again=el('again');if(again)again.onclick=()=>{step=1;owner=recipient=project=memory=recalled=undefined;el('error').textContent='';render(true);};
  const next=el('next');if(next){next.disabled=!ready||busy||!note.trim();next.onclick=advance;}
  if(focus)el('step-title').focus();
}
async function advance(){
  if(busy)return;busy=true;el('error').textContent='';el('next').disabled=true;el('next').textContent='Working…';if(el('back'))el('back').disabled=true;
  try{
    if(step===1){
      // Reuse completed setup operations when retrying a failed request.
      owner??=await api('/api/catalog/agents','POST',{name:'Claude Code · demo'});
      recipient??=await api('/api/catalog/agents','POST',{name:'Codex · demo'});
      project??=await api('/api/catalog/projects','POST',{name:'Handoff demo '+new Date().toLocaleTimeString()});
      memory??=await api('/api/demo/record','POST',{agentId:owner.id,projectId:project.id,content:note});step=2;
    }else if(step===2){if(memory.state==='candidate')memory=await api('/api/memories/'+memory.id,'PATCH',{version:memory.version,patch:{state:'active',audience:'shared',sharedWith:[recipient.id]}});step=3;
    }else{const result=await api('/api/recall','POST',{agentId:recipient.id,projectId:project.id,query:memory.content});recalled=result.entries.find(m=>m.id===memory.id);if(!recalled)throw Error('This memory is no longer available. Review its status in the library.');}
  }catch(e){el('error').textContent=e.message;}finally{busy=false;render(true);}
}
render();
api('/api/state').then(state=>{ready=state.demo;el('setup-note').textContent=state.demo?'Demo data is stored locally in .data/demo.sqlite.':'Run npm install, then npm run demo to enable this walkthrough.';if(!ready)el('error').textContent='Start the demo server with npm run demo to try these steps.';render();}).catch(e=>el('error').textContent=e.message);
