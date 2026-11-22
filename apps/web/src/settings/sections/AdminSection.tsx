import type { AdminUser, UserStatus } from '@autologger/contract';
import { ShieldIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { qk, useAdminUsers, useMe, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import { Checkbox } from '@/shared/components/ui/checkbox';
import { Spinner } from '@/shared/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  fmtDate,
  LoadingState,
  plural,
  SettingsSectionHeader,
} from '../parts';
import { ROLE_LABEL } from '../teamRules';

const STATUS_LABEL: Record<UserStatus, string> = {
  pending: 'Waiting',
  active: 'Active',
  disabled: 'Disabled',
};
const STATUS_ORDER: Record<UserStatus, number> = { pending: 0, active: 1, disabled: 2 };

export function AdminSection() {
  const me = useMe().data;
  const superadmin = Boolean(me?.isSuperadmin);
  const users = useAdminUsers(superadmin);
  const header = (
    <SettingsSectionHeader
      title="Users"
      description="Everyone with an account on this AutoLogger server. New accounts wait here until approved."
    />
  );
  if (!superadmin) {
    return (
      <>
        {header}
        <EmptyState
          icon={<ShieldIcon aria-hidden="true" />}
          title="Instance admins only"
          description="Only instance admins can see and approve accounts."
        />
      </>
    );
  }
  if (users.isError)
    return (
      <>
        {header}
        <ErrorState
          title="Couldn’t load the users."
          detail={errorMessage(users.error)}
          onRetry={() => void users.refetch()}
        />
      </>
    );
  if (users.isPending)
    return (
      <>
        {header}
        <LoadingState label="Loading users…" />
      </>
    );
  return (
    <>
      {header}
      <UsersTable users={users.data} selfId={me?.id ?? null} />
    </>
  );
}

function UsersTable({ users, selfId }: { users: AdminUser[]; selfId: string | null }) {
  const setStatus = useOpMutation('admin.setStatus', { invalidate: () => [qk.adminUsers] });
  const setSuper = useOpMutation('admin.setSuperadmin', {
    invalidate: () => [qk.adminUsers, qk.me],
  });
  const { confirm, confirmElement } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const sorted = [...users].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
  const pending = users.filter((u) => u.status === 'pending').length;

  async function changeStatus(u: AdminUser, status: UserStatus) {
    if (status === 'disabled') {
      const ok = await confirm({
        title: 'Disable account',
        message: `Disable ${u.email}? They’re signed out everywhere and their agent tokens are revoked. You can re-enable them later.`,
        confirmLabel: 'Disable',
        danger: true,
      });
      if (!ok) return;
    }
    setError(null);
    setBusyId(u.id);
    try {
      await setStatus.mutateAsync({ userId: u.id, status });
      showToast(
        status === 'active'
          ? u.status === 'pending'
            ? `${u.email} approved.`
            : `${u.email} re-enabled.`
          : `${u.email} disabled.`,
      );
    } catch (e) {
      setError(`Couldn’t change ${u.email}: ${errorMessage(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function changeSuper(u: AdminUser, value: boolean) {
    const ok = await confirm({
      title: value ? 'Make instance admin' : 'Remove instance admin',
      message: value
        ? `Make ${u.email} an instance admin? They can approve, disable and promote every account on this server.`
        : `Remove ${u.email}’s instance-admin rights?`,
      confirmLabel: value ? 'Make admin' : 'Remove',
      danger: !value,
    });
    if (!ok) return;
    setError(null);
    setBusyId(u.id);
    try {
      await setSuper.mutateAsync({ userId: u.id, value });
    } catch (e) {
      setError(`Couldn’t change ${u.email}: ${errorMessage(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <ErrorAlert>{error}</ErrorAlert>}
      <Card>
        <CardHeader>
          <CardTitle>{plural(users.length, 'account')}</CardTitle>
          <CardDescription>
            {pending > 0
              ? `${plural(pending, 'account is', 'accounts are')} waiting for approval. They can’t open anything until approved or invited to a team.`
              : 'No one is waiting for approval.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <EmptyState icon={<UsersIcon aria-hidden="true" />} title="No accounts yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">User</TableHead>
                  <TableHead className="text-left">Status</TableHead>
                  <TableHead className="text-left max-md:hidden">Teams</TableHead>
                  <TableHead className="text-left max-sm:hidden">Joined</TableHead>
                  <TableHead className="text-left">Admin</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((u) => {
                  const self = u.id === selfId;
                  const busy = busyId === u.id;
                  return (
                    <TableRow
                      key={u.id}
                      className="[border-bottom:1px_solid_var(--si-line)] last:border-b-0"
                    >
                      <TableCell className="px-[0.625rem] py-2.5 align-middle max-w-[14rem]">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {u.name || u.email}
                            {self && (
                              <Badge variant="secondary" className="ml-2">
                                You
                              </Badge>
                            )}
                          </span>
                          {u.name && (
                            <span className="truncate text-xs text-muted-foreground">
                              {u.email}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="px-[0.625rem] py-2.5 align-middle">
                        <Badge
                          variant={
                            u.status === 'pending'
                              ? 'default'
                              : u.status === 'disabled'
                                ? 'destructive'
                                : 'outline'
                          }
                        >
                          {STATUS_LABEL[u.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-[0.625rem] py-2.5 align-middle max-w-[12rem] max-md:hidden">
                        <span
                          className="block truncate text-sm text-muted-foreground"
                          title={u.teams.map((t) => `${t.name} (${ROLE_LABEL[t.role]})`).join(', ')}
                        >
                          {u.teams.length ? u.teams.map((t) => t.name).join(', ') : 'No teams'}
                        </span>
                      </TableCell>
                      <TableCell className="px-[0.625rem] py-2.5 align-middle text-sm text-muted-foreground max-sm:hidden">
                        {fmtDate(u.createdAt)}
                      </TableCell>
                      <TableCell className="px-[0.625rem] py-2.5 align-middle">
                        <Checkbox
                          className="flex"
                          aria-label={`${u.email} is an instance admin`}
                          checked={u.isSuperadmin}
                          disabled={busy || self}
                          title={
                            self
                              ? 'You can’t remove your own instance-admin rights here.'
                              : undefined
                          }
                          onCheckedChange={(v) => void changeSuper(u, v === true)}
                        />
                      </TableCell>
                      <TableCell className="px-[0.625rem] py-2.5 align-middle text-right">
                        {busy ? (
                          <Spinner aria-label="Saving" />
                        ) : self ? null : u.status === 'pending' ? (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" onClick={() => void changeStatus(u, 'active')}>
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void changeStatus(u, 'disabled')}
                            >
                              Disable
                            </Button>
                          </div>
                        ) : u.status === 'active' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void changeStatus(u, 'disabled')}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void changeStatus(u, 'active')}
                          >
                            Re-enable
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {confirmElement}
    </>
  );
}
