'use client';

import { useEffect, useId, useState } from 'react';
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
  ChefHat,
  UserCircle,
  MessageCircle,
  LifeBuoy,
  ChevronUp,
  Sun,
  Moon,
  Monitor,
  Boxes,
  Receipt,
  Lock,
  KeyRound,
  Pizza,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import {
  CLOUD_ACCOUNT_STATUS_CHANGED_EVENT,
  useCloudAttentionStore,
} from '@/store/cloud-attention';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLandingPage } from '@/components/layout/AuthGuard';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/use-confirm';
import { useThemeModeToggle } from '@/hooks/useThemeModeToggle';
import type { PermissionId } from '@shared/permissions';
import { tenantCan } from '@/lib/permissions';
import { AccountCredentialsDialog } from '@/components/auth/AccountCredentialsDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

// Leaf keys of the `nav` message namespace (use-intl resolves leaf keys
// within the namespace scope, so no dotted keys).
type NavKey = keyof AppConfig['Messages']['nav'];

interface NavItem {
  href: string;
  labelKey: NavKey | 'pizzaMenu';
  icon: LucideIcon;
  permission: PermissionId;
  businessTypes: string[] | null;
}

// null = show for all business types
const ALL_NAV_ITEMS: NavItem[] = [
  { href: '/pos', labelKey: 'pos', icon: ShoppingCart, permission: 'pos.use', businessTypes: null },
  {
    href: '/dashboard',
    labelKey: 'dashboard',
    icon: LayoutDashboard,
    permission: 'dashboard.view',
    businessTypes: null,
  },
  {
    href: '/orders',
    labelKey: 'orders',
    icon: ClipboardList,
    permission: 'orders.read',
    businessTypes: null,
  },
  {
    href: '/whatsapp',
    labelKey: 'whatsapp',
    icon: MessageCircle,
    permission: 'whatsapp.use',
    businessTypes: null,
  },
  {
    href: '/products',
    labelKey: 'products',
    icon: Package,
    permission: 'catalog.manage',
    businessTypes: null,
  },
  {
    href: '/pizza-menu',
    labelKey: 'pizzaMenu',
    icon: Pizza,
    permission: 'catalog.import-export',
    businessTypes: null,
  },
  {
    href: '/inventory',
    labelKey: 'inventory',
    icon: Boxes,
    permission: 'inventory.view',
    businessTypes: null,
  },
  {
    href: '/expenses',
    labelKey: 'expenses',
    icon: Receipt,
    permission: 'expenses.view',
    businessTypes: null,
  },
  {
    href: '/tables',
    labelKey: 'tables',
    icon: Grid3X3,
    permission: 'tables.view',
    businessTypes: ['restaurant'],
  },
  {
    href: '/settings?tab=kds',
    labelKey: 'kds',
    icon: ChefHat,
    permission: 'kitchen.stations.manage',
    businessTypes: ['restaurant'],
  },
  {
    href: '/customers',
    labelKey: 'customers',
    icon: Users,
    permission: 'customers.view',
    businessTypes: null,
  },
  {
    href: '/staff',
    labelKey: 'staff',
    icon: UserCog,
    permission: 'staff.view',
    businessTypes: null,
  },
  {
    href: '/settings',
    labelKey: 'settings',
    icon: Settings,
    permission: 'settings.view',
    businessTypes: null,
  },
];

