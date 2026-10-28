import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function snapshotProcessFamily(ids) {
  const selected = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!selected.length) return [];
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
$pending = [int[]](ConvertFrom-Json -InputObject $env:DSH_VERIFY_PROCESS_IDS)
$seen = @{}
while ($pending.Count -gt 0) {
  $filter = ($pending | ForEach-Object { "ProcessId=$_ OR ParentProcessId=$_" }) -join ' OR '
  try {
    $batch = @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,CreationDate |
      Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})
  } catch { throw "Process query [$filter]: $($_.Exception.Message)" }
  $next = @()
  foreach ($item in $batch) {
    $id = [string]$item.ProcessId
    if (-not $seen.ContainsKey($id)) { $seen[$id] = $item; $next += $item.ProcessId }
  }
  $pending = $next
}
ConvertTo-Json -InputObject @($seen.Values) -Compress
`;
  for (let attempt = 0; ; attempt++) {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
            env: { ...process.env, DSH_VERIFY_PROCESS_IDS: JSON.stringify(selected) } },
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const snapshot = JSON.parse(stdout || '[]');
      assert.ok(Array.isArray(snapshot));
      return snapshot;
    } catch (error) {
      const diagnostic = String(error.stderr ?? error.message).replaceAll('\0', '');
      if (attempt >= 2 || !/800705AF/i.test(diagnostic)) throw error;
      await pause(5000);
    }
  }
}
