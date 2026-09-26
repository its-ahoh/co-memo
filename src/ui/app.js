const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="co-memo-token"]').content;
let data = { memories: [], projects: [] },
  editing = null,
  deleting = null,
  busy = false;
const names = {
  note: 'note',
  preference: 'preference',
  decision: 'decision',
  constraint: 'constraint',
  lesson: 'lesson',
};
const date = (n) =>
  new Date(n).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
function node(tag, text, cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function notify(text = '', error = false) {
  $('message').textContent = text;
  $('message').className = error ? 'error' : '';
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: { 'X-Co-memo-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function projectName(id) {
  const root = data.projects.find((p) => p.id === id)?.root;
  return root ? root.split('/').filter(Boolean).pop() : 'Unknown project';
}
function render() {
  const active = data.memories.filter((m) => !m.deleted);
  $('total').textContent = active.length;
  $('personal').textContent = active.filter((m) => m.scope === 'user').length;
  $('project-count').textContent = active.filter((m) => m.scope === 'project').length;
  $('projects-count').textContent = data.projects.length;
  const q = $('search').value.trim().toLowerCase(),
    p = $('project').value,
    s = $('status').value;
  const memories = data.memories
    .filter(
      (m) =>
        (s === 'all' || m.deleted === (s === 'deleted')) &&
        (p === 'all' || (p === 'user' ? m.scope === 'user' : m.projectId === p)) &&
        [m.content, m.origin, m.metadata.module || ''].join(' ').toLowerCase().includes(q),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('count').textContent = `${memories.length} records`;
  $('list').replaceChildren();
  if (!memories.length)
    $('list').append(
      node(
        'div',
        q || p !== 'all' || s !== 'active'
          ? 'No matching memories. Adjust your search or filters.'
          : 'No memories yet. Create one with + New memory.',
        'empty',
      ),
    );
  for (const m of memories) {
    const card = node('article', '', 'card'),
      top = node('div', '', 'card-top');
    top.append(
      node(
        'span',
        m.scope === 'user' ? 'user / global' : projectName(m.projectId),
        `badge ${m.scope === 'project' ? 'project' : ''}`,
      ),
      node('span', names[m.metadata.kind] || m.metadata.kind, 'meta'),
    );
    if (m.deleted || m.conflicted)
      top.append(node('span', m.deleted ? 'deleted' : 'conflict', 'badge warning'));
    if (m.metadata.pinned) top.append(node('span', 'pinned', 'meta'));
    const bottom = node('div', '', 'card-bottom'),
      meta = node('span', `${date(m.updatedAt)} · v${m.version} · ${m.origin}`, 'meta');
    meta.title = m.id;
    bottom.append(meta);
    if (!m.deleted && !m.conflicted) {
      const actions = node('div', '', 'actions'),
        edit = node('button', 'Edit'),
        remove = node('button', 'Delete', 'remove');
      edit.onclick = () => openEditor(m);
      remove.onclick = () => {
        deleting = m;
        $('delete-preview').textContent = m.content;
        $('delete-error').textContent = '';
        $('deletion').showModal();
      };
      actions.append(edit, remove);
      bottom.append(actions);
    }
    if (m.conflicted) bottom.append(node('span', 'Resolve with co-memo resolve', 'meta'));
    const locations = node('details', '', 'locations');
    locations.append(node('summary', 'File locations'));
    const database = node('div', '', 'location-entry');
    database.append(
      node('span', 'DATABASE / notes', 'meta'),
      node('code', m.locations.database),
      node('span', 'id: ' + m.id, 'meta'),
    );
    locations.append(database);
    const labels = {
      current: 'In sync',
      different: 'Different from stored version',
      not_present: 'Memory not in file',
      missing: 'File missing',
      unreadable: 'File unreadable or invalid',
    };
    for (const replica of m.locations.replicas) {
      const entry = node('div', '', 'location-entry');
      entry.append(
        node(
          'span',
          replica.agent +
            ' / ' +
            labels[replica.status] +
            (replica.pending ? ' / pending sync' : ''),
          'meta',
        ),
        node('code', replica.path + (replica.line ? ':' + replica.line : '')),
      );
      locations.append(entry);
    }
    if (!m.locations.replicas.length)
      locations.append(node('span', 'Central database only; no registered Agent files.', 'meta'));
    card.append(top, node('div', m.content, 'card-content'), locations, bottom);
    $('list').append(card);
  }
}
async function load() {
  $('refresh').disabled = true;
  try {
    data = await api('/api/memories');
    const selected = $('project').value;
    $('project').replaceChildren(
      new Option('All projects', 'all'),
      new Option('Personal only', 'user'),
    );
    $('destination').replaceChildren(new Option('Personal / shared across projects', 'user'));
    for (const p of data.projects) {
      $('project').add(new Option(p.root, p.id));
      $('destination').add(new Option(p.root, p.id));
    }
    if ([...$('project').options].some((o) => o.value === selected)) $('project').value = selected;
    $('home').textContent = data.home;
    render();
  } finally {
    $('refresh').disabled = false;
  }
}
function openEditor(memory = null) {
  editing = memory;
  $('dialog-title').textContent = memory ? 'Edit memory' : 'New memory';
  $('content').value = memory?.content || '';
  $('destination').value = memory
    ? memory.projectId || 'user'
    : $('project').value !== 'all'
      ? $('project').value
      : 'user';
  $('destination').disabled = !!memory;
  $('form-error').textContent = '';
  $('edit-meta').textContent = memory
    ? `Editing v${memory.version} / version checked on save`
    : 'Personal memories are global; project memories stay scoped.';
  $('content').dispatchEvent(new Event('input'));
  $('editor').showModal();
  $('content').focus();
}
function resultMessage(result, fallback) {
  const errors = [...(result.priorErrors || []), ...(result.sync?.errors || [])];
  return (
    (result.notice || fallback) +
    (errors.length
      ? '\nSaved, but some agents could not sync: ' + errors.map((e) => e.error).join('; ')
      : '') +
    (result.sync?.conflicts?.length
      ? '\nUnresolved sync conflicts. Inspect with co-memo conflicts.'
      : '')
  );
}
$('form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  $('save').disabled = true;
  $('form-error').textContent = '';
  try {
    const content = $('content').value.trim();
    if (!content) throw new Error('Enter some memory content.');
    const destination = $('destination').value;
    const result = editing
      ? await api(`/api/memories/${editing.id}`, 'PATCH', { version: editing.version, content })
      : await api('/api/memories', 'POST', {
          content,
          scope: destination === 'user' ? 'user' : 'project',
          projectId: destination === 'user' ? null : destination,
        });
    $('editor').close();
    notify(
      resultMessage(
        result,
        result.created === false
          ? 'Memory already exists; no duplicate was created.'
          : 'Memory saved.',
      ),
    );
    try {
      await load();
    } catch (e) {
      notify('Memory saved, but refresh failed: ' + e.message, true);
    }
  } catch (e) {
    $('form-error').textContent =
      e.message + ' If the version changed, cancel and refresh before trying again.';
  } finally {
    busy = false;
    $('save').disabled = false;
  }
};
$('confirm-delete').onclick = async () => {
  if (busy || !deleting) return;
  busy = true;
  $('confirm-delete').disabled = true;
  try {
    const result = await api(`/api/memories/${deleting.id}`, 'DELETE', {
      version: deleting.version,
    });
    $('deletion').close();
    notify(resultMessage(result, 'Memory deleted. Revision history retained.'));
    try {
      await load();
    } catch (e) {
      notify('Memory deleted, but refresh failed: ' + e.message, true);
    }
  } catch (e) {
    $('delete-error').textContent = e.message;
  } finally {
    busy = false;
    $('confirm-delete').disabled = false;
  }
};
$('add').onclick = () => openEditor();
for (const id of ['cancel', 'close'])
  $(id).onclick = () => {
    if (!busy) $('editor').close();
  };
$('keep').onclick = () => {
  if (!busy) $('deletion').close();
};
for (const id of ['editor', 'deletion'])
  $(id).addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
$('content').oninput = () => {
  $('length').textContent = `${$('content').value.length} / 32000`;
};
$('refresh').onclick = () => {
  notify();
  load().catch((e) => notify(e.message, true));
};
$('search').oninput = render;
$('project').onchange = render;
$('status').onchange = render;
$('all').onclick = () => {
  $('search').value = '';
  $('project').value = 'all';
  $('status').value = 'active';
  render();
};
load().catch((e) => notify('Unable to load memories: ' + e.message, true));

$('theme').value = document.documentElement.dataset.theme || 'system';
$('theme').onchange = () => {
  const theme = $('theme').value;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('co-memo-theme', theme);
  } catch {
    /* Theme still applies when storage is unavailable. */
  }
};
