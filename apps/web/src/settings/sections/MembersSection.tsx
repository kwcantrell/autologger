import type { Show, Team, TeamInvite, TeamMember, TeamRole } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { qk, useMe, useOpMutation, useTeam } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/shared/components/ui/avatar';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@/shared/components/ui/item';
import { Spinner } from '@/shared/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { useSettingsNav } from '../guard';
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  GrantToggle,
  LoadingState,
  plural,
  RoleLockNotice,
  SettingsSectionHeader,
  YOU_ARE,
} from '../parts';
import { runSaveSteps, type SaveStep, SidePanel, useSidePanel } from '../SidePanel';
import {
  type GrantLevel,
  grantOf,
  isManager,
  memberInitials,
  memberLabel,
  memberPermissions,
  ROLE_LABEL,
} from '../teamRules';

export function MembersSection() {
  const { team } = useActive();
  const nav = useSettingsNav();
  if (!team) {
    return (
      <>
        <SettingsSectionHeader title="Members" description="You’re not on a team yet." />
        <EmptyState
          description="Create a team to invite people to it."
          action={
            <Button variant="outline" onClick={() => nav?.goTo('team')}>
              Go to Team details
            </Button>
          }
        />
      </>
    );
  }
  return <Members team={team} />;
}

function Members({ team }: { team: Team }) {
  const detailQ = useTeam(team.id);
  const { allShows } = useActive();
  const selfId = useMe().data?.id ?? null;
  const role = team.role;
  const manager = isManager(role);
  const shows = allShows.filter((s) => s.teamId === team.id);
  const detail = detailQ.data;
  const { panel, openPanel, closePanel } = useSidePanel<string>();
  const panelMember = detail?.members.find((m) => m.userId === panel?.id) ?? null;

  const members = detail?.members ?? [];
  const invites = manager ? (detail?.invites ?? []) : [];
  const count = plural(members.length, 'member');

  return (
    <>
      <SettingsSectionHeader title="Members" description={`${team.name} · ${YOU_ARE[role]}`} />
      {!manager && (
        <RoleLockNotice role={role} teamName={team.name}>
          {`${YOU_ARE[role]} of ${team.name}. Only owners and admins can invite people or change roles and show access.`}
        </RoleLockNotice>
      )}
      <InviteCard teamId={team.id} viewer={role} disabled={!manager} />

      {detailQ.isError ? (
        <ErrorState
          title="Couldn’t load the members."
          detail={errorMessage(detailQ.error)}
          onRetry={() => void detailQ.refetch()}
        />
      ) : !detail ? (
        <LoadingState label="Loading members…" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {invites.length > 0 ? `${count} · ${invites.length} invited` : count}
            </CardTitle>
            {manager && (
              <CardDescription>Open a member to change their role or show access.</CardDescription>
            )}
          </CardHeader>
          <CardContent className="px-2">
            <ItemGroup role="list" aria-label={`${team.name} members`}>
              {members.map((m, i) => (
                <Fragment key={m.userId}>
                  {i > 0 && <ItemSeparator />}
                  <MemberRow
                    member={m}
                    self={m.userId === selfId}
                    showCount={shows.length}
                    manager={manager}
                    onOpen={manager ? () => openPanel(m.userId) : undefined}
                  />
                </Fragment>
              ))}
              {invites.map((inv) => (
                <Fragment key={inv.email}>
                  <ItemSeparator />
                  <InviteRow teamId={team.id} invite={inv} />
                </Fragment>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}

      {manager && panel && panelMember && (
        <MemberPanel
          key={panel.n}
          open={panel.open}
          team={team}
          selfId={selfId}
          member={panelMember}
          shows={shows}
          onClose={closePanel}
        />
      )}
    </>
  );
}

function MemberAvatar({ member }: { member: Pick<TeamMember, 'name' | 'email' | 'pictureUrl'> }) {
  return (
    <Avatar size="lg">
      {member.pictureUrl && <AvatarImage src={member.pictureUrl} alt="" />}
      <AvatarFallback>{memberInitials(member)}</AvatarFallback>
    </Avatar>
  );
}

function MemberRow({
  member,
  self,
  showCount,
  manager,
  onOpen,
}: {
  member: TeamMember;
  self: boolean;
  showCount: number;
  manager: boolean;
  onOpen?: () => void;
}) {
  const label = memberLabel(member);
  const access =
    member.role === 'member'
      ? `${member.grants.length} of ${plural(showCount, 'show')}`
      : 'All shows';
  return (
    <Item
      role="listitem"
      size="sm"
      className="relative flex-nowrap has-[[data-slot=member-open]:hover]:bg-si-panel-2"
    >
      <ItemMedia>
        <MemberAvatar member={member} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          {onOpen ? (
            <Button
              variant="ghost"
              data-slot="member-open"
              className="block h-auto min-w-0 shrink truncate rounded-none border-0 p-0 text-left text-sm leading-snug font-medium not-disabled:hover:bg-transparent not-disabled:hover:text-foreground focus-visible:ring-0 after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
              onClick={onOpen}
            >
              {label}
            </Button>
          ) : (
            <span className="min-w-0 truncate">{label}</span>
          )}
          {self && <Badge variant="secondary">You</Badge>}
        </ItemTitle>
        {member.email && <ItemDescription className="truncate">{member.email}</ItemDescription>}
      </ItemContent>
      <ItemActions className="shrink-0">
        <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
        {manager && (
          <span className="w-[6.5rem] text-right text-sm text-muted-foreground max-sm:hidden">
            {access}
          </span>
        )}
        {onOpen && <ChevronRightIcon aria-hidden="true" className="text-si-dim" />}
      </ItemActions>
    </Item>
  );
}

function InviteRow({ teamId, invite }: { teamId: string; invite: TeamInvite }) {
  const revoke = useOpMutation('teams.revokeInvite', { invalidate: () => [qk.team(teamId)] });
  const [error, setError] = useState<string | null>(null);
  return (
    <Item role="listitem" size="sm" className="flex-nowrap">
      <ItemMedia>
        <Avatar size="lg">
          <AvatarFallback>@</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{invite.email}</span>
        </ItemTitle>
        <ItemDescription className="truncate">
          {error ?? `Invited as ${ROLE_LABEL[invite.role].toLowerCase()}. Joins at first sign-in.`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Badge variant="outline" className="max-sm:hidden">
          Invited
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          disabled={revoke.isPending}
          onClick={() => {
            setError(null);
            revoke.mutate(
              { teamId, email: invite.email },
              { onError: (err) => setError(`Couldn’t revoke: ${errorMessage(err)}`) },
            );
          }}
        >
          {revoke.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}

function InviteCard({
  teamId,
  viewer,
  disabled,
}: {
  teamId: string;
  viewer: TeamRole;
  disabled: boolean;
}) {
  const invite = useOpMutation('teams.invite', { invalidate: () => [qk.team(teamId)] });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value || disabled) return;
    setError(null);
    invite.mutate(
      { teamId, email: value, role },
      {
        onSuccess: (detail) => {
          setEmail('');
          const joined = detail.members.some((m) => m.email.toLowerCase() === value.toLowerCase());
          showToast(
            joined
              ? `${value} already had an account and joined the team.`
              : `Invite sent to ${value}.`,
          );
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>
          They join when they first sign in with this email (right away if they already have an
          account). Choose their shows here afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <form
          onSubmit={submit}
          className="flex flex-wrap items-end gap-2 max-sm:flex-col max-sm:items-stretch"
        >
          <Field data-disabled={disabled || undefined} className="min-w-[14rem] flex-1">
            <FieldLabel htmlFor="settings-invite-email">Email address</FieldLabel>
            <Input
              id="settings-invite-email"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              disabled={disabled}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {viewer === 'owner' && (
            <ToggleGroup
              variant="outline"
              aria-label="Role for the invite"
              disabled={disabled}
              value={[role]}
              onValueChange={([v]) => {
                if (v === 'member' || v === 'admin') setRole(v);
              }}
            >
              <ToggleGroupItem value="member">Member</ToggleGroupItem>
              <ToggleGroupItem value="admin">Admin</ToggleGroupItem>
            </ToggleGroup>
          )}
          <Button type="submit" disabled={disabled || invite.isPending || email.trim() === ''}>
            {invite.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            Send invite
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface MemberDraft {
  role: TeamRole;
  grants: Record<string, GrantLevel>;
  remove: boolean;
}

const draftOf = (m: TeamMember, shows: Show[]): MemberDraft => ({
  role: m.role,
  grants: Object.fromEntries(shows.map((s) => [s.id, grantOf(m, s.id)])),
  remove: false,
});

function MemberPanel({
  open,
  team,
  selfId,
  member,
  shows,
  onClose,
}: {
  open: boolean;
  team: Team;
  selfId: string | null;
  member: TeamMember;
  shows: Show[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, confirmElement } = useConfirm();
  const [draft, setDraft] = useState<MemberDraft>(() => draftOf(member, shows));
  const saved = draftOf(member, shows);
  const perms = memberPermissions(team.role, member, selfId);
  const canPick =
    draft.role === 'member' && !draft.remove && (perms.grantShows || perms.changeRole);
  const label = memberLabel(member);
  const self = member.userId === selfId;

  async function stageRemove() {
    const ok = await confirm({
      title: 'Remove member',
      message: `Remove ${label} from ${team.name}? They lose access when you save, including to any open sessions.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) setDraft((d) => ({ ...d, remove: true }));
  }

  async function save() {
    const teamId = team.id;
    const userId = member.userId;
    const steps: SaveStep[] = [];
    if (draft.remove) {
      steps.push({
        label: `remove ${label} from the team`,
        run: () => rpc('teams.removeMember', { teamId, userId }),
      });
    } else {
      if (perms.changeRole && draft.role !== saved.role && draft.role !== 'owner') {
        const role = draft.role;
        steps.push({
          label: `change the role to ${ROLE_LABEL[role]}`,
          run: () => rpc('teams.setRole', { teamId, userId, role }),
        });
      }
      if (canPick) {
        for (const show of shows) {
          const access = draft.grants[show.id] ?? 'none';
          if (access === saved.grants[show.id]) continue;
          steps.push({
            label:
              access === 'none'
                ? `remove access to ${show.name}`
                : `give ${access} access to ${show.name}`,
            run: () => rpc('teams.setGrant', { teamId, userId, showId: show.id, access }),
          });
        }
      }
    }
    try {
      await runSaveSteps(steps);
      showToast('Saved.');
    } finally {
      // Whatever applied shows at once, so a retry sends only the rest.
      await qc.invalidateQueries({ queryKey: qk.team(teamId) });
    }
  }

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        title={label}
        description={self ? `${member.email} · You` : member.email || undefined}
        media={<MemberAvatar member={member} />}
        value={draft}
        baseline={saved}
        onSave={save}
        saveLabel={draft.remove ? 'Remove member' : 'Save'}
      >
        {draft.remove && (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>{`${label} will be removed from ${team.name} when you save.`}</AlertDescription>
          </Alert>
        )}
        <FieldSet>
          <FieldLegend>Role</FieldLegend>
          <Field orientation="horizontal" className="justify-between gap-4">
            <FieldContent className="min-w-0">
              <FieldDescription>
                {member.role === 'owner'
                  ? 'The owner manages roles and can transfer or delete the team.'
                  : perms.changeRole
                    ? 'Admins invite, remove members and grant shows. Members log and review.'
                    : 'Only the owner can change roles.'}
              </FieldDescription>
            </FieldContent>
            {perms.changeRole ? (
              <ToggleGroup
                variant="outline"
                aria-label="Role"
                disabled={draft.remove}
                value={[draft.role]}
                onValueChange={([v]) => {
                  if (v === 'admin' || v === 'member') setDraft({ ...draft, role: v });
                }}
              >
                <ToggleGroupItem value="admin">Admin</ToggleGroupItem>
                <ToggleGroupItem value="member">Member</ToggleGroupItem>
              </ToggleGroup>
            ) : (
              <Badge variant="outline">{ROLE_LABEL[member.role]}</Badge>
            )}
          </Field>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Show access</FieldLegend>
          {canPick ? (
            shows.length === 0 ? (
              <FieldDescription>{team.name} has no shows yet.</FieldDescription>
            ) : (
              <FieldGroup className="gap-3">
                <FieldDescription>
                  Read can open sessions; Write can also log events and edit.
                </FieldDescription>
                {shows.map((show) => (
                  <Field key={show.id} orientation="horizontal" className="justify-between gap-3">
                    <FieldTitle className="min-w-0 truncate font-normal">{show.name}</FieldTitle>
                    <GrantToggle
                      label={`${label}’s access to ${show.name}`}
                      value={draft.grants[show.id] ?? 'none'}
                      onChange={(v) =>
                        setDraft({ ...draft, grants: { ...draft.grants, [show.id]: v } })
                      }
                    />
                  </Field>
                ))}
              </FieldGroup>
            )
          ) : (
            <FieldDescription>
              {draft.remove
                ? 'Removed members lose access to every show.'
                : `${ROLE_LABEL[draft.role]}s can open every show in the team.`}
            </FieldDescription>
          )}
        </FieldSet>

        {perms.remove && (
          <FieldSet>
            <FieldLegend>Membership</FieldLegend>
            <Field orientation="horizontal" className="justify-between gap-4">
              <FieldContent className="min-w-0">
                <FieldTitle>Remove from team</FieldTitle>
                <FieldDescription>
                  They lose access right away, including any open sessions.
                </FieldDescription>
              </FieldContent>
              {draft.remove ? (
                <Button variant="outline" onClick={() => setDraft({ ...draft, remove: false })}>
                  Keep on team
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => void stageRemove()}>
                  Remove…
                </Button>
              )}
            </Field>
          </FieldSet>
        )}
      </SidePanel>
      {confirmElement}
    </>
  );
}
