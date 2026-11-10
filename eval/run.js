import { writeFile } from 'node:fs/promises';
import { createAssistantCore, SHARED_CORE_VERSION } from '../assistant-core.js';
import { OWNER_TELEGRAM_ID } from '../unified-context.js';
import { scenarios, FIXED_NOW, reviewFlags } from './scenarios.js';
import { MODEL_CONFIGS, createModelClient, createBudget } from './model-client.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const budgetArg = args.find(value => value.startsWith('--max-estimated-usd='));
const budget = createBudget(budgetArg ? Number(budgetArg.split('=')[1]) : 1);
const output = new URL('./model-results.json', import.meta.url);
const result = { generatedAt: new Date().toISOString(), core: SHARED_CORE_VERSION, syntheticOnly: true,
  status: live ? 'starting' : 'dry_run_no_models_called', models: Object.keys(MODEL_CONFIGS),
  scope: 'Shared-core text generation with fixed context and replayed planner/search. Not live voice, vision, real search, retrieval quality, or model tool selection.',
  caseCount: scenarios.length, attempts: [], cases: [] };
if (live && !process.env.OPENAI_API_KEY) {
  result.status = 'blocked'; result.blocker = 'OPENAI_API_KEY is not available to the evaluation process';
  process.exitCode = 2;
} else if (live) {
  // Paired, sequential cases: no uncontrolled parallel spending or retries.
  outer: for (const item of scenarios) {
    for (const model of result.models) {
      const records = [];
      const complete = createModelClient({ model, apiKey: process.env.OPENAI_API_KEY, budget, records });
      const core = createAssistantCore({ now: () => new Date(FIXED_NOW), complete,
        store: { load: async () => structuredClone(item.packet) }, internetConfigured: true,
        plan: async () => ({ needs_web: Boolean(item.web), search_query: item.searchQuery || '' }),
        search: async () => structuredClone(item.web), isFatal: () => true });
      const row = { id: item.id, model, title: item.title, expected: item.expected, records };
      result.cases.push(row);
      try {
        if (item.setup) await core.respond({ userId: OWNER_TELEGRAM_ID, channel: 'telegram', text: item.setup });
        const reply = await core.respond({ userId: OWNER_TELEGRAM_ID, channel: item.channel || 'telegram', text: item.question });
        row.answer = reply.answer; row.flags = reviewFlags(item, reply.answer);
        row.repairCalls = records.length - (item.setup ? 2 : 1);
      } catch (error) {
        row.error = error.message;
        // Stop on unknown access/availability/network/timeout failures. Never
        // retry a potentially billed call or silently substitute another model.
        result.status = 'stopped_incomplete'; break outer;
      } finally {
        result.budget = budget.snapshot();
        await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      }
    }
  }
  if (result.status === 'starting') result.status = 'completed_awaiting_semantic_review';
} else {
  result.cases = scenarios.map(({ id, title, question, expected }) => ({ id, title, question, expected, modelResult: 'not_run' }));
}
result.budget = budget.snapshot();
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: result.status, caseCount: result.caseCount, calls: result.budget.calls, output: output.pathname }));
