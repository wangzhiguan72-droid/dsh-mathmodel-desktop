import Schema from '@deepseek-ai/schemastery';
import { scopeOf } from '@deepseek-ai/dsh-scope';

export const name = 'dsh-task-capabilities';
export const inject = ['tools'];
export const Config = Schema.object({ images: Schema.boolean().default(false) });
export const IMAGE_TOOLS = Object.freeze(['vision_analyze', 'image_generate', 'editable_ppt_image']);

export function apply(ctx, config) {
  if (scopeOf(ctx) === undefined) throw new Error('Task capabilities require an agent preset scope');
  ctx.on('agent/pre-step', async (_payload, next) => ctx.get('mathmodelHostCapabilities') ? next() : { kind: 'reject' }, { prepend: true });
  if (config.images) return;
  const denied = new Set(IMAGE_TOOLS);
  // Guard also contains late registration and a same-name scoped shadow.
  ctx.tools.guard(exec => denied.has(exec.name) ? '当前任务未启用视觉/生图；请在新任务开始前选择能力组合。' : undefined);
  let signature = '', dispose, refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const known = ctx.tools.view(scopeOf(ctx)).restrictableNames;
      const names = IMAGE_TOOLS.filter(tool => known.has(tool));
      const next = names.join(',');
      if (next === signature) return;
      signature = next;
      dispose?.();
      dispose = names.length ? ctx.tools.restrict({ deny: names }) : undefined;
    } finally { refreshing = false; }
  };
  ctx.on('tools/change', refresh);
  refresh();
}
