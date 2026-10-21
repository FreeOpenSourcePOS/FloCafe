import * as fs from 'fs';
import * as path from 'path';

type BuildIdentity = {
  schema_version: 1;
  build_id: string;
  source_commit: string | null;
  official_release?: boolean;
  posthog_project_token?: string | null;
  posthog_host?: string | null;
};

export function resolveBuildIdentity(metadata: unknown, packaged: boolean): string {
  if (!packaged) return 'dev';
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unknown';
  const value = metadata as Partial<BuildIdentity>;
  if (value.schema_version !== 1 || typeof value.build_id !== 'string') return 'unknown';
  if (value.build_id === 'custom' || value.build_id === 'unknown') return value.build_id;
  if (!/^[0-9a-f]{40}$/i.test(value.build_id) || value.source_commit !== value.build_id)
    return 'unknown';
  return value.build_id;
}

function packagedRuntime(): boolean {
  try {
    return (require('electron') as { app?: { isPackaged?: boolean } }).app?.isPackaged === true;
  } catch {
    return false;
  }
}

/** A packaged release-workflow build. Local packages and CI test packages are not. */
export function resolveOfficialRelease(metadata: unknown, packaged: boolean): boolean {
  if (!packaged || !metadata || typeof metadata !== 'object') return false;
  return (metadata as Partial<BuildIdentity>).official_release === true;
}

function readMetadata(): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build-identity.json'), 'utf8'));
}

export interface BuildPostHogSettings {
  token?: string;
  host?: string;
}

/** The PostHog project a release workflow stamped into the build, if any. */
export function resolveBuildPostHogSettings(metadata: unknown): BuildPostHogSettings {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const value = metadata as Partial<BuildIdentity>;
  const text = (field: unknown) =>
    typeof field === 'string' && field.trim() ? field.trim() : undefined;
  return { token: text(value.posthog_project_token), host: text(value.posthog_host) };
}

export function readBuildPostHogSettings(): BuildPostHogSettings {
  try {
    return resolveBuildPostHogSettings(readMetadata());
  } catch {
    return {};
  }
}

export function isOfficialReleaseBuild(): boolean {
  try {
    return resolveOfficialRelease(readMetadata(), packagedRuntime());
  } catch {
    return false;
  }
}

export function getBuildIdentity(): string {
  const packaged = packagedRuntime();
  if (!packaged) return 'dev';
  try {
    return resolveBuildIdentity(readMetadata(), true);
  } catch {
    return 'unknown';
  }
}
