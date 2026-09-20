import { watch, FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { Inbox } from './inbox';

/** Directory events survive atomic file replacement; reconciliation recovers missed events. */
export function startFileWatcher(inbox: Inbox, interval = 30000, onScan: () => void = () => {}, onError: (error: Error) => void = () => {}) {
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('Interval must be between 250 and 60000 ms');
  const directories = new Map<string, FSWatcher>();
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const scan = () => { if (closed) return; try { inbox.scan(); onScan(); } catch (error) { onError(error as Error); } };
  const schedule = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    if (settle) clearTimeout(settle);
    debounce = setTimeout(() => { debounce = undefined; scan(); settle = setTimeout(() => { settle = undefined; scan(); }, 250); }, 200);
  };
  const refresh = () => {
    if (closed) return;
    const sources = inbox.sources().filter(s => s.enabled);
    const wanted = new Set(sources.map(s => dirname(s.path)));
    for (const [dir, watcher] of directories) if (!wanted.has(dir)) { watcher.close(); directories.delete(dir); }
    for (const dir of wanted) if (!directories.has(dir)) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          // Ignore edits to unrelated files in the same directory.
          if (!filename || inbox.sources().some(s => s.enabled && dirname(s.path) === dir && basename(s.path) === String(filename))) schedule();
        });
        watcher.on('error', error => { watcher.close(); directories.delete(dir); onError(error); });
        directories.set(dir, watcher);
      } catch (error) { onError(error as Error); }
    }
    schedule();
  };
  const reconcile = setInterval(() => { try { refresh(); } catch (error) { onError(error as Error); } }, interval);
  try { refresh(); } catch (error) { onError(error as Error); }
  return { refresh, close() { closed = true; clearInterval(reconcile); if (debounce) clearTimeout(debounce); if (settle) clearTimeout(settle); for (const watcher of directories.values()) watcher.close(); directories.clear(); } };
}

/** JSON lines contain metadata, not file content. No web server is needed. */
export async function watchFiles(inbox: Inbox, interval: number, once = false): Promise<void> {
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('Interval must be between 250 and 60000 ms');
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value)+'\n');
  const observed = new Map<string,string>();
  const report = () => { for (const s of inbox.sources()) {
    const key=JSON.stringify([s.version,s.error,s.enabled]);
    if(observed.get(s.id)!==key){observed.set(s.id,key);emit({sourceId:s.id,path:s.path,enabled:s.enabled,version:s.version??0,change:s.change?.kind,added:s.change?.added.length??0,removed:s.change?.removed.length??0,error:s.error});}
  } };
  let timer: ReturnType<typeof setTimeout> | undefined; let wake: (() => void) | undefined; let stopped=false;
  const stop = () => { stopped=true; if(timer)clearTimeout(timer); wake?.(); };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  emit({status:once?'scanning':'watching',mode:once?'once':'events',reconcileMs:interval,files:inbox.sources().filter(s=>s.enabled).length});
  let watcher: ReturnType<typeof startFileWatcher> | undefined;
  try {
    if(once){inbox.scan();report();await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,interval);});if(!stopped){inbox.scan();report();}}
    else { await new Promise<void>(resolve=>{wake=resolve;watcher=startFileWatcher(inbox,interval,report,error=>process.stderr.write(JSON.stringify({error:error.message,fallback:'Periodic reconciliation remains enabled'})+'\n'));}); }
  }finally{watcher?.close();if(timer)clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);emit({status:'stopped'});}
}
