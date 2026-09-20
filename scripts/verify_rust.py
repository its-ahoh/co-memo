"""End-to-end verification of the native binary; Python is a test dependency only."""
import json
import pathlib
import queue
import subprocess
import sqlite3
import sys
import tempfile
import threading

binary = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/release/co-memo').resolve()
with tempfile.TemporaryDirectory(prefix='co-memo-rust-e2e-') as temp:
    db = str(pathlib.Path(temp) / 'memory.sqlite')
    def cli(command, *args, stdin=None):
        result = subprocess.run([str(binary), command, '--db', db, *args], input=stdin, text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout) if result.stdout.strip() else None
    cli('init')
    a = cli('register', '--name', 'Writer')['id']
    b = cli('register', '--name', 'Reader')['id']
    class Process:
        def __init__(self, command, *args):
            self.p = subprocess.Popen([str(binary), command, '--db', db, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.lines = queue.Queue()
            def drain():
                for line in self.p.stdout:
                    self.lines.put(json.loads(line))
            threading.Thread(target=drain, daemon=True).start()
        def read(self):
            return self.lines.get(timeout=10)
        def rpc(self, name, args):
            self.p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})+'\n')
            self.p.stdin.flush()
            return self.read()['result']
        def close(self):
            self.p.stdin.close()
            try:
                self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait()
            assert self.p.returncode == 0, self.p.stderr.read()
    writer = Process('mcp', '--agent', a)
    reader = Process('mcp', '--agent', b)
    try:
        r = writer.rpc('memory_record', {'content':'A native handoff lesson','evidence':'Synthetic evidence'})
        note = json.loads(r['content'][0]['text'])
        assert reader.rpc('memory_get', {'id':note['id']})['isError']
        assert writer.rpc('memory_record', {'content':'Injected','evidence':'q','agentId':b})['isError']
        cli('review', '--id', note['id'], '--version', '1')
        cli('share', '--id', note['id'], '--version', '2', '--audience', 'shared', '--with', b)
        assert json.loads(reader.rpc('memory_get', {'id':note['id']})['content'][0]['text'])['version'] == 3
        cli('forget', '--id', note['id'], '--version', '3')
        assert reader.rpc('memory_get', {'id':note['id']})['isError']
        duplicate = json.loads(writer.rpc('memory_record', {'content':note['content'],'evidence':'Rediscovery'})['content'][0]['text'])
        assert duplicate['id'] == note['id'] and duplicate['state'] == 'forgotten'
    finally:
        writer.close()
        reader.close()
    assert cli('hook-end', '--agent', a, stdin='{}')['status'] == 'skipped'
    file = pathlib.Path(temp) / 'MEMORY.md'
    file.write_text('Initial native file lesson')
    cli('source-add', '--agent', a, '--file', str(file))
    watcher = Process('watch')
    try:
        assert watcher.read()['status'] == 'watching'
        assert watcher.read()['change'] == 'imported'
        replacement = pathlib.Path(temp) / 'replacement.md'
        replacement.write_text('Updated native file lesson')
        replacement.replace(file)
        assert watcher.read()['change'] == 'modified'
        file.unlink()
        assert watcher.read()['change'] == 'deleted'
        watcher.p.terminate()
        assert watcher.read()['status'] == 'stopped'
    finally:
        if watcher.p.poll() is None:
            watcher.p.terminate()
        watcher.close()
    assert len(cli('inbox')) == 2
    long_note = cli('propose', '--agent', a, '--content', '测试中文记忆。' * 60, '--evidence', 'Synthetic long note')
    cli('review', '--id', long_note['id'], '--version', '1')
    recalled = cli('recall', '--agent', a, '--query', '中文', '--json')
    assert recalled['entries'][0]['id'] == long_note['id']
    assert recalled['truncatedIds'] == [long_note['id']]
    assert len(recalled['text'].encode('utf-8')) <= 1200
    hooked = cli('hook-start', '--agent', a, stdin=json.dumps({'query':'中文'}))
    assert hooked['truncatedIds'] == [long_note['id']]
    assert hooked['memories'][0]['id'] == long_note['id']
    # Simulate an expired record from an existing database without waiting a month.
    with sqlite3.connect(db) as connection:
        connection.execute("UPDATE memories SET payload=json_set(payload,'$.reviewAfter',1) WHERE id=?", (long_note['id'],))
    expired = [m for m in cli('inbox') if m['id'] == long_note['id']]
    assert expired[0]['reviewReason'] == 'expired'
    assert cli('inspect', '--id', long_note['id'])['version'] == 2
    assert cli('recall', '--agent', a, '--query', '中文', '--json')['entries'] == []
    cli('review', '--id', long_note['id'], '--version', '2')
    assert cli('get', '--agent', a, '--id', long_note['id'])['version'] == 3
    assert all(m['id'] != long_note['id'] for m in cli('inbox'))
    for command in ['recall', 'review', 'inspect', 'share', 'mcp', 'watch']:
        help_result = subprocess.run([str(binary), command, '--help'], text=True, capture_output=True, timeout=10)
        assert help_result.returncode == 0 and '--db' in help_result.stdout
    for args in [['review', '--id', long_note['id']], ['get', '--id', long_note['id']], ['recall', '--agent', a, '--version', '1'], ['typo']]:
        invalid = subprocess.run([str(binary), *args, '--db', db], text=True, capture_output=True, timeout=10)
        assert invalid.returncode != 0
    print('Native CLI/MCP, scoped deduplication, long Chinese context, expiry review, argument validation, file-change detection, atomic replacement, deletion, and shutdown passed.')
