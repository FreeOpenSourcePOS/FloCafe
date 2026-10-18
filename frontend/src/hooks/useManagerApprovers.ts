'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import type { Staff } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import { ROLE_ACCESS, hasRole, type Role } from '@shared/role-permissions';

export interface UseManagerApproversOptions {
  allowedRoles?: readonly Role[];
}

export function useManagerApprovers(options?: UseManagerApproversOptions) {
  const { user } = useAuthStore();
  const allowedRoles = options?.allowedRoles || ROLE_ACCESS.ownerManager;

  const [approvers, setApprovers] = useState<Staff[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/staff', { params: { active: true } })
      .then((res) => {
        if (cancelled) return;
        const staffList: Staff[] = res.data?.staff || [];
        const eligible = staffList.filter(
          (m) => m.is_active !== 0 && Boolean(m.has_pin) && hasRole(m.role, allowedRoles),
        );
        setApprovers(eligible);

        // Pre-select: if current logged-in user is an eligible approver, prefer them.
        // Otherwise, if exactly 1 eligible approver exists, auto-select them.
        const currentUserApprover = eligible.find((m) => String(m.id) === String(user?.id));
        const preferredId =
          currentUserApprover?.id || (eligible.length === 1 ? eligible[0].id : '');
        setSelectedApproverId(preferredId ? String(preferredId) : '');
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setApprovers([]);
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, allowedRoles]);

  const effectiveApproverId = approvers.some((m) => String(m.id) === selectedApproverId)
    ? selectedApproverId
    : approvers.length === 1
      ? String(approvers[0].id)
      : '';

  const selectedApprover = approvers.find((m) => String(m.id) === effectiveApproverId) || null;

  return {
    approvers,
    selectedApproverId: effectiveApproverId,
    setSelectedApproverId,
    selectedApprover,
    loading,
    loadFailed,
  };
}
