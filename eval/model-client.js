// Evaluation adapter only. This file is never imported by the running service.
export const MODEL_CONFIGS = Object.freeze({
  'gpt-4o': { path: 'chat/completions', maxOutput: 700, inputUsdPerM: 2.5, outputUsdPerM: 10 },
  'gpt-6.1-sol': { path: 'responses', maxOutput: 2048, inputUsdPerM: 2, outputUsdPerM: 10, effort: 'low' }
});

export function requestBody(model, messages, options = {}) {
  const config = MODEL_CONFIGS[model];
  if (!config) throw new Error('unsupported_evaluation_model');
  if (messages.some(item => typeof item.content !== 'string')) throw new Error('text_evaluation_only');
  if (config.path === 'chat/completions') return { model, messages, temperature: options.temperature ?? 0.4, max_tokens: Math.min(options.max_tokens || 700, 700), store: false };
  return { model, input: messages, reasoning: { effort: config.effort }, max_output_tokens: config.maxOutput, store: false };
}

export function readAnswer(model, data) {
  if (MODEL_CONFIGS[model]?.path === 'chat/completions') {
    if (data.choices?.[0]?.finish_reason !== 'stop') throw new Error('incomplete_model_reply');
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('empty_model_reply');
    return answer;
  }
  if (data.status !== 'completed') throw new Error('incomplete_model_reply');
  const answer = (data.output || []).filter(item => item.type === 'message')
    .flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
  if (!answer.trim()) throw new Error('empty_model_reply');
  return answer;
}

export function createBudget(maxEstimatedUsd = 1) {
  if (!Number.isFinite(maxEstimatedUsd) || maxEstimatedUsd <= 0 || maxEstimatedUsd > 2) throw new Error('invalid_evaluation_budget');
  let reservedUsd = 0, calls = 0;
  return {
    reserve(model, body) {
      const config = MODEL_CONFIGS[model];
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (bytes > 32000 || calls >= 64) throw new Error('evaluation_request_limit');
      // Conservative planning estimate, not an OpenAI account spending limit.
      // Do not refund reservations after timeout: billing may already occur.
      const estimate = ((bytes + 2048) * config.inputUsdPerM + config.maxOutput * config.outputUsdPerM) / 1e6;
      if (reservedUsd + estimate > maxEstimatedUsd) throw new Error('evaluation_budget_exhausted');
      reservedUsd += estimate; calls++;
    },
    snapshot: () => ({ calls, reservedUsd, maxEstimatedUsd, kind: 'conservative_estimate_not_billing_guarantee' })
  };
}

export function createModelClient({ model, apiKey, budget, records, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('openai_api_key_not_available');
  if (!MODEL_CONFIGS[model]) throw new Error('unsupported_evaluation_model');
  return async (messages, options = {}) => {
    const body = requestBody(model, messages, options);
    budget.reserve(model, body);
    const started = performance.now();
    const record = { model, endpoint: MODEL_CONFIGS[model].path, inputMessages: structuredClone(messages), requested: { ...body, messages: undefined, input: undefined } };
    records.push(record);
    try {
      const response = await fetchImpl(`https://api.openai.com/v1/${MODEL_CONFIGS[model].path}`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs || 20000), body: JSON.stringify(body)
      });
      record.httpStatus = response.status;
      record.requestId = response.headers.get('x-request-id');
      if (!response.ok) throw new Error(`openai_http_${response.status}`);
      const data = await response.json();
      record.returnedModel = data.model;
      record.usage = data.usage;
      record.answer = readAnswer(model, data);
      return record.answer;
    } catch (error) {
      const allowed = /^(openai_http_\d{3}|incomplete_model_reply|empty_model_reply)$/;
      record.error = allowed.test(error.message) ? error.message : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'request_failed';
      throw new Error(record.error);
    } finally { record.elapsedMs = Math.round(performance.now() - started); }
  };
}
