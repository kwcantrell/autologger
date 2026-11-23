import type { Team, TeamMember } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useRoute } from 'wouter';
import { qk, useOpMutation, useTeam } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { CreateTeamForm } from '@/app/Onboarding';
import { selectTeam, useActive } from '@/app/useActive';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { FieldGroup, FieldSeparator } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { useInlineDraft, useSectionGuard } from '../guard';
import {
  ErrorAlert,
  fmtDate,
  plural,
  RoleLockNotice,
  SectionSaveBar,
  SettingRow,
  SettingsSectionHeader,
  YOU_ARE,
} from '../parts';
import { isManager, memberLabel } from '../teamRules';
import { YoutubeAccessCard } from './YoutubeAccessCard';

function CreateTeamCard({ first }: { first?: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a team</CardTitle>
        <CardDescription>
          {first
            ? 'You’ll be its owner.'
            : 'You’ll be its owner. Invite people from Members afterwards.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <CreateTeamForm
          onCreated={(teamId) => {
            selectTeam(teamId);
            showToast('Team created. It’s now the active team.');
          }}
        />
      </CardContent>
    </Card>
  );
}

export function TeamSection() {
  const { team } = useActive();
  if (!team) {
    return (
      <>
        <SettingsSectionHeader title="Team details" description="You’re not on a team yet." />
        <CreateTeamCard first />
      </>
    );
  }
  return <TeamDetails team={team} />;
}

function TeamDetails({ team }: { team: Team }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [onSession] = useRoute('/sessions/:id');
  const { shows } = useActive();
  const detail = useTeam(team.id);
  const rename = useOpMutation('teams.rename', {
    invalidate: () => [qk.me, qk.teams, qk.team(team.id), qk.shows],
  });
  const { confirm, confirmElement } = useConfirm();
  const draft = useInlineDraft(team.id, { name: team.name });
  useSectionGuard('team', draft.dirty, draft.discard);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const role = team.role;
  const canEdit = isManager(role);
  const value = draft.value ?? { name: team.name };
  const showCount = shows.length;
  const transferTargets = (detail.data?.members ?? []).filter((m) => m.role !== 'owner');

  async function save() {
    setSaveError(null);
    try {
      await rename.mutateAsync({ teamId: team.id, name: value.name.trim() });
      draft.markSaved();
      showToast('Saved.');
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }

  async function afterTeamGone() {
    if (onSession) navigate('/');
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.me }),
      qc.invalidateQueries({ queryKey: qk.teams }),
      qc.invalidateQueries({ queryKey: qk.shows }),
    ]);
  }

  async function run(label: string, fn: () => Promise<unknown>, done?: () => Promise<void> | void) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      await done?.();
    } catch (e) {
      setActionError(`Couldn’t ${label}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleTransfer(m: TeamMember) {
    const ok = await confirm({
      title: 'Transfer ownership',
      message: `Make ${memberLabel(m)} the owner of ${team.name}? You will become an admin.`,
      confirmLabel: 'Transfer',
      danger: true,
    });
    if (!ok) return;
    await run(
      'transfer ownership',
      () => rpc('teams.transferOwnership', { teamId: team.id, userId: m.userId }),
      async () => {
        showToast(`${memberLabel(m)} now owns ${team.name}.`);
        await Promise.all([
          qc.invalidateQueries({ queryKey: qk.me }),
          qc.invalidateQueries({ queryKey: qk.team(team.id) }),
          qc.invalidateQueries({ queryKey: qk.shows }),
        ]);
      },
    );
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete team',
      message: `Delete ${team.name}? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(
      'delete the team',
      () => rpc('teams.delete', { teamId: team.id }),
      async () => {
        showToast(`${team.name} deleted.`);
        await afterTeamGone();
      },
    );
  }

  async function handleLeave() {
    const ok = await confirm({
      title: 'Leave team',
      message: `Leave ${team.name}? You’ll have to be re-invited to rejoin.`,
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!ok) return;
    await run(
      'leave the team',
      () => rpc('teams.leave', { teamId: team.id }),
      async () => {
        showToast(`You left ${team.name}.`);
        await afterTeamGone();
      },
    );
  }

  return (
    <>
      <SettingsSectionHeader title="Team details" description={`${team.name} · ${YOU_ARE[role]}`} />
      {!canEdit && <RoleLockNotice role={role} teamName={team.name} />}

      <Card>
        <CardContent>
          <FieldGroup className="gap-4">
            <SettingRow
              label="Team name"
              htmlFor="settings-team-name"
              description="Shown to everyone on the team."
              disabled={!canEdit}
            >
              <Input
                id="settings-team-name"
                maxLength={200}
                autoComplete="off"
                disabled={!canEdit}
                value={value.name}
                onChange={(e) => draft.update({ name: e.target.value })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow label="Created" description="When this team was set up.">
              <span className="text-sm text-muted-foreground">{fmtDate(team.createdAt)}</span>
            </SettingRow>
          </FieldGroup>
        </CardContent>
        <SectionSaveBar
          dirty={draft.dirty}
          saving={rename.isPending}
          valid={canEdit && value.name.trim() !== ''}
          error={saveError}
          onSave={() => void save()}
        />
      </Card>

      <YoutubeAccessCard team={team} />

      <Card>
        <CardHeader>
          <CardTitle>{role === 'owner' ? 'Handing over' : 'Leaving'}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {actionError && <ErrorAlert>{actionError}</ErrorAlert>}
          <FieldGroup className="gap-4">
            {role === 'owner' ? (
              <>
                <SettingRow
                  label="Transfer ownership"
                  description={
                    detail.isError
                      ? 'Couldn’t load the members to transfer to.'
                      : detail.data && transferTargets.length === 0
                        ? 'There’s no one else on the team yet. Invite someone from Members first.'
                        : 'Make someone else the owner. You become an admin.'
                  }
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={busy || transferTargets.length === 0}
                      render={<Button variant="outline" />}
                    >
                      Transfer…
                      <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        {transferTargets.map((m) => (
                          <DropdownMenuItem key={m.userId} onClick={() => void handleTransfer(m)}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{memberLabel(m)}</span>
                              {m.email && (
                                <span className="truncate text-xs text-muted-foreground">
                                  {m.email}
                                </span>
                              )}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SettingRow>
                <FieldSeparator />
                <SettingRow
                  label="Delete team"
                  description={
                    showCount > 0
                      ? `${team.name} still has ${plural(showCount, 'show')}, and a team with shows can’t be deleted. Delete them in Shows first.`
                      : `Permanently deletes ${team.name}.`
                  }
                >
                  <Button
                    variant="destructive"
                    disabled={busy || showCount > 0}
                    onClick={() => void handleDelete()}
                  >
                    Delete team
                  </Button>
                </SettingRow>
              </>
            ) : (
              <SettingRow
                label="Leave team"
                description={`You’ll lose access to ${team.name}’s shows and sessions.`}
              >
                <Button variant="destructive" disabled={busy} onClick={() => void handleLeave()}>
                  Leave team
                </Button>
              </SettingRow>
            )}
          </FieldGroup>
        </CardContent>
      </Card>

      <CreateTeamCard />
      {confirmElement}
    </>
  );
}
