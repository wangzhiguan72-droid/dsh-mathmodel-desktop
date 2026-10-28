import { z } from 'zod';

const PACKAGE = '@deepseek-harness/dsh-mathmodel';
const strictCodec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema, create: () => schema });
const result = (symbol) => strictCodec(symbol, z.unknown());
const parameter = (name, schema = z.string()) => ({
  name, wire: name, source: 'json',
  codec: strictCodec(`mathmodel#${name}`, schema),
});
const invocation = (service, method, parameters = []) => ({
  id: `${PACKAGE}#${service}/${method}`,
  service, namespace: service, method,
  invocation: { kind: 'direct' }, parameters,
  result: result(`mathmodel#${service}.${method}.result`),
});

const draftSchema = z.object({
  name: z.string(),
  template: z.string(),
  adapter: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
});

export const MATHMODEL_INVOCATIONS = Object.freeze([
  invocation('mathmodelHostCapabilities', 'describe', [parameter('sessionId')]),
  invocation('mathmodelHostCapabilities', 'confirm', [parameter('sessionId'), parameter('preset'), parameter('hostHash')]),
  invocation('mathmodelHostCapabilities', 'describeTools', [parameter('sessionId')]),
  invocation('mathmodelHostCapabilities', 'setTools', [parameter('sessionId'), parameter('selection', z.object({ skills: z.boolean(), mcp: z.boolean(), taskBoard: z.boolean(), disabledMcpServers: z.array(z.string()) }).strict())]),
  invocation('mathmodelHostCapabilities', 'selectModel', [parameter('sessionId'), parameter('provider'), parameter('model')]),
  invocation('mathmodelCards', 'list'),
  invocation('mathmodelCards', 'help'),
  invocation('mathmodelCards', 'render', [parameter('skill'), parameter('values', z.record(z.string(), z.unknown()))]),
  invocation('mathmodelCredentials', 'describe', [parameter('ref')]),
  invocation('mathmodelCredentials', 'set', [parameter('ref'), parameter('value')]),
  invocation('mathmodelCredentials', 'unset', [parameter('ref')]),
  invocation('mathmodelPreflight', 'run'),
  // 仅用于新浏览器插件遇到旧 Host 时的只读兼容回退；新 UI 不再写 v1 设置。
  invocation('mathmodelProviders', 'status'),
  invocation('mathmodelImageConnections', 'list'),
  invocation('mathmodelImageConnections', 'upsert', [parameter('draft', draftSchema), parameter('id', z.string())]),
  invocation('mathmodelImageConnections', 'setKey', [parameter('id'), parameter('value')]),
  invocation('mathmodelImageConnections', 'clearKey', [parameter('id')]),
  invocation('mathmodelImageConnections', 'discoverModels', [parameter('id')]),
  invocation('mathmodelImageConnections', 'verify', [parameter('id'), parameter('authorizePaid', z.boolean())]),
  invocation('mathmodelImageConnections', 'setActive', [parameter('id')]),
  invocation('mathmodelImageConnections', 'deleteConnection', [parameter('id'), parameter('clearCredential', z.boolean())]),
  invocation('mathmodelOpenCodeRt', 'configure', [parameter('apiKey')]),
  invocation('mathmodelOpenCodeRt', 'refresh'),
  invocation('mathmodelStoredKeyModelDiscovery', 'discover', [parameter('provider')]),
  invocation('mathmodelManualVision', 'stage', [parameter('images', z.array(z.object({ mediaType: z.string(), data: z.string(), name: z.string().optional() }))), parameter('workspace', z.string())]),
]);
