'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, Check, LockKeyhole, Minus, RotateCcw } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import type { Staff } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { MasterPinPrompt } from './MasterPinPrompt';
import toast from 'react-hot-toast';
import type { PermissionArea, PermissionEffect, PermissionId, PermissionRisk } from '@shared/permissions';
import { ROLE_KEYS, type Role } from '@shared/role-permissions';
import { ROLE_LABEL_KEYS } from '@/lib/i18n-enums';

type PermissionDefinition = {
  id: PermissionId;
  area: PermissionArea;
  defaultRoles: readonly Role[];
  configurable: boolean;
  risk: PermissionRisk;
};
type PermissionValue = { permission_id: PermissionId; allowed: boolean; source: 'shipped_default' | 'role_override' | 'user_override' | 'protected_rule' };
type OverrideValue = { permission_id: PermissionId; effect: PermissionEffect };
type RolePayload = { role: Role; revision: string; overrides: OverrideValue[]; permissions: PermissionValue[] };
type UserPayload = { user: Staff; revision: string; overrides: OverrideValue[]; permissions: PermissionValue[] };

function overrideRecord(values: OverrideValue[]): Partial<Record<PermissionId, PermissionEffect>> {
  return Object.fromEntries(values.map(({ permission_id, effect }) => [permission_id, effect]));
}

function errorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error) && typeof error.response?.data?.error === 'string') return error.response.data.error;
  return fallback;
}

/**
 * The administrative surface the backend capability floor protects. Mirrors
 * ADMINISTRATIVE_PERMISSION_IDS in main/services/authorization.ts so the row
 * that costs the actor their own access is named before the save, not only by
 * the server's refusal after it.
 */
const ADMINISTRATIVE_PERMISSION_IDS = [
  'authorization.manage',
  'staff.privileged.manage',
  'staff.operational.manage',
  'settings.manage',
] as const satisfies readonly PermissionId[];

type SelfAccessMessageKey =
  | 'selfAccessWarningAuthorization'
  | 'selfAccessWarningStaffPrivileged'
  | 'selfAccessWarningStaffOperational'
  | 'selfAccessWarningSettings';

type AdministrativePermissionId = (typeof ADMINISTRATIVE_PERMISSION_IDS)[number];

const ADMINISTRATIVE_SURFACE_KEYS: Record<AdministrativePermissionId, SelfAccessMessageKey> = {
  'authorization.manage': 'selfAccessWarningAuthorization',
  'staff.privileged.manage': 'selfAccessWarningStaffPrivileged',
  'staff.operational.manage': 'selfAccessWarningStaffOperational',
  'settings.manage': 'selfAccessWarningSettings',
};

type RefusalCode = 'administration_unreachable' | 'self_privilege_change_requires_factor';

function refusalCode(error: unknown): { status?: number; code?: RefusalCode; requires?: string } {
  if (!axios.isAxiosError(error)) return {};
  const data = error.response?.data as { code?: string; requires?: string } | undefined;
  return {
    status: error.response?.status,
    code: data?.code as RefusalCode | undefined,
    requires: data?.requires,
  };
}

export function permissionLabel(permissionId: PermissionId): string {
  return permissionId.split('.').map((part) => part.replace(/-/g, ' ')).join(' · ');
}

