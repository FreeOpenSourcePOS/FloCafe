'use client';

import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const { viewMode, setViewMode } = useKdsView(serverDefault);

  return (
    <div className="h-full flex flex-col">
      <KdsHeader
        userName={conn.user!.name}
        userRole={conn.user!.role}
        connected={conn.connected}
        connectionMode={conn.connectionMode}
        viewMode={viewMode}
        onChangeView={setViewMode}
        onLogout={conn.handleLogout}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'kanban' ? (
          <KdsKanbanBoard orders={conn.orders} updating={conn.updating} updateItemStatus={conn.updateItemStatus} />
        ) : (
          <KdsTabsView
            orders={conn.orders}
            updating={conn.updating}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      {conn.ConfirmDialog}
    </div>
  );
}
