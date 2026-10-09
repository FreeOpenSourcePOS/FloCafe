import * as fs from 'fs';
import * as path from 'path';

type BuildIdentity = {
  schema_version: 1;
  build_id: string;
  source_commit: string | null;
};

export function resolveBuildIdentity(metadata: unknown, packaged: boolean): string {
  if (!packaged) return 'dev';
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unknown';
  const value = metadata as Partial<BuildIdentity>;
  if (value.schema_version !== 1 || typeof value.build_id !== 'string') return 'unknown';
  if (value.build_id === 'custom' || value.build_id === 'unknown') return value.build_id;
  if (!/^[0-9a-f]{40}$/i.test(value.build_id) || value.source_commit !== value.build_id) return 'unknown';
  return value.build_id;
}

function packagedRuntime(): boolean {
  try {
    return (require('electron') as { app?: { isPackaged?: boolean } }).app?.isPackaged === true;
  } catch {
    return false;
  }
}

export function getBuildIdentity(): string {
  const packaged = packagedRuntime();
  if (!packaged) return 'dev';
  try {
    const metadataPath = path.join(__dirname, '..', 'build-identity.json');
    return resolveBuildIdentity(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), true);
  } catch {
    return 'unknown';
  }
}
