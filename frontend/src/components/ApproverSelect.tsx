'use client';

import { Loader2 } from 'lucide-react';
import type { Staff } from '@/lib/types';
import { useTranslations } from 'use-intl';

export interface ApproverSelectProps {
  approvers: Staff[];
  selectedApproverId: string;
  onSelectApprover: (id: string) => void;
  loading?: boolean;
  loadFailed?: boolean;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
  loadFailedMessage?: string;
  emptyMessage?: string;
  className?: string;
}

export function ApproverSelect({
  approvers,
  selectedApproverId,
  onSelectApprover,
  loading = false,
  loadFailed = false,
  disabled = false,
  id = 'approverSelect',
  label,
  placeholder,
  loadFailedMessage,
  emptyMessage,
  className = '',
}: ApproverSelectProps) {
  const tOrders = useTranslations('orders');

  if (loading) {
    return (
      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
        <Loader2 size={14} className="animate-spin" />
        {label || tOrders('refundApproverLabel')}
      </div>
    );
  }

  if (loadFailed) {
    return (
      <p
        className={`rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 ${className}`}
      >
        {loadFailedMessage || 'Could not load approvers. Try again.'}
      </p>
    );
  }

  if (approvers.length === 0) {
    return (
      <div
        className={`rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 ${className}`}
      >
        <p>
          {emptyMessage ||
            'Approval is not configured. Ask the owner to set an Approval PIN in Staff.'}
        </p>
      </div>
    );
  }

  if (approvers.length > 1) {
    return (
      <div className={className}>
        <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1">
          {label || tOrders('refundApproverLabel')}
        </label>
        <select
          id={id}
          value={selectedApproverId}
          onChange={(e) => onSelectApprover(e.target.value)}
          disabled={disabled}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        >
          <option value="">{placeholder || tOrders('refundApproverPlaceholder')}</option>
          {approvers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ({member.role})
            </option>
          ))}
        </select>
      </div>
    );
  }

  const singleApprover = approvers[0];
  return (
    <p className={`text-sm text-muted-foreground ${className}`}>
      {label || tOrders('refundApproverLabel')}:{' '}
      <span className="font-medium text-foreground">{singleApprover.name}</span>
    </p>
  );
}
