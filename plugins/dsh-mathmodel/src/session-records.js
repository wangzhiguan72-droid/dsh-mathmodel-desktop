import * as sessionAPI from '@deepseek-ai/dsh-session';

/** V4 plugin records preserve ignorable metadata without patching the kernel. */
export function appendMathmodelRecord(session, type, data) {
  if (!type.startsWith('mathmodel/')) throw new Error('Invalid mathmodel record type');
  if (session.header?.version >= 4 && typeof sessionAPI.appendPluginRecord === 'function') {
    return sessionAPI.appendPluginRecord(session, `plugin:${type}`, data);
  }
  return session.append(type, data, { ignorable: true });
}

/** Recognize both V3 records and their official V4 migrated names. */
export function mathmodelRecordType(event) {
  return event.type.startsWith('plugin:mathmodel/') ? event.type.slice('plugin:'.length) : event.type;
}

export function isDirectChild(agents, subagents, child, parent) {
  if (!parent || !child || agents.get(parent.id) !== parent
      || child.session.header.origin !== 'subagent' || child.session.header.parentSession !== parent.id) return false;
  if (typeof agents.isOwnedBy === 'function') return agents.isOwnedBy(child.id, parent);
  if (agents.get(child.id) !== child) return false;
  if (typeof subagents?.rootOf !== 'function') return false;
  try { return subagents.rootOf(child) === subagents.rootOf(parent); } catch { return false; }
}