export function PermissionMatrix({ staff }: { staff: Staff[] }) {
  const t = useTranslations('permissionMatrix');
  const tStaff = useTranslations('staff');
  const tCommon = useTranslations('common');
  const refreshAuthContext = useAuthStore((state) => state.refreshAuthContext);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const currentTenantRole = useAuthStore((state) => state.currentTenant?.role);
  const [catalog, setCatalog] = useState<PermissionDefinition[]>([]);
  const [roles, setRoles] = useState<RolePayload[]>([]);
  const [selectedRole, setSelectedRole] = useState<Role>('manager');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userPayload, setUserPayload] = useState<UserPayload | null>(null);
  const [overrides, setOverrides] = useState<Partial<Record<PermissionId, PermissionEffect>>>({});
  const [mode, setMode] = useState<'role' | 'user'>('role');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pinGateOpen, setPinGateOpen] = useState(false);
  // One retry only: a second 428 after the PIN is a refusal, not another prompt.
  const pinRetried = useRef(false);

  const actorId = String(currentUserId ?? '');
  /** The proposed save changes the actor's own effective set only when it targets them. */
  const targetsActor = mode === 'user'
    ? selectedUserId !== '' && selectedUserId === actorId
    : selectedRole === currentTenantRole;
  /** Unknown when the actor is not in the loaded list; assume a PIN and let the server decide. */
  const actorHasPin = useMemo(
    () => { const actor = staff.find((member) => member.id === actorId); return actor ? Boolean(actor.has_pin) : true; },
    [staff, actorId],
  );

  const loadRoles = useCallback(async (): Promise<RolePayload[]> => {
    const [{ data: catalogData }, { data: roleData }] = await Promise.all([
      api.get('/authorization/catalog'),
      api.get('/authorization/roles'),
    ]);
    setCatalog(catalogData.permissions || []);
    const loadedRoles = roleData.roles || [];
    setRoles(loadedRoles);
    return loadedRoles;
  }, []);

  useEffect(() => {
    Promise.all([api.get('/authorization/catalog'), api.get('/authorization/roles')])
      .then(([catalogResponse, rolesResponse]) => {
        const loadedRoles: RolePayload[] = rolesResponse.data.roles || [];
        setCatalog(catalogResponse.data.permissions || []);
        setRoles(loadedRoles);
        setOverrides(overrideRecord(loadedRoles.find(({ role }) => role === 'manager')?.overrides || []));
      })
      .catch((error) => toast.error(errorMessage(error, tCommon('somethingWrong'))))
      .finally(() => setLoading(false));
  }, [tCommon]);

  const rolePayload = roles.find(({ role }) => role === selectedRole) ?? null;

  const selectUser = async (userId: string) => {
    setSelectedUserId(userId);
    setUserPayload(null);
    setOverrides({});
    if (!userId) return;
    setLoading(true);
    api.get(`/authorization/users/${userId}`)
      .then(({ data }) => { setUserPayload(data); setOverrides(overrideRecord(data.overrides || [])); })
      .catch((error) => toast.error(errorMessage(error, tCommon('somethingWrong'))))
      .finally(() => setLoading(false));
  };

  const activePayload = mode === 'role' ? rolePayload : userPayload;
  const effectiveById = useMemo(() => new Map((activePayload?.permissions || []).map((permission) => [permission.permission_id, permission])), [activePayload]);
  const areas = useMemo(() => [...new Set(catalog.map(({ area }) => area))], [catalog]);

  const save = async (pin?: string) => {
    if (!activePayload) return;
    // Latch this attempt, not the session: a fresh save may prompt again, so a
    // mistyped PIN is correctable without a reload.
    pinRetried.current = Boolean(pin);
    setRefusal(null);
    setSaving(true);
    const body = {
      revision: activePayload.revision,
      overrides: Object.entries(overrides).map(([permission_id, effect]) => ({ permission_id, effect })),
      ...(pin ? { pin } : {}),
    };
    try {
      if (mode === 'role') {
        const { data } = await api.put(`/authorization/roles/${selectedRole}`, body);
        setRoles((current) => current.map((role) => role.role === selectedRole ? data.role : role));
        setOverrides(overrideRecord(data.role.overrides));
      } else if (selectedUserId) {
        const { data } = await api.put(`/authorization/users/${selectedUserId}`, body);
        setUserPayload(data);
        setOverrides(overrideRecord(data.overrides));
      }
      await refreshAuthContext();
      toast.success(tCommon('done'));
    } catch (error) {
      const { status, code, requires } = refusalCode(error);
      if (code === 'administration_unreachable' && status === 400) {
        const message = t('administrationUnreachable');
        setRefusal(message);
        toast.error(message);
      } else if (code === 'self_privilege_change_requires_factor' && status === 428) {
        if (requires === 'pin' && !pinRetried.current && actorHasPin) {
          setPinGateOpen(true);
          return;
        }
        const message = t('selfPrivilegeNotConfirmed');
        setRefusal(message);
        toast.error(message);
      } else {
        toast.error(errorMessage(error, tCommon('failedToSave')));
      }
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const loadedRoles = await loadRoles();
        if (mode === 'role') setOverrides(overrideRecord(loadedRoles.find(({ role }) => role === selectedRole)?.overrides || []));
        if (mode === 'user' && selectedUserId) {
          const { data } = await api.get(`/authorization/users/${selectedUserId}`);
          setUserPayload(data);
          setOverrides(overrideRecord(data.overrides || []));
        }
      }
    } finally { setSaving(false); }
  };

  const reset = async () => {
    if (!activePayload) return;
    setSaving(true);
    try {
      if (mode === 'role') {
        const { data } = await api.put(`/authorization/roles/${selectedRole}`, { revision: activePayload.revision, overrides: [] });
        setRoles((current) => current.map((role) => role.role === selectedRole ? data.role : role));
        setOverrides({});
      } else if (selectedUserId) {
        const { data } = await api.delete(`/authorization/users/${selectedUserId}/overrides`, { data: { revision: activePayload.revision } });
        setUserPayload(data);
        setOverrides({});
      }
      await refreshAuthContext();
      toast.success(tCommon('done'));
    } catch (error) { toast.error(errorMessage(error, tCommon('failedToSave'))); }
    finally { setSaving(false); }
  };

  if (loading && catalog.length === 0) return <section className="mt-8 rounded-xl border border-border bg-card p-6">{tCommon('loading')}</section>;

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-6" aria-labelledby="permission-matrix-title">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="permission-matrix-title" className="font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('editorSubtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reset} disabled={saving || !activePayload}><RotateCcw size={14} className="me-1" /> {tCommon('restore')}</Button>
          <Button size="sm" onClick={() => { void save(); }} disabled={saving || !activePayload}>{saving ? tCommon('saving') : tCommon('save')}</Button>
        </div>
      </div>

      {refusal && (
        <p role="alert" data-testid="permission-save-refusal" className="mb-5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{refusal}</span>
        </p>
      )}

      <div className="mb-5 flex flex-wrap gap-3">
        <div className="inline-flex rounded-lg border border-border p-1">
          <button type="button" onClick={() => { setMode('role'); setOverrides(overrideRecord(rolePayload?.overrides || [])); }} className={`rounded px-3 py-1.5 text-sm ${mode === 'role' ? 'bg-brand text-white' : 'text-muted-foreground'}`}>{t('roleDefaultsTab')}</button>
          <button type="button" onClick={() => { setMode('user'); setSelectedUserId(''); setUserPayload(null); setOverrides({}); }} className={`rounded px-3 py-1.5 text-sm ${mode === 'user' ? 'bg-brand text-white' : 'text-muted-foreground'}`}>{t('staffExceptionTab')}</button>
        </div>
        {mode === 'role' ? (
          <select value={selectedRole} onChange={(event) => { const role = event.target.value as Role; setSelectedRole(role); setOverrides(overrideRecord(roles.find((entry) => entry.role === role)?.overrides || [])); }} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
            {ROLE_KEYS.map((role) => <option key={role} value={role}>{tStaff(ROLE_LABEL_KEYS[role] as never)}</option>)}
          </select>
        ) : (
          <select value={selectedUserId} onChange={(event) => { void selectUser(event.target.value); }} className="min-w-64 rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="">{t('selectStaffPlaceholder')}</option>
            {staff.map((member) => <option key={member.id} value={member.id}>{member.name} · {tStaff(ROLE_LABEL_KEYS[member.role] as never)}</option>)}
          </select>
        )}
      </div>

      {!activePayload ? <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t('selectStaffEmptyState')}</p> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-[48rem] w-full border-collapse text-sm">
            <thead className="bg-muted"><tr><th className="px-4 py-3 text-start">{t('capabilityHeader')}</th><th className="w-40 px-3 py-3 text-start">{t('effectiveHeader')}</th><th className="w-48 px-3 py-3 text-start">{t('overrideHeader')}</th></tr></thead>
            <tbody>
              {areas.map((area) => <Fragment key={area}>
                <tr><th colSpan={3} className="border-y border-border bg-muted px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">{area.replace(/-/g, ' ')}</th></tr>
                {catalog.filter((permission) => permission.area === area).map((permission) => {
                  const selected = overrides[permission.id] || 'inherit';
                  const inherited = effectiveById.get(permission.id);
                  const effective = selected === 'allow' ? true : selected === 'deny' ? false : inherited?.allowed === true;
                  const costsActorAccess = targetsActor && inherited?.allowed === true && !effective
                    && (ADMINISTRATIVE_PERMISSION_IDS as readonly PermissionId[]).includes(permission.id);
                  return <tr key={permission.id} className="border-b border-border last:border-b-0">
                    <th className="px-4 py-3 text-start font-medium"><span className="block capitalize">{permissionLabel(permission.id)}</span><code className="text-xs font-normal text-muted-foreground">{permission.id}</code></th>
                    <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 ${effective ? 'text-emerald-600' : 'text-muted-foreground'}`}>{effective ? <Check size={15} /> : <Minus size={15} />}{effective ? t('allowed') : t('notAllowed')}</span></td>
                    <td className="px-3 py-3">{permission.configurable ? (
                      <select value={selected} onChange={(event) => setOverrides((current) => {
                        const next = { ...current }; const value = event.target.value;
                        if (value === 'inherit') delete next[permission.id]; else next[permission.id] = value as PermissionEffect;
                        return next;
                      })} className="w-full rounded-md border border-border bg-background px-2 py-1.5">
                        <option value="inherit">{t('inherit')}</option><option value="allow">{t('allow')}</option><option value="deny">{t('deny')}</option>
                      </select>
                    ) : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><LockKeyhole size={14} /> {t('protected')}</span>}
                    {costsActorAccess && (
                      <p data-testid="permission-self-access-warning" className="mt-1.5 flex items-start gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span>{t(ADMINISTRATIVE_SURFACE_KEYS[permission.id as AdministrativePermissionId])}</span>
                      </p>
                    )}
                  </td>
                  </tr>;
                })}
              </Fragment>)}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">{t('editorFooterNote')}</p>

      <MasterPinPrompt
        open={pinGateOpen}
        mode="verify"
        title={t('selfPrivilegeChangeTitle')}
        description={t('selfPrivilegeChangePrompt')}
        onCancel={() => setPinGateOpen(false)}
        onSubmit={async (pin) => { setPinGateOpen(false); await save(pin); return { success: true }; }}
      />
    </section>
  );
}
