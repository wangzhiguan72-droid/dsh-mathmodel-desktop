/** Serializes pre-turn reads with plugin-manager writes in one Host process. */
export class HostMutationGate {
  #tail = Promise.resolve();

  async #run(operation) {
    if (typeof operation !== 'function') throw new TypeError('Host mutation gate requires an operation');
    let release;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  read(operation) { return this.#run(operation); }
  write(operation) { return this.#run(operation); }
}

export class HostMutationLockedError extends Error {
  constructor(message = '已有开始过首轮的任务仍加载在 Host 中，不能修改全局扩展。请先结束并卸载这些任务，再为新任务配置能力。') {
    super(message);
    this.name = 'HostMutationLockedError';
    this.code = 'host-extensions-locked';
  }
}

/** Unknown projection state is unsafe for a mutation, even when the agent is idle. */
export function hasStartedTaskBoundary(agent) {
  const boundary = agent?.boundary;
  if (!boundary || typeof boundary !== 'object') return true;
  const { openTurnStartSeq, lastTurn } = boundary;
  if (openTurnStartSeq === undefined || !Number.isInteger(lastTurn) || lastTurn < 0) return true;
  if (openTurnStartSeq !== null && (!Number.isInteger(openTurnStartSeq) || openTurnStartSeq < 0)) return true;
  return openTurnStartSeq !== null || lastTurn > 0;
}

export function assertHostMutationAllowed(agents) {
  if (!Array.isArray(agents)) throw new HostMutationLockedError('Cannot verify loaded agents before changing Host extensions.');
  const unsafe = agents.find(hasStartedTaskBoundary);
  if (unsafe) throw new HostMutationLockedError();
}

/** Guard the pinned official 0.2.0-rc.2 change method before wrapping it. */
export function isSupportedPluginManagerChangeSource(source) {
  return typeof source === 'string'
    && /async\s+change\(operation,\s*request,\s*reason\)/.test(source)
    && /withFileLock\(/.test(source)
    && /await\s+operation\(result\)/.test(source)
    && /plugin-manager\/changed/.test(source);
}

/**
 * Wrap a pinned manager instance. The policy check runs inside official change's
 * file lock; the gate remains held until change settles and emits its event.
 */
export function installPluginManagerFreeze(manager, gate, readAgents) {
  if (!manager || typeof manager.change !== 'function'
      || !isSupportedPluginManagerChangeSource(Function.prototype.toString.call(manager.change))) {
    throw new Error('Unsupported dsh-plugin-manager change method shape');
  }
  if (!(gate instanceof HostMutationGate) || typeof readAgents !== 'function') {
    throw new TypeError('Host freeze requires a mutation gate and loaded-agent reader');
  }
  const original = manager.change;
  const previousOwn = Object.getOwnPropertyDescriptor(manager, 'change');
  if (previousOwn && !('value' in previousOwn)) throw new Error('Unsupported dsh-plugin-manager change accessor');
  const wrapped = function change(operation, request, reason) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Plugin-manager change requires an operation'));
    return gate.write(() => original.call(this, async (result) => {
      assertHostMutationAllowed(await readAgents());
      return operation(result);
    }, request, reason));
  };
  Object.defineProperty(manager, 'change', {
    configurable: true,
    enumerable: previousOwn?.enumerable ?? false,
    writable: true,
    value: wrapped,
  });
  return () => {
    if (Object.getOwnPropertyDescriptor(manager, 'change')?.value !== wrapped) return;
    if (previousOwn) Object.defineProperty(manager, 'change', previousOwn);
    else delete manager.change;
  };
}
