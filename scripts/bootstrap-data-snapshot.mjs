import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { assertSafeRoot, assertSeparateRoots, snapshotData, assertSnapshotCurrent, restoreData } = require('../src/update-data-snapshot.cjs');

