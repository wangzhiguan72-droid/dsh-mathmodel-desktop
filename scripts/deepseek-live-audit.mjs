// Provider traffic observer for an owned benchmark Host. Never record headers or credentials.
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

export function installDeepSeekAudit({ filename, maxRequests = 24, maxOutputTokens = 1024, turnBudgetFile }) {
  appendFileSync(filename, '');
  const original = globalThis.fetch;
  let count = 0, started = 0, settled = 0, turnKey, turnCount = 0;
  const state = () => writeFileSync(filename + '.state.json', JSON.stringify({ started, settled, inFlight: started - settled }));
  state();
  const wrapper = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.deepseek.com' || !url.pathname.endsWith('/messages')) return original(input, options);
    const body = JSON.parse(options.body);
    if (turnBudgetFile) {
      const budget = JSON.parse(readFileSync(turnBudgetFile, 'utf8'));
      if (budget.key !== turnKey) { turnKey = budget.key; turnCount = 0; }
      if (!Number.isSafeInteger(budget.maximumRequests) || budget.maximumRequests < 1 || ++turnCount > budget.maximumRequests) {
        appendFileSync(filename, JSON.stringify({ blockedBeforeSend: true, turnKey, reason: 'turn-request-budget' }) + '\n');
        throw new Error('Live benchmark per-turn request budget reached');
      }
    }
    if (++count > maxRequests || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxOutputTokens) {
      appendFileSync(filename, JSON.stringify({ index: count, blockedBeforeSend: true, requestedMaxTokens: body.max_tokens, reason: 'request/output-budget' }) + '\n');
      throw new Error('Live benchmark request/output budget reached');
    }
    const start = Date.now();
    started++; state();
    const record = { auditVersion: 2, index: count, startedAt: new Date(start).toISOString(), requestModel: body.model,
      toolsSha256: digest(body.tools ?? []), toolNames: (body.tools ?? []).map(row => row.name),
      systemSha256: digest(body.system), messagesSha256: digest(body.messages), bodySha256: digest(body),
      inputCharacters: JSON.stringify(body).length, maxOutputTokens: body.max_tokens, rawUsage: {}, responseModel: null };
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      record.usageComplete = Boolean(record.terminalStopObserved && record.terminalUsageObserved && !record.parseErrors && record.responseModel &&
        ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(key => Number.isSafeInteger(record.rawUsage[key]) && record.rawUsage[key] >= 0));
      record.auditIncomplete = !record.usageComplete;
      record.finishedAt = new Date().toISOString(); record.elapsedMs = Date.now() - start;
      appendFileSync(filename, JSON.stringify(record) + '\n'); settled++; state();
    };
    let response;
    try { response = await original(input, options); }
    catch { record.transportError = true; finish(); throw new Error('DeepSeek live benchmark transport failed'); }
    record.httpStatus = response.status;
    if (!response.ok || !response.body) { record.providerError = true; finish(); return response; }
    const decoder = new TextDecoder(), reader = response.body.getReader();
    let pending = '';
    const observe = chunk => {
      pending += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        let event; try { event = JSON.parse(data); } catch { record.parseErrors = (record.parseErrors ?? 0) + 1; continue; }
        if (event.message?.model) record.responseModel = event.message.model;
        const usage = event.message?.usage ?? event.usage;
        if (usage) Object.assign(record.rawUsage, usage);
        if (event.delta?.text && record.firstTextMs === undefined) record.firstTextMs = Date.now() - start;
        if (event.delta?.stop_reason) record.stopReason = event.delta.stop_reason;
        if (event.type === 'message_delta' && event.delta?.stop_reason && Number.isSafeInteger(event.usage?.output_tokens)) record.terminalUsageObserved = true;
        if (event.type === 'message_stop') { record.terminalStopObserved = true; finish(); }
      }
    };
    // Observe the exact stream consumed by the adapter. No asynchronous clone or
    // independently cancelled branch can lose its terminal usage or cross trials.
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { finish(); controller.close(); return; }
          observe(value); controller.enqueue(value);
        } catch (error) { record.streamErrorKind = error.name; finish(); controller.error(error); }
      },
      async cancel(reason) { record.consumerCancelled = true; try { await reader.cancel(reason); } finally { finish(); } },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  globalThis.fetch = wrapper;
  return () => { if (globalThis.fetch === wrapper) globalThis.fetch = original; };
}
