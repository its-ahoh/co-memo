"""Exercise copyable client setup, preserved user config, and generated connections."""
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import tomllib

binary = str(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/debug/co-memo').resolve())
with tempfile.TemporaryDirectory(prefix="co-memo-clients-") as temp:
    root = pathlib.Path(temp)
    env = dict(os.environ, XDG_DATA_HOME=str(root / 'data'))
    env.pop('CO_MEMO_DB', None)

    def run(args, cwd, success=True):
        result = subprocess.run([binary, *args], cwd=cwd, env=env, text=True, capture_output=True, timeout=10)
        assert (result.returncode == 0) == success, result.stderr or result.stdout
        return json.loads(result.stdout) if success and result.stdout.startswith('{') else result

    def rpc(command, name, args):
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}
        # A different environment/cwd must not change the generated connection.
        result = subprocess.run(command, cwd=root, env=dict(env, CO_MEMO_DB=str(root/'absent.sqlite')),
                                input=json.dumps(request)+'\n', text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        response = json.loads(result.stdout)['result']
        assert not response.get('isError'), response
        return json.loads(response['content'][0]['text'])

    projects = {}
    for client in ['claude', 'codex', 'opencode', 'opencode-v2', 'pi']:
        project = root / (client + " project's directory")
        project.mkdir()
        config_path = project / ({'claude': '.mcp.json', 'codex': '.codex/config.toml'}.get(client, 'opencode.json'))
        instruction_path = project / ('CLAUDE.md' if client == 'claude' else 'AGENTS.md')
        instruction_path.write_text('# Existing rules\n\nKeep this instruction.\n')
        if client == 'codex':
            config_path.parent.mkdir()
            config_path.write_text('# Keep this comment\n[mcp_servers.existing]\ncommand = "existing"\n')
        elif client != 'pi':
            original = {'custom': True}
            if client == 'claude': original['mcpServers'] = {'existing': {'command': 'existing'}}
            elif client == 'opencode': original['mcp'] = {'existing': {'type': 'local', 'command': ['existing']}}
            else: original['mcp'] = {'servers': {'existing': {'type': 'local', 'command': ['existing']}}}
            config_path.write_text(json.dumps(original))
        first = run(['setup', '--client', client, '--json'], project)
        saved = {p: pathlib.Path(p).read_bytes() for p in first['configuredFiles']}
        second = run(['setup', '--client', client, '--json'], project)
        assert first == second
        assert saved == {p: pathlib.Path(p).read_bytes() for p in first['configuredFiles']}
        assert 'Keep this instruction.' in instruction_path.read_text()
        assert instruction_path.read_text().count('<!-- co-memo:') == 2
        role = 'opencode' if client == 'opencode-v2' else client
        assert first['role'] == role
        assert run(['recall', '--role', role, '--json'], project)['entries'] == []
        if client == 'pi':
            command = shlex.split(re.search(r'```sh\n(.*?)\n```', instruction_path.read_text(), re.S)[1])
            result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True, timeout=10)
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)['entries'] == []
        else:
            if client == 'codex':
                doc = tomllib.loads(config_path.read_text())
                assert '# Keep this comment' in config_path.read_text()
                servers = doc['mcp_servers']
            else:
                doc = json.loads(config_path.read_text())
                assert doc['custom'] is True
                servers = doc['mcpServers'] if client == 'claude' else doc['mcp'].get('servers', doc['mcp'])
            assert 'existing' in servers
            server = servers['co-memo']
            command = server['command'] if isinstance(server['command'], list) else [server['command'], *server['args']]
            rpc(command, 'memory_search', {'query': 'setup'})
            note = rpc(command, 'memory_record', {'content': 'Client setup test', 'evidence': 'Synthetic test'})
            assert note['ownerId'] == first['agentId'] and note['projectId'] == first['projectId']
        projects[client] = (project, first)

    project, codex = projects['codex']
    claude = run(['setup', '--client', 'claude', '--json'], project)
    assert claude['agentId'] != codex['agentId'] and claude['projectId'] == codex['projectId']
    shared = run(['setup', '--client', 'codex', '--role', 'claude', '--json'], project)
    assert shared['agentId'] == claude['agentId']
    # Both instruction blocks can live together and repeated setup stays idempotent.
    run(['setup', '--client', 'pi', '--json'], project)
    assert (project/'AGENTS.md').read_text().count('<!-- co-memo:') == 4
    run(['setup', '--client', 'codex', '--json'], project)
    assert (project/'AGENTS.md').read_text().count('<!-- co-memo:') == 4

    for client, name, contents in [('claude', '.mcp.json', '{bad'), ('codex', '.codex/config.toml', 'mcp_servers = 7'), ('opencode', 'opencode.json', '{"mcp": 7}')]:
        project = root / ('invalid-' + client); project.mkdir()
        path = project/name; path.parent.mkdir(exist_ok=True); path.write_text(contents)
        run(['setup', '--client', client], project, success=False)
        assert path.read_text() == contents
        assert not (project/'AGENTS.md').exists() and not (project/'CLAUDE.md').exists()

    project = root/'jsonc'; project.mkdir()
    (project/'opencode.jsonc').write_text('{ /* preserve */ }')
    run(['setup', '--client', 'opencode'], project, success=False)
    assert not (project/'opencode.json').exists()
    project = root/'bad-instructions'; project.mkdir()
    (project/'AGENTS.md').write_text('<!-- co-memo:codex:start -->')
    run(['setup', '--client', 'codex'], project, success=False)
    assert not (project/'.codex/config.toml').exists()
    # A valid inline TOML table is supported, not overwritten with an unrelated table.
    project = root/'inline-toml'; (project/'.codex').mkdir(parents=True)
    path = project/'.codex/config.toml'
    path.write_text('mcp_servers = { existing = { command = "keep" } }\n')
    run(['setup', '--client', 'codex'], project)
    assert tomllib.loads(path.read_text())['mcp_servers']['existing']['command'] == 'keep'
    run(['setup', '--client', 'codex'], project)
print('Client setup: identity reuse/isolation, preserved configuration/instructions, generated MCP/CLI commands, and malformed-file handling passed.')
