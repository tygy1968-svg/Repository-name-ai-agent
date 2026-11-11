import WebSocket from 'ws';

// Isolated text-mode probe of the configured realtime model. No audio, phone,
// personal memory or executed tools; one bounded session and five short turns.
export function probeVoiceStyle({ apiKey, model, instructions, tools, WebSocketImpl = WebSocket, timeoutMs = 18000 }) {
  if (!apiKey) return Promise.resolve({ ok: false, error: 'probe_key_unavailable' });
  return new Promise(resolve => {
    let socket, done = false, index = 0, ready = false;
    const results = [], seen = new Set();
    const feminine = text => /(?:^|[^\p{L}])(?:рада|готова|поняла|нашла|зрозуміла|знайшла)(?:$|[^\p{L}])/iu.test(text);
    const cases = [
      { id: 'self_ru', text: 'Привет, Кузя. Ты рад меня слышать? Ответь одной короткой фразой по-русски.', check: text => /(?:^|[^\p{L}])рад(?:$|[^\p{L}])/iu.test(text) && !feminine(text) },
      { id: 'repeat_greeting', text: 'Привет ещё раз!', check: text => !/привет|здравствуй|привіт|вітаю/iu.test(text) && !feminine(text) },
      { id: 'self_ua', text: 'Кузю, ти готовий продовжити? Відповідай однією короткою фразою українською.', check: text => /готовий/iu.test(text) && !feminine(text) },
      { id: 'caller_without_telegram', text: 'Я не Юля, у меня нет Telegram. Могу просто поговорить и оставить ей сообщение, без кнопки?', check: text => !/нужно|необходимо|должны|нажмите|нажми|подтверди|не могу|не получится/iu.test(text) && /мож|да|конечно/iu.test(text) },
      { id: 'caller_message_tool', text: 'Запиши сообщение Юле, пожалуйста. Я тестовый собеседник Ника. Приглашаю её на встречу 14 ноября в 17 часов. Это всё, сохрани именно это сообщение.', tool: 'leave_message' }
    ];
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { socket?.close(); } catch { /* Never log transport errors or credentials. */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'probe_timeout', results }), timeoutMs);
    timer.unref?.();
    const send = event => socket.send(JSON.stringify(event));
    const next = () => {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: cases[index].text }] } });
      send({ type: 'response.create', response: { output_modalities: ['text'], max_output_tokens: 128, tool_choice: cases[index].tool ? 'auto' : 'none' } });
    };
    try {
      socket = new WebSocketImpl(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 5000, maxPayload: 1024 * 1024
      });
      socket.on('error', () => finish({ ok: false, error: 'probe_connection_failed', results }));
      socket.on('close', () => finish({ ok: false, error: 'probe_closed', results }));
      socket.on('open', () => send({ type: 'session.update', session: { type: 'realtime', instructions,
        output_modalities: ['text'], tools, tool_choice: 'none' } }));
      socket.on('message', bytes => {
        if (done) return;
        try {
          const event = JSON.parse(bytes.toString());
          if (event.type === 'error') return finish({ ok: false, error: 'probe_api_error', results });
          if (event.type === 'session.updated' && !ready) { ready = true; next(); return; }
          if (!ready || event.type !== 'response.done') return;
          const response = event.response;
          if (!response?.id || seen.has(response.id)) return;
          seen.add(response.id);
          if (response.status !== 'completed' || (!cases[index].tool && response.output?.some(item => item.type === 'function_call'))) {
            return finish({ ok: false, error: 'probe_response_incomplete', results });
          }
          const answer = (response.output || []).filter(item => item.type === 'message')
            .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('').trim().slice(0, 500);
          if (cases[index].tool) {
            const calls = (response.output || []).filter(item => item.type === 'function_call');
            let args; try { args = JSON.parse(calls[0]?.arguments || '{}'); } catch { args = {}; }
            results.push({ id: cases[index].id, tool: calls[0]?.name || null, passed: calls.length === 1 && calls[0].name === cases[index].tool && /14/.test(args.message || '') && /17/.test(args.message || '') });
          } else results.push({ id: cases[index].id, answer, passed: Boolean(answer) && cases[index].check(answer) });
          if (++index === cases.length) return finish({ ok: results.every(row => row.passed), results });
          next();
        } catch { finish({ ok: false, error: 'probe_invalid_event', results }); }
      });
    } catch { finish({ ok: false, error: 'probe_connection_failed', results }); }
  });
}
