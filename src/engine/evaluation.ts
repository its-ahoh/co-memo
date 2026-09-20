/** Paired, isolated synthetic tasks. Offline mode measures retrieval only, never answer quality. */
import { MemoryEngine, MemoryDraft } from './index';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface EvaluationResponse { model?: string; output: string; inputTokens?: number; outputTokens?: number }
export type EvaluationRunner = (prompt: string) => Promise<EvaluationResponse>;
const memory = (content: string, overrides: Partial<MemoryDraft> = {}): MemoryDraft => ({ ownerId: 'agent-a', audience: 'private', projectId: 'project-a', kind: 'preference', state: 'active', content,
  evidence: { source: 'user', eventId: 'fixture', excerpt: content }, ...overrides });
export const memoryEvaluationCases = [
  { name: 'enduring-preference', notes: [memory('Preferred package manager: pnpm.')], question: 'Which package manager do I prefer?', expected: 'pnpm', recall: 1 },
  { name: 'paraphrased-question', notes: [memory('Preferred response length: concise.')], question: 'How verbose should your answers to me be?', expected: 'concise', recall: 1 },
  { name: 'current-instruction-wins', notes: [memory('Preferred package manager: pnpm.')], question: 'For this task use yarn. Which package manager should you use?', expected: 'yarn', recall: 1 },
  { name: 'other-agent-private', notes: [memory('Preferred package manager: pnpm.', { ownerId: 'agent-b' })], question: 'Which package manager do I prefer?', expected: 'unknown', recall: 0 },
  { name: 'other-project', notes: [memory('Preferred package manager: pnpm.', { projectId: 'project-b' })], question: 'Which package manager do I prefer?', expected: 'unknown', recall: 0 },
  { name: 'unconfirmed-conflict', notes: [memory('Preferred package manager: pnpm.'), memory('Preferred package manager: yarn.', { state: 'candidate' })], question: 'Which package manager do I prefer?', expected: 'pnpm', recall: 1 },
  { name: 'expired-project-fact', notes: [memory('Deployment status: healthy.', { kind: 'fact', reviewAfter: 1 })], question: 'What is the deployment status?', expected: 'unknown', recall: 0 },
  { name: 'shared-fact', notes: [memory('Team test runner: vitest.', { ownerId: 'user', projectId: undefined, audience: 'global' })], question: 'Which test runner does the team use?', expected: 'vitest', recall: 1 },
];
function answer(output: string): string | undefined {
  try { const parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim()); return typeof parsed.answer === 'string' ? parsed.answer.trim().toLowerCase() : undefined; }
  catch { return undefined; }
}
function validTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export async function evaluateMemory(runner?: EvaluationRunner, repeats = 1) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Repeats must be 1–10');
  type Result = { rawOutput?: string; parseError?: boolean; model?: string; correct: boolean; answer?: string; inputTokens?: number; outputTokens?: number; latencyMs: number; error?: string };
  const rows: Array<{ name: string; repeat: number; retrievalPassed: boolean; injectedBytes: number; expected: string; results: Partial<Record<'with' | 'without', Result>> }> = [];
  for (let repeat = 0; repeat < repeats; repeat++) for (const [index, test] of memoryEvaluationCases.entries()) {
    const engine = new MemoryEngine(':memory:');
    let context;
    try { test.notes.forEach(n => engine.add(n)); context = engine.contextWithEntries({ agentId: 'agent-a', projectId: 'project-a' }, test.question); }
    finally { engine.close(); }
    const base = `Answer this synthetic memory test. Return only JSON {"answer":"value"}, using one lowercase word. Current task instructions override past notes. If the evidence does not establish the answer, use "unknown".\n\nQuestion: ${test.question}`;
    const results: Partial<Record<'without' | 'with', Result>> = {};
    if (runner) for (const mode of ((index + repeat) % 2 ? ['with', 'without'] : ['without', 'with']) as Array<'with' | 'without'>) {
      const started = Date.now();
      try {
        const response = await runner(mode === 'with' ? `${context.text}\n\n${base}` : base);
        const value = answer(response.output);
        results[mode] = { correct: value === test.expected, answer: value, rawOutput: response.output.slice(0, 16000), parseError: value === undefined, model: response.model,
          inputTokens: validTokens(response.inputTokens), outputTokens: validTokens(response.outputTokens), latencyMs: Date.now() - started };
      } catch { results[mode] = { correct: false, latencyMs: Date.now() - started, error: 'Runner failed' }; }
    }
    rows.push({ name: test.name, repeat, retrievalPassed: context.entries.length === test.recall,
      injectedBytes: Buffer.byteLength(context.text), expected: test.expected, results });
  }
  const tokens = (mode: 'with' | 'without', field: 'inputTokens' | 'outputTokens') => {
    const values = rows.map(r => r.results[mode]?.[field]);
    return values.every(v => v !== undefined) ? values.reduce((sum, v) => sum! + v!, 0) : null;
  };
  return { suite: 'co-memo-synthetic-v1', mode: runner ? 'live-paired' : 'offline-retrieval',
    limitations: ['Synthetic fixtures do not establish production effectiveness.', 'No model calls or answer-quality scores in offline mode.', 'Token totals are reported only when the runner provides them for every request.', 'Learning and proposal overhead is not included in these retrieval/answer pairs.'],
    summary: { cases: rows.length, retrievalPassed: rows.filter(r => r.retrievalPassed).length,
      quality: runner ? { withoutCorrect: rows.filter(r => r.results.without?.correct).length, withCorrect: rows.filter(r => r.results.with?.correct).length,
        completedPairs: rows.filter(r => !r.results.without?.error && !r.results.with?.error).length,
        parseErrors: rows.reduce((sum, r) => sum + Number(!!r.results.with?.parseError) + Number(!!r.results.without?.parseError), 0),
        improvements: rows.filter(r => !r.results.without?.error && !r.results.with?.error && !r.results.without?.correct && r.results.with?.correct).length,
        regressions: rows.filter(r => !r.results.without?.error && !r.results.with?.error && r.results.without?.correct && !r.results.with?.correct).length,
        runnerErrors: rows.reduce((sum, r) => sum + Number(!!r.results.with?.error) + Number(!!r.results.without?.error), 0),
        inputTokens: { without: tokens('without', 'inputTokens'), with: tokens('with', 'inputTokens') },
        outputTokens: { without: tokens('without', 'outputTokens'), with: tokens('with', 'outputTokens') } } : null }, rows };
}
/** Each invocation is a fresh process. The adapter must use the same model/settings and no tools or saved sessions. */
export function evaluationScriptRunner(script: string): EvaluationRunner {
  return prompt => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(script)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let size = 0;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Evaluation timeout')); }, 60000);
    const fail = (error: Error) => { clearTimeout(timeout); child.kill('SIGKILL'); reject(error); };
    child.on('error', fail); child.stdin.on('error', fail);
    child.stderr.resume(); // Provider errors may contain secrets; never save them to the report.
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 1000000) fail(new Error('Evaluation output too large')); else stdout += chunk; });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error('Evaluation runner failed');
        const parsed = JSON.parse(stdout);
        if (typeof parsed.output !== 'string') throw new Error('Expected output string');
        resolveResult(parsed);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ prompt }));
  });
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const script = flag('--runner'); const out = resolve(flag('--out') ?? 'output/memory-evaluation.json');
  evaluateMemory(script ? evaluationScriptRunner(script) : undefined, Number(flag('--repeats') ?? 1)).then(report => {
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report.summary)}\nReport: ${out}\n`);
    if (report.summary.retrievalPassed !== report.summary.cases || report.summary.quality?.runnerErrors) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Memory evaluation failed. Check the adapter and arguments.\n'); process.exitCode = 1; });
}
