'use client';

import { type FormEvent, useEffect, useState } from 'react';
import axios, { type AxiosInstance } from 'axios';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import defaultApi from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { validatePassword } from '@shared/password-policy';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface AccountCredentialsEndpoints {
  me?: string;
  passwordChange?: string;
  pinChange?: string;
}

export interface AccountCredentialsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiClient?: AxiosInstance;
  endpoints?: AccountCredentialsEndpoints;
  initialHasPin?: boolean;
  userId?: string | number;
  onSessionUpdated?: (payload: { token: string; hasPin?: boolean }) => void;
}

const PIN_PATTERN = /^\d{4,6}$/;

export function AccountCredentialsDialog({
  open,
  onOpenChange,
  apiClient,
  endpoints,
  initialHasPin,
  userId,
  onSessionUpdated,
}: AccountCredentialsDialogProps) {
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const client = apiClient ?? defaultApi;
  const mePath = endpoints?.me ?? '/auth/me';
  const passwordChangePath = endpoints?.passwordChange ?? '/auth/password/change';
  const pinChangePath = endpoints?.pinChange ?? '/auth/pin/change';

  const [activeTab, setActiveTab] = useState<'password' | 'pin'>('password');
  const [fetchedHasPin, setFetchedHasPin] = useState<boolean | null>(null);
  const [statusReady, setStatusReady] = useState(false);
  const hasPin = fetchedHasPin ?? Boolean(initialHasPin);
  const statusLoading = open && !statusReady;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  const [currentPin, setCurrentPin] = useState('');
  const [pinCurrentPassword, setPinCurrentPassword] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [showCurrentSecret, setShowCurrentSecret] = useState(false);
  const [showNewPin, setShowNewPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSubmitting, setPinSubmitting] = useState(false);

  const resetForms = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setPasswordError(null);
    setPasswordSubmitting(false);

    setCurrentPin('');
    setPinCurrentPassword('');
    setNewPin('');
    setConfirmNewPin('');
    setShowCurrentSecret(false);
    setShowNewPin(false);
    setPinError(null);
    setPinSubmitting(false);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForms();
      setActiveTab('password');
      setStatusReady(false);
      setFetchedHasPin(null);
    }
    onOpenChange(nextOpen);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    client
      .get(mePath)
      .then(({ data }) => {
        if (cancelled) return;
        if (typeof data?.user?.has_pin === 'boolean') {
          setFetchedHasPin(data.user.has_pin);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setStatusReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, mePath]);

  const formatCredentialError = (error: unknown): string => {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data as
        | { error?: string; attempts_remaining?: number; lockout_minutes?: number }
        | undefined;
      if (status === 429) {
        const waitMatch = typeof body?.error === 'string' ? body.error.match(/(\d+)/) : null;
        const minutes = body?.lockout_minutes ?? (waitMatch ? Number(waitMatch[1]) : 5);
        return tAuth('lockedOut', { minutes });
      }
      if (typeof body?.error === 'string' && body.error.trim()) {
        if (body.attempts_remaining === 0) {
          return tAuth('lockedOut', { minutes: body.lockout_minutes ?? 5 });
        }
        if (typeof body.attempts_remaining === 'number') {
          return `${body.error} ${tAuth('attemptsRemaining', { count: body.attempts_remaining })}`;
        }
        return body.error;
      }
    }
    return tCommon('somethingWrong');
  };

  const captureSubmissionSession = () => {
    const currentStore = useAuthStore.getState();
    const resolvedUserId =
      userId !== undefined
        ? String(userId)
        : currentStore.user?.id !== undefined
          ? String(currentStore.user.id)
          : undefined;
    return {
      userId: resolvedUserId,
      storeUserId: currentStore.user?.id !== undefined ? String(currentStore.user.id) : undefined,
      storeToken: currentStore.token,
    };
  };

  const isSessionValid = (submittingSession: {
    userId?: string;
    storeUserId?: string;
    storeToken?: string | null;
  }) => {
    if (!open) return false;
    if (onSessionUpdated) {
      if (
        submittingSession.userId !== undefined &&
        userId !== undefined &&
        String(userId) !== submittingSession.userId
      ) {
        return false;
      }
      return true;
    }
    const currentStore = useAuthStore.getState();
    if (!currentStore.token || !currentStore.user) {
      return false;
    }
    if (
      submittingSession.storeUserId !== undefined &&
      String(currentStore.user.id) !== submittingSession.storeUserId
    ) {
      return false;
    }
    if (submittingSession.storeToken && currentStore.token !== submittingSession.storeToken) {
      return false;
    }
    return true;
  };

  const applySessionUpdate = (token: unknown, submittingUserId?: string, nextHasPin?: boolean) => {
    if (typeof token !== 'string' || !token) return;
    const authState = useAuthStore.getState();
    const userUpdates = nextHasPin !== undefined ? { has_pin: nextHasPin } : undefined;
    if (onSessionUpdated) {
      if (
        authState.token &&
        submittingUserId !== undefined &&
        authState.user?.id !== undefined &&
        String(authState.user.id) === submittingUserId
      ) {
        authState.replaceSessionToken(token, userUpdates);
      }
      onSessionUpdated({ token, hasPin: nextHasPin });
      return;
    }
    authState.replaceSessionToken(token, userUpdates);
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    if (!validatePassword(newPassword)) {
      setPasswordError(tAuth('recoverPasswordRequirements'));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError(tAuth('passwordsDoNotMatch'));
      return;
    }

    const submittingSession = captureSubmissionSession();
    setPasswordSubmitting(true);
    try {
      const { data } = await client.post(passwordChangePath, {
        current_password: currentPassword,
        password: newPassword,
      });
      if (!isSessionValid(submittingSession)) {
        return;
      }
      applySessionUpdate(data?.token, submittingSession.userId);
      toast.success(tAuth('passwordChangedSuccess'));
      handleDialogOpenChange(false);
    } catch (error) {
      if (!isSessionValid(submittingSession)) {
        return;
      }
      setPasswordError(formatCredentialError(error));
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handlePinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPinError(null);
    if (!PIN_PATTERN.test(newPin)) {
      setPinError(tAuth('pinRequirementsHint'));
      return;
    }
    if (newPin !== confirmNewPin) {
      setPinError(tAuth('pinMismatch'));
      return;
    }

    const submittingSession = captureSubmissionSession();
    setPinSubmitting(true);
    try {
      const payload = hasPin
        ? { current_pin: currentPin, pin: newPin }
        : { current_password: pinCurrentPassword, pin: newPin };
      const { data } = await client.post(pinChangePath, payload);
      if (!isSessionValid(submittingSession)) {
        return;
      }
      setFetchedHasPin(true);
      applySessionUpdate(data?.token, submittingSession.userId, true);
      toast.success(tAuth('pinChangedSuccess'));
      handleDialogOpenChange(false);
    } catch (error) {
      if (!isSessionValid(submittingSession)) {
        return;
      }
      setPinError(formatCredentialError(error));
    } finally {
      setPinSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="account-credentials-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-brand shrink-0" />
            <span>{tAuth('changePasswordAndPin')}</span>
          </DialogTitle>
          <DialogDescription>{tAuth('accountCredentialsSubtitle')}</DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(val) => {
            setActiveTab(val as 'password' | 'pin');
            setPasswordError(null);
            setPinError(null);
          }}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="password" data-testid="credentials-tab-password">
              {tAuth('changePasswordTab')}
            </TabsTrigger>
            <TabsTrigger value="pin" data-testid="credentials-tab-pin">
              {tAuth('changePinTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="password" className="mt-4">
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="self-current-password">{tAuth('currentPasswordLabel')}</Label>
                <div className="relative">
                  <Input
                    id="self-current-password"
                    data-testid="self-current-password"
                    type={showCurrentPassword ? 'text' : 'password'}
                    dir="ltr"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => {
                      setPasswordError(null);
                      setCurrentPassword(e.target.value);
                    }}
                    placeholder={tAuth('currentPasswordPlaceholder')}
                    className="pe-10"
                    required
                  />
                  <button
                    type="button"
                    aria-label={tAuth('togglePasswordVisibility')}
                    onClick={() => setShowCurrentPassword((prev) => !prev)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="self-new-password">{tAuth('recoverNewPasswordLabel')}</Label>
                <div className="relative">
                  <Input
                    id="self-new-password"
                    data-testid="self-new-password"
                    type={showNewPassword ? 'text' : 'password'}
                    dir="ltr"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => {
                      setPasswordError(null);
                      setNewPassword(e.target.value);
                    }}
                    placeholder={tAuth('recoverNewPasswordPlaceholder')}
                    className="pe-10"
                    required
                  />
                  <button
                    type="button"
                    aria-label={tAuth('togglePasswordVisibility')}
                    onClick={() => setShowNewPassword((prev) => !prev)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tAuth('recoverPasswordRequirements')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="self-confirm-password">
                  {tAuth('recoverConfirmPasswordLabel')}
                </Label>
                <Input
                  id="self-confirm-password"
                  data-testid="self-confirm-password"
                  type={showNewPassword ? 'text' : 'password'}
                  dir="ltr"
                  autoComplete="new-password"
                  value={confirmNewPassword}
                  onChange={(e) => {
                    setPasswordError(null);
                    setConfirmNewPassword(e.target.value);
                  }}
                  placeholder={tAuth('recoverConfirmPasswordPlaceholder')}
                  required
                />
              </div>

              {passwordError && (
                <p
                  role="alert"
                  data-testid="self-password-error"
                  className="text-sm font-medium text-destructive"
                >
                  {passwordError}
                </p>
              )}

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogOpenChange(false)}
                  disabled={passwordSubmitting}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  type="submit"
                  data-testid="self-password-submit"
                  disabled={
                    passwordSubmitting || !currentPassword || !newPassword || !confirmNewPassword
                  }
                >
                  {passwordSubmitting ? tCommon('saving') : tAuth('updatePasswordButton')}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          <TabsContent value="pin" className="mt-4">
            <form onSubmit={handlePinSubmit} className="space-y-4">
              {!hasPin && !statusLoading && (
                <p
                  data-testid="first-time-pin-notice"
                  className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
                >
                  {tAuth('firstTimePinNotice')}
                </p>
              )}

              {hasPin ? (
                <div className="space-y-1.5">
                  <Label htmlFor="self-current-pin">{tAuth('currentPinLabel')}</Label>
                  <div className="relative">
                    <Input
                      id="self-current-pin"
                      data-testid="self-current-pin"
                      type={showCurrentSecret ? 'text' : 'password'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      dir="ltr"
                      value={currentPin}
                      onChange={(e) => {
                        setPinError(null);
                        setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                      }}
                      placeholder={tAuth('currentPinPlaceholder')}
                      className="pe-10 font-mono tracking-widest"
                      required
                    />
                    <button
                      type="button"
                      aria-label={tAuth('togglePinVisibility')}
                      onClick={() => setShowCurrentSecret((prev) => !prev)}
                      className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showCurrentSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="self-pin-current-password">{tAuth('currentPasswordLabel')}</Label>
                  <div className="relative">
                    <Input
                      id="self-pin-current-password"
                      data-testid="self-pin-current-password"
                      type={showCurrentSecret ? 'text' : 'password'}
                      dir="ltr"
                      autoComplete="current-password"
                      value={pinCurrentPassword}
                      onChange={(e) => {
                        setPinError(null);
                        setPinCurrentPassword(e.target.value);
                      }}
                      placeholder={tAuth('currentPasswordPlaceholder')}
                      className="pe-10"
                      required
                    />
                    <button
                      type="button"
                      aria-label={tAuth('togglePasswordVisibility')}
                      onClick={() => setShowCurrentSecret((prev) => !prev)}
                      className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showCurrentSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="self-new-pin">{tAuth('newPinLabel')}</Label>
                <div className="relative">
                  <Input
                    id="self-new-pin"
                    data-testid="self-new-pin"
                    type={showNewPin ? 'text' : 'password'}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    dir="ltr"
                    value={newPin}
                    onChange={(e) => {
                      setPinError(null);
                      setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                    }}
                    placeholder="••••"
                    className="pe-10 font-mono tracking-widest"
                    required
                  />
                  <button
                    type="button"
                    aria-label={tAuth('togglePinVisibility')}
                    onClick={() => setShowNewPin((prev) => !prev)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showNewPin ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">{tAuth('pinRequirementsHint')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="self-confirm-pin">{tAuth('confirmNewPinLabel')}</Label>
                <Input
                  id="self-confirm-pin"
                  data-testid="self-confirm-pin"
                  type={showNewPin ? 'text' : 'password'}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  dir="ltr"
                  value={confirmNewPin}
                  onChange={(e) => {
                    setPinError(null);
                    setConfirmNewPin(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                  placeholder="••••"
                  className="font-mono tracking-widest"
                  required
                />
              </div>

              {pinError && (
                <p
                  role="alert"
                  data-testid="self-pin-error"
                  className="text-sm font-medium text-destructive"
                >
                  {pinError}
                </p>
              )}

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDialogOpenChange(false)}
                  disabled={pinSubmitting}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  type="submit"
                  data-testid="self-pin-submit"
                  disabled={
                    pinSubmitting ||
                    statusLoading ||
                    (hasPin ? currentPin.length < 4 : !pinCurrentPassword) ||
                    newPin.length < 4 ||
                    confirmNewPin.length < 4
                  }
                >
                  {pinSubmitting
                    ? tCommon('saving')
                    : hasPin
                      ? tAuth('updatePinButton')
                      : tAuth('setPinButton')}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
