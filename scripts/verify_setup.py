"""Hermetic CLI setup checks; all state stays in a temporary data directory."""
import json
import concurrent.futures
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

binary = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/release/co-memo').resolve()
with tempfile.TemporaryDirectory(prefix='co-memo-setup-') as temp:
    root = pathlib.Path(temp)
    project = root / 'project with spaces'
    project.mkdir()
    env = dict(os.environ, XDG_DATA_HOME=str(root / 'data'))
    env.pop('CO_MEMO_DB', None)
    def run(*args, cwd=project, expected=0, environ=env):
        result = subprocess.run([str(binary), *args], cwd=cwd, env=environ, capture_output=True, text=True, timeout=10)
        assert (result.returncode == 0) == (expected == 0), result.stderr or result.stdout
        return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else result
    initialized = run('init')
    database = root / 'data/co-memo/memory.sqlite'
    assert pathlib.Path(initialized['database']) == database
    first = run('setup', '--json')
    again = run('setup', '--json')
    assert first == again
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        simultaneous = list(pool.map(lambda _: run('setup', '--json'), range(4)))
    assert all(result == first for result in simultaneous)
    assert first['agentId'] and first['projectId']
    assert pathlib.Path(first['database']) == database.resolve()
    assert pathlib.Path(first['mcpServers']['co-memo']['command']) == binary
    assert run('recall', '--query', 'setup', '--json')['entries'] == []
    note = run('propose', '--content', 'Setup record', '--evidence', 'Synthetic setup test')
    assert note['ownerId'] == first['agentId'] and note['projectId'] == first['projectId']
    assert note['state'] == 'candidate'
    run('review', '--id', note['id'], '--version', '1')
    child = project / 'src'
    child.mkdir()
    assert run('get', '--id', note['id'], cwd=child)['id'] == note['id']
    explicit = run('propose', '--agent', first['agentId'], '--content', 'Explicit unscoped note', '--evidence', 'Synthetic setup test')
    assert 'projectId' not in explicit
    reviewer = run('setup', '--role', 'reviewer', '--json')
    assert reviewer['agentId'] != first['agentId'] and reviewer['projectId'] == first['projectId']
    run('get', '--role', 'reviewer', '--id', note['id'], expected=1)
    run('setup', '--agent', reviewer['agentId'], '--json', expected=1)
    # Reusing IDs is explicit, never based on a coincidentally equal directory name.
    second_dir = root / 'other' / project.name
    second_dir.mkdir(parents=True)
    second = run('setup', '--json', cwd=second_dir)
    assert second['projectId'] != first['projectId'] and second['agentId'] != first['agentId']
    adopted_dir = root / 'adopted'
    adopted_dir.mkdir()
    adopted = run('setup', '--agent', first['agentId'], '--project', first['projectId'], '--json', cwd=adopted_dir)
    assert adopted['agentId'] == first['agentId'] and adopted['projectId'] == first['projectId']
    # Nested projects must not inherit a missing role from a parent project.
    run('setup', '--role', 'nested', '--json', cwd=child)
    run('recall', '--json', cwd=child, expected=1)
    # Failed setup must not leave orphaned registrations or bindings.
    invalid_dir = root / 'invalid'
    invalid_dir.mkdir()
    catalog_before = run('catalog')
    run('setup', '--directory', str(invalid_dir), '--agent', 'missing', '--json', expected=1)
    assert run('catalog') == catalog_before
    # Scope remains fixed for MCP even when the caller attempts to inject an identity.
    server = first['mcpServers']['co-memo']
    messages = [
        {'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'memory_get','arguments':{'id':note['id']}}},
        {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'memory_record','arguments':{'content':'x','evidence':'x','agentId':reviewer['agentId']}}},
    ]
    mcp = subprocess.run([server['command'], *server['args']], input=''.join(json.dumps(m)+'\n' for m in messages), cwd=second_dir, env=env, text=True, capture_output=True, timeout=10)
    assert mcp.returncode == 0, mcp.stderr
    replies = [json.loads(line) for line in mcp.stdout.splitlines()]
    assert json.loads(replies[0]['result']['content'][0]['text'])['id'] == note['id']
    assert replies[1]['result']['isError']
    saved_mcp = subprocess.run([str(binary), 'mcp'], input=json.dumps(messages[0])+'\n', cwd=project, env=env, text=True, capture_output=True, timeout=10)
    assert saved_mcp.returncode == 0, saved_mcp.stderr
    assert json.loads(json.loads(saved_mcp.stdout)['result']['content'][0]['text'])['id'] == note['id']
    # Environment and explicit database paths have a documented precedence.
    custom_env = dict(env, CO_MEMO_DB=str(root / 'env.sqlite'))
    env_setup = run('setup', '--json', environ=custom_env)
    assert pathlib.Path(env_setup['database']) == (root / 'env.sqlite').resolve()
    override = run('setup', '--db', str(root / 'override.sqlite'), '--json', environ=custom_env)
    assert pathlib.Path(override['database']) == (root / 'override.sqlite').resolve()
    run('setup', '--json', environ=dict(env, CO_MEMO_DB='relative.sqlite'), expected=1)
    # Archived identities are never silently revived by setup or profile lookup.
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE catalog SET payload=json_set(payload,'$.archived',json('true')) WHERE id=?", (first['agentId'],))
    run('setup', '--json', expected=1)
    run('recall', '--json', expected=1)
    print('Setup defaults, idempotence, role/project isolation, adoption, rollback, MCP configuration, and archived identities passed.')
