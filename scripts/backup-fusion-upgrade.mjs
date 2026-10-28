import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { snapshotData } from './bootstrap-data-snapshot.mjs';

const backupRoot = path.resolve('dist/fusion-installed-verification');
fs.mkdirSync(backupRoot, { recursive: true });
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs/dsh-mathmodel-desktop');
const home = path.join(os.homedir(), '.dsh-mathmodel');
const userData = path.join(process.env.APPDATA, 'dsh-mathmodel-desktop');
const snapshot = snapshotData({ home, userData, backupRoot, nonce: randomUUID() });
const previousInstall = path.join(backupRoot, 'previous-install');
fs.cpSync(installDir, previousInstall, { recursive: true, dereference: false, errorOnExist: true, force: false });
const receipt = { snapshot, previousInstall, installDir, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(backupRoot, 'upgrade-backup.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ backup: snapshot.backup, previousInstall, installDir }));
