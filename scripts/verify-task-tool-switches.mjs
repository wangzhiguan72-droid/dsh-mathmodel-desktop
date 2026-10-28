// Installed Host smoke check; creates only blank fixture Sessions and calls no model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInstalledHostClient } from './installed-host-client.mjs';

const client = await createInstalledHostClient();
const sessions = [];
const receipt = { observedAt: new Date().toISOString(), modelRequests: 0, checks: {} };
const selection = { skills: false, mcp: false, taskBoard: false, disabledMcpServers: [] };
const describe = sessionId => client.rpc('mathmodelHostCapabilities', 'describeTools', { sessionId });
const folder = path.resolve('dist/task-tool-switches');
await fs.mkdir(folder, { recursive: true });
try {
  for (let i = 0; i < 2; i++) {
    const created = await client.rpc('session', 'create', { request: { cwd: folder, agentPreset: 'standard' } });
    sessions.push(created.sessionId);
  }
  const before = await describe(sessions[0]);
  const other = await describe(sessions[1]);
  const disabled = await client.rpc('mathmodelHostCapabilities', 'setTools', { sessionId: sessions[0], selection });
  assert.equal(disabled.skillToolAvailable, false);
  assert.equal(disabled.effectiveToolNames.some(name => name.startsWith('mcp__') || name.startsWith('task_board_')), false);
  assert.deepEqual((await describe(sessions[1])).effectiveToolNames, other.effectiveToolNames);
  assert.ok(disabled.toolCount < before.toolCount);
  const projection = await client.rpc('session', 'projections', { request: { sessionId: sessions[0] } });
  assert.deepEqual(projection.values.mathmodelToolSwitches, selection);
  // Present only in the 2026-10-28 build: proves the installed Host loaded the cache-preserving switches.
  assert.deepEqual(projection.values.mathmodelToolSwitchWire, { selection, started: false });
  receipt.checks = { toolCountBefore: before.toolCount, toolCountAfter: disabled.toolCount, otherTaskUnchanged: true,
    skillHidden: true, mcpHidden: true, taskBoardHidden: true, persisted: true, wireProjectionLoaded: true,
    mcp: before.inventory.find(row => row.id === 'mcp').servers.map(({ serverName, publishedTools }) => ({ serverName, publishedTools })) };
  const restored = await client.rpc('mathmodelHostCapabilities', 'setTools', { sessionId: sessions[0], selection: before.selection });
  assert.deepEqual(restored.effectiveToolNames, before.effectiveToolNames);
  receipt.checks.restored = true;
  // Selecting the already chosen route tests dispatch without changing the user's default.
  if (before.model?.provider && before.model.provider !== 'dsh-model-fusion') {
    const same = await client.rpc('mathmodelHostCapabilities', 'selectModel', {
      sessionId: sessions[0], provider: before.model.provider, model: before.model.model,
    });
    assert.equal(same.model.provider, before.model.provider);
    receipt.checks.nativeModelSelection = true;
  }
  for (const sessionId of sessions) {
    const state = await client.rpc('session', 'projections', { request: { sessionId } });
    assert.equal(state.values.sessionListMetadata.blank, true);
  }
  receipt.checks.noConversationSent = true;
} finally {
  for (const sessionId of sessions) await client.rpc('workspace', 'archiveSession', { request: { sessionId } });
  receipt.fixtureSessions = sessions;
  receipt.fixturesArchived = true;
  await fs.writeFile(path.join(folder, 'installed-verification.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt));
