import test from 'node:test';
import assert from 'node:assert/strict';
import { evidence } from '../dist/verification.js';
const lines = (...events) => events.map((e) => JSON.stringify(e)).join('\n');
test('verification evidence requires actual completed host calls and detects unrelated tools', () => {
  const rejected = evidence(
    'codex',
    lines(
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'co-memo',
          tool: 'memory_context',
          status: 'failed',
          error: { message: 'approval required' },
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'I read the correct marker' },
      },
      { type: 'turn.completed' },
    ),
  );
  assert.equal(rejected.calls[0].failed, true);
  assert.equal(rejected.calls[0].result, null);
  const success = evidence(
    'codex',
    lines(
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'co-memo',
          tool: 'memory_context',
          status: 'completed',
          result: { content: [{ type: 'text', text: '{"context":"fixture-value"}' }] },
        },
      },
      { type: 'item.completed', item: { type: 'agent_message', text: 'fixture-value' } },
      { type: 'turn.completed' },
    ),
  );
  assert.equal(success.calls[0].result.context, 'fixture-value');
  assert.equal(success.unexpected, false);
  assert.equal(success.completed, true);
  assert.equal(
    evidence('codex', lines({ type: 'item.completed', item: { type: 'command_execution' } }))
      .unexpected,
    true,
  );
  assert.equal(evidence('codex', 'invalid output').completed, false);
});

test('Claude tool-use IDs must have matching results; claims and unrelated results do not suffice', () => {
  const use = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'call1',
          name: 'mcp__co-memo__memory_recall',
          input: { query: 'fixture' },
        },
      ],
    },
  };
  assert.equal(evidence('claude', lines(use)).calls[0].failed, true);
  const result = evidence(
    'claude',
    lines(
      use,
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call1',
              content: [{ type: 'text', text: '{"memories":[{"content":"fixture-value"}]}' }],
            },
          ],
        },
      },
      { type: 'result', is_error: false, result: 'fixture-value' },
    ),
  );
  assert.equal(result.calls[0].failed, false);
  assert.equal(result.final, 'fixture-value');
  assert.equal(result.completed, true);
  assert.equal(
    evidence(
      'claude',
      lines({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'shell', name: 'Bash' }] },
      }),
    ).unexpected,
    true,
  );
});
