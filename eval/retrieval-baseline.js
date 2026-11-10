import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createContextStore, OWNER_TELEGRAM_ID, selectMemories } from '../unified-context.js';

const fact = (id, content, created_at, source = {}) => ({ id, content, created_at, type: 'fact', source: JSON.stringify({ kind: 'owner_confirmed', ...source }) });
function fixtureStore({ memory = [], calls = [], conversation = [], outage = false } = {}) {
  return createContextStore({ url: 'https://fixture.invalid', key: 'synthetic-not-a-secret', fetchImpl: async address => {
    if (outage) return new Response('', { status: 503 });
    const url = new URL(address);
    const table = url.pathname.split('/').at(-1);
    const rows = { memory, call_sessions: calls, kuzia_interactions: conversation, chat_archive_anchors: [], chat_archive_summaries: [], kuzia_evolution: [] }[table];
    // The fixture models the actual REST order and limit. It never connects
    // to the production DB and does not return hidden rows beyond the limit.
    const field = table === 'kuzia_interactions' ? 'timestamp' : 'created_at';
    return Response.json(rows.slice().sort((a, b) => String(b[field]).localeCompare(String(a[field])) || String(b.id).localeCompare(String(a.id))).slice(0, Number(url.searchParams.get('limit'))));
  } });
}
const load = (fixtures, query) => fixtureStore(fixtures).load({ userId: OWNER_TELEGRAM_ID, query });

export async function retrievalBaseline() {
  const results = [];
  const record = (id, title, desired, observed, evidence) => results.push({ id, title, desired, observed, status: desired === observed ? 'met' : 'gap', evidence });
  const recent = await load({ memory: [fact('recent', 'Мира подтвердила доставку пробников в четверг.', '2026-11-10')] }, 'Мира пробников');
  record('R01', 'Точное совпадение в свежем окне', true, recent.facts.some(row => row.id === 'recent'), 'Target is present in facts.');

  const target = fact('paraphrase-target', 'Лев обсуждал образцы для мытья и миниатюры.', '2026-09-01');
  const distractors = Array.from({ length: 30 }, (_, i) => fact(`d${i}`, `Подтверждена проверка упаковки номер ${i} в магазине.`, `2026-10-${String(i + 1).padStart(2, '0')}`));
  const paraphrase = selectMemories([...distractors, target], 'Кто звонил по поводу пробников шампуня?');
  record('R02', 'Перефразирование без общих ключевых слов', true, paraphrase.some(row => row.id === target.id), { availableRows: 31, selectedRows: paraphrase.length, targetWithinDatabaseWindow: true });

  const many = Array.from({ length: 200 }, (_, i) => fact(`m${i}`, `Проверка упаковки номер ${i} подтверждена владельцем.`, new Date(Date.UTC(2026, 10, 10, 12, 0, -i)).toISOString()));
  const old = fact('old-exact', 'Кира согласовала бирюзовые коробки для подарков.', '2026-09-01');
  const outside = await load({ memory: [...many, old] }, 'Кира бирюзовые коробки');
  record('R03', 'Точное совпадение за последними 200 фактами', true, outside.facts.some(row => row.id === old.id), { totalRows: 201, memoryLimitReached: outside.limitsReached.includes('memory'), partial: outside.partial });

  const corrected = selectMemories([
    fact('old', 'Проверочная встреча назначена на 12:00.', '2026-11-08'),
    fact('new', 'Проверочная встреча перенесена на 13:15.', '2026-11-09', { supersedes: ['old'] })
  ], 'встреча');
  record('R04', 'Явная замена старого факта внутри окна', true, corrected.some(row => row.id === 'new') && !corrected.some(row => row.id === 'old'), { selectedIds: corrected.map(row => row.id) });

  const calls = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, created_at: new Date(Date.UTC(2026, 10, 10, 12, 0, -i)).toISOString(), status: 'completed', direction: 'inbound', instruction: 'Синтетический разговор' }));
  const callPacket = await load({ calls: [...calls, { id: 'old-call', created_at: '2026-10-01T10:00:00Z', status: 'completed', direction: 'inbound', instruction: 'Лев обсуждал пробники.' }] }, 'Кто звонил 1 октября?');
  record('R05', 'Звонок за последними 30 записями', true, callPacket.calls.some(row => row.id === 'old-call'), { totalRows: 31, selectedRows: callPacket.calls.length, callsLimitReached: callPacket.limitsReached.includes('calls') });

  const failed = await load({ outage: true }, 'память');
  record('R06', 'Сбой БД помечается как недоступность', true, failed.partial && failed.unavailable.length === 6, { unavailable: failed.unavailable });

  const provenance = await load({ conversation: [{ id: 'dialogue', event_type: 'telegram_message', telegram_user_id: OWNER_TELEGRAM_ID, timestamp: '2026-11-10', stimulus: 'Какие коробки выбрать?', response: 'Я купил 100 коробок.' }] }, 'коробки');
  record('R07', 'Сгенерированные слова отделены от фактов', true,
    !JSON.stringify({ facts: provenance.facts, statements: provenance.userStatements }).includes('Я купил') && provenance.recentDialog[0]?.priorAssistantWords === 'Я купил 100 коробок.',
    'Assistant claim stays quoted in recentDialog, not userStatements/facts.');

  let requests = 0;
  const denied = await createContextStore({ url: 'https://fixture.invalid', key: 'synthetic', fetchImpl: async () => { requests++; throw Error('unexpected read'); } }).load({ userId: 'another-person', query: 'личная память' });
  record('R08', 'Чужая личность не читает общий контекст', true, denied.access === 'denied' && requests === 0, { requests });
  return { generatedAt: new Date().toISOString(), syntheticOnly: true, modelsCalled: 0, scope: 'Production retrieval code against an in-memory REST fixture, not live Supabase or model accuracy.', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await retrievalBaseline();
  await writeFile(new URL('./retrieval-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ checks: result.results.length, gaps: result.results.filter(row => row.status === 'gap').map(row => row.id), modelsCalled: 0 }));
}
