'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ShoppingCart,
  ClipboardList,
  Package,
  Grid3X3,
  Users,
  UserCog,
  Settings,
  LogOut,
  PanelLeft,
  ChefHat,
  UserCircle,
  MessageCircle,
  LifeBuoy,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLandingPage } from '@/components/layout/AuthGuard';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

// null = show for all business types
const ALL_NAV_ITEMS = [
  { href: '/pos', labelKey: 'nav.pos', icon: ShoppingCart, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
  { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, roles: ['owner'], businessTypes: null },
  { href: '/orders', labelKey: 'nav.orders', icon: ClipboardList, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
  { href: '/whatsapp', labelKey: 'nav.whatsapp', icon: MessageCircle, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
  { href: '/products', labelKey: 'nav.products', icon: Package, roles: ['owner', 'manager'], businessTypes: null },
  { href: '/tables', labelKey: 'nav.tables', icon: Grid3X3, roles: ['owner', 'manager'], businessTypes: ['restaurant'] },
  { href: '/settings?tab=kds', labelKey: 'nav.kds', icon: ChefHat, roles: ['owner', 'manager'], businessTypes: ['restaurant'] },
  { href: '/customers', labelKey: 'nav.customers', icon: Users, roles: ['owner', 'manager'], businessTypes: null },
  { href: '/staff', labelKey: 'nav.staff', icon: UserCog, roles: ['owner', 'manager'], businessTypes: null },
  { href: '/settings', labelKey: 'nav.settings', icon: Settings, roles: ['owner', 'manager'], businessTypes: null },
];

export default function AppSidebar() {
  const pathname = usePathname();
  const { user, currentTenant, logout } = useAuthStore();
  const { tablesRequired, kdsEnabled, whatsappEnabled, setTablesRequired, setKdsEnabled, setWhatsappEnabled } = usePosSettingsStore();
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();
  const [emailNeedsAttention, setEmailNeedsAttention] = useState(false);
  const closeMobile = () => { if (isMobile) setOpenMobile(false); };

  const role = currentTenant?.role || 'cashier';
  const businessType = currentTenant?.business_type || 'restaurant';
  const navItems = ALL_NAV_ITEMS.filter((item) => {
    if (item.href === '/tables' && !tablesRequired) return false;
    // KDS disabled → hide the nav entry entirely (issue #133).
    if (item.href === '/settings?tab=kds' && !kdsEnabled) return false;
    // WhatsApp integration not enabled on this tenant → hide the nav entry.
    if (item.href === '/whatsapp' && !whatsappEnabled) return false;
    return item.roles.includes(role)
      && (item.businessTypes === null || item.businessTypes.includes(businessType));
  });
  const homeHref = getLandingPage();

  useEffect(() => {
    if (!currentTenant) return;
    api.get('/settings/business')
      .then((res) => {
        setTablesRequired(typeof res.data.tables_required === 'boolean' ? res.data.tables_required : true);
      })
      .catch(() => { });
    api.get('/settings/kds_enabled')
      .then((res) => setKdsEnabled(res.data.setting?.value !== 'false'))
      .catch(() => { });
    // Sync the WhatsApp enabled flag from the backend so the sidebar shows
    // the nav entry only when the integration is actually enabled on this
    // tenant. The WhatsApp page also writes the store on enable/disable so
    // the sidebar updates without a refetch when the user toggles.
    api.get('/whatsapp/status')
      .then((res) => setWhatsappEnabled(!!res.data?.enabled))
      .catch(() => { });
  }, [currentTenant, setTablesRequired, setKdsEnabled, setWhatsappEnabled]);

  useEffect(() => {
    if (role !== 'owner') return;
    api.get('/settings/cloud/account')
      .then((res) => setEmailNeedsAttention((Boolean(res.data?.email) && !res.data?.verified) || res.data?.deletion_request?.status === 'pending'))
      .catch(() => setEmailNeedsAttention(false));
  }, [role, pathname]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href={homeHref}>
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground font-semibold">
                  {(currentTenant?.business_name || t('common.brandName')).charAt(0).toUpperCase()}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0 leading-none">
                  <span className="font-semibold truncate">{currentTenant?.business_name || t('common.brandName')}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const [hrefPath, hrefQuery] = item.href.split('?');
                const isActive = !hrefQuery && (pathname === hrefPath || pathname?.startsWith(hrefPath + '/'));
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={t(item.labelKey)}>
                      <Link href={item.href} onClick={closeMobile}>
                        <span className="relative flex size-4 shrink-0 items-center justify-center">
                          <item.icon className="size-4 shrink-0" />
                          {item.href === '/settings' && emailNeedsAttention && (
                            <span aria-label="Email verification required" className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-sidebar" />
                          )}
                        </span>
                        <span>{t(item.labelKey)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/support'} tooltip={t('nav.support')}>
              <Link href="/support" onClick={closeMobile}>
                <LifeBuoy />
                <span>{t('nav.support')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleSidebar} tooltip={t('nav.toggleSidebar')}>
              <PanelLeft />
              <span>{t('nav.collapse')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Identity label, not a button — nothing to click through to, so it
                deliberately skips SidebarMenuButton's interactive/hover styling. */}
            <div
              title={user?.name || user?.email || t('nav.user', { defaultValue: 'User' })}
              className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm text-sidebar-foreground/70 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
            >
              <UserCircle />
              <span className="truncate">{user?.name || user?.email || t('nav.user', { defaultValue: 'User' })}</span>
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={async () => { if (await confirm(t('nav.confirmLogout', { defaultValue: 'Are you sure you want to log out?' }))) logout(); }} tooltip={t('nav.logoutTooltip')}>
              <LogOut />
              <span>{t('nav.logout')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      {ConfirmDialog}
    </Sidebar>
  );
}