export default function AppSidebar() {
  const pathname = usePathname();
  const { user, currentTenant, logout, lock } = useAuthStore();
  const { tablesRequired, kdsEnabled, whatsappEnabled, setKdsEnabled, setWhatsappEnabled } =
    usePosSettingsStore();
  const { isMobile, setOpenMobile } = useSidebar();
  const t = useTranslations('nav');
  const tAuth = useTranslations('auth');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tPizza = useTranslations('pizza');
  const { confirm, ConfirmDialog } = useConfirm();
  const canManageCloudAccount = tenantCan(currentTenant, 'cloud.account.manage');
  const cloudAttentionTenantId = useCloudAttentionStore((s) => s.tenantId);
  const cloudNeedsAttention = useCloudAttentionStore((s) => s.anyNeedsAttention);
  const refreshCloudAttention = useCloudAttentionStore((s) => s.refreshForTenant);
  const settingsNeedsAttention =
    canManageCloudAccount &&
    currentTenant?.id != null &&
    cloudAttentionTenantId === currentTenant.id &&
    cloudNeedsAttention;
  const settingsAttentionDescId = useId();
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const tSettings = useTranslations('settings');
  const { mode: themeMode, cycle: cycleThemeMode } = useThemeModeToggle();
  const themeModeIcon = themeMode === 'light' ? Sun : themeMode === 'dark' ? Moon : Monitor;
  const themeModeLabel =
    themeMode === 'light'
      ? tSettings('themeLight')
      : themeMode === 'dark'
        ? tSettings('themeDark')
        : tSettings('themeSystem');
  const ThemeModeIcon = themeModeIcon;

  const businessType = currentTenant?.business_type || 'restaurant';
  const navItems = ALL_NAV_ITEMS.filter((item) => {
    if (item.href === '/tables' && !tablesRequired) return false;
    // Hide KDS settings navigation when KDS is disabled.
    if (item.href === '/settings?tab=kds' && !kdsEnabled) return false;
    // WhatsApp integration not enabled on this tenant → hide the nav entry.
    if (item.href === '/whatsapp' && !whatsappEnabled) return false;
    const permitted =
      item.href === '/staff'
        ? tenantCan(currentTenant, 'staff.view') || tenantCan(currentTenant, 'authorization.manage')
        : item.href === '/settings'
          ? [
              'settings.view',
              'settings.manage',
              'tax-packs.view-test',
              'tax-configuration.manage',
              'tax-packs.manage',
              'printers.manage',
              'print-templates.view',
              'print-templates.manage',
              'payment-methods.manage',
              'cloud.manage',
              'cloud.account.manage',
              'google-drive.manage',
              'database.manage',
              'mobile-access.manage',
              'kitchen.stations.manage',
              'whatsapp.manage',
            ].some((permission) => tenantCan(currentTenant, permission as PermissionId))
          : tenantCan(currentTenant, item.permission);
    return permitted && (item.businessTypes === null || item.businessTypes.includes(businessType));
  });
  const homeHref = getLandingPage(currentTenant);

  useEffect(() => {
    if (!currentTenant) return;
    if (tenantCan(currentTenant, 'settings.view')) {
      api
        .get('/settings/kds_enabled')
        .then((res) => setKdsEnabled(res.data.setting?.value !== 'false'))
        .catch(() => {});
    }
    if (tenantCan(currentTenant, 'whatsapp.use')) {
      // Sync WhatsApp status so the sidebar only shows the entry when enabled.
      api
        .get('/whatsapp/status')
        .then((res) => setWhatsappEnabled(!!res.data?.enabled))
        .catch(() => {});
    } else {
      setWhatsappEnabled(false);
    }
  }, [currentTenant, setKdsEnabled, setWhatsappEnabled]);

  useEffect(() => {
    void refreshCloudAttention(currentTenant);
    if (!canManageCloudAccount) return;
    const handleStatusChanged = () => {
      void refreshCloudAttention(currentTenant, { force: true });
    };
    window.addEventListener(CLOUD_ACCOUNT_STATUS_CHANGED_EVENT, handleStatusChanged);
    return () => {
      window.removeEventListener(CLOUD_ACCOUNT_STATUS_CHANGED_EVENT, handleStatusChanged);
    };
  }, [canManageCloudAccount, currentTenant, refreshCloudAttention]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href={homeHref}>
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground font-semibold">
                  {(currentTenant?.business_name || tCommon('brandName')).charAt(0).toUpperCase()}
                </div>
                <div className="flex flex-col gap-0.5 min-w-0 leading-none">
                  <span className="font-semibold truncate">
                    {currentTenant?.business_name || tCommon('brandName')}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={tCommon('menu')}>
              <SidebarMenu>
                {navItems.map((item) => {
                  const [hrefPath, hrefQuery] = item.href.split('?');
                  const isActive =
                    !hrefQuery && (pathname === hrefPath || pathname?.startsWith(hrefPath + '/'));
                  const label =
                    item.labelKey === 'pizzaMenu' ? tPizza('menuTitle') : t(item.labelKey);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
                        <Link
                          href={item.href}
                          onClick={closeMobile}
                          aria-describedby={
                            item.href === '/settings' && settingsNeedsAttention
                              ? settingsAttentionDescId
                              : undefined
                          }
                        >
                          <span className="relative flex size-4 shrink-0 items-center justify-center">
                            <item.icon className="size-4 shrink-0" />
                            {item.href === '/settings' && settingsNeedsAttention && (
                              <span
                                data-testid="sidebar-settings-attention"
                                aria-hidden="true"
                                className="absolute -end-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-sidebar"
                              />
                            )}
                          </span>
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.href === '/settings' && settingsNeedsAttention && (
                        <span id={settingsAttentionDescId} className="sr-only">
                          Action required
                        </span>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="sidebar-theme-toggle"
              onClick={cycleThemeMode}
              tooltip={`${tSettings('themeTitle')}: ${themeModeLabel}`}
              className="h-auto min-h-8 py-1.5 whitespace-normal"
            >
              <ThemeModeIcon className="size-4 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 leading-tight group-data-[collapsible=icon]:hidden">
                <span className="min-w-0 break-words">{tSettings('themeTitle')}</span>
                <span className="ms-auto min-w-0 break-words text-end text-xs text-muted-foreground">
                  {themeModeLabel}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  className="rounded-xl border-0 bg-sidebar-accent/60 hover:bg-sidebar-accent hover:shadow-xs data-[state=open]:bg-sidebar-accent/90 transition-all h-9 px-3 font-normal group-data-[collapsible=icon]:h-8! group-data-[collapsible=icon]:p-2! group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:rounded-lg"
                  tooltip={user?.name || user?.email || t('user')}
                >
                  <UserCircle className="size-4 shrink-0 text-sidebar-primary" />
                  <span className="font-medium text-sm truncate group-data-[collapsible=icon]:hidden text-sidebar-foreground">
                    {user?.name || user?.email || t('user')}
                  </span>
                  <ChevronUp className="ms-auto size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={isMobile ? 'bottom' : 'top'}
                align={isMobile ? 'end' : 'start'}
                className="w-56 rounded-lg"
              >
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link href="/support" onClick={closeMobile} className="flex items-center gap-2">
                    <LifeBuoy className="size-4 shrink-0" />
                    <span>{t('support')}</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="sidebar-change-credentials-button"
                  onClick={() => {
                    closeMobile();
                    window.setTimeout(() => {
                      setCredentialsOpen(true);
                    }, 0);
                  }}
                  className="cursor-pointer flex items-center gap-2"
                >
                  <KeyRound className="size-4 shrink-0" />
                  <span>{tAuth('changePasswordAndPin')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="sidebar-lock-button"
                  onClick={() => {
                    closeMobile();
                    window.setTimeout(() => {
                      void lock();
                    }, 0);
                  }}
                  className="cursor-pointer flex items-center gap-2"
                >
                  <Lock className="size-4 shrink-0" />
                  <span>{tPos('lockTerminal')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    window.setTimeout(async () => {
                      if (await confirm(t('confirmLogout'))) logout();
                    }, 0);
                  }}
                  className="cursor-pointer text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/50 flex items-center gap-2"
                >
                  <LogOut className="size-4 shrink-0" />
                  <span>{t('logout')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      {ConfirmDialog}
      <AccountCredentialsDialog
        open={credentialsOpen}
        onOpenChange={setCredentialsOpen}
        initialHasPin={user?.has_pin}
        userId={user?.id}
      />
    </Sidebar>
  );
}
