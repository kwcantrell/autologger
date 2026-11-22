import type { OpInput, Show, Team, TeamMember } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TvIcon } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { qk, useTeam } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { showToast } from '@/shared/components/Toast';
import { Avatar, AvatarFallback } from '@/shared/components/ui/avatar';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Card, CardContent } from '@/shared/components/ui/card';
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
  ItemSeparator,
  ItemTitle,
} from '@/shared/components/ui/item';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { useSettingsNav } from '../guard';
import {
  EmptyState,
  ErrorAlert,
  FpsSelect,
  GrantToggle,
  LoadingState,
  plural,
  RoleLockNotice,
  SettingRow,
  SettingsSectionHeader,
  SUFFIX_LABEL,
  SuffixToggle,
  type TitleSuffix,
} from '../parts';
import { runSaveSteps, type SaveStep, SidePanel, useSidePanel } from '../SidePanel';
import { type GrantLevel, grantOf, isManager, memberLabel, showInitials } from '../teamRules';

export function ShowsSection() {
  const { team } = useActive();
  const nav = useSettingsNav();
  if (!team) {
    return (
      <>
        <SettingsSectionHeader title="Shows" description="You’re not on a team yet." />
        <EmptyState
          description="Join or create a team to set up its shows."
          action={
            <Button variant="outline" onClick={() => nav?.goTo('team')}>
              Go to Team details
            </Button>
          }
        />
      </>
    );
  }
  return <Shows team={team} />;
}

function Shows({ team }: { team: Team }) {
  const { shows, show: activeShow, showsLoading } = useActive();
  const manager = isManager(team.role);
  const detail = useTeam(manager ? team.id : undefined);
  const members = (detail.data?.members ?? []).filter((m) => m.role === 'member');
  const { panel, openPanel, closePanel } = useSidePanel<string | null>();
  const panelShow = panel?.id ? (shows.find((s) => s.id === panel.id) ?? null) : null;

  return (
    <>
      <SettingsSectionHeader
        title="Shows"
        description={showsLoading ? team.name : `${team.name} · ${plural(shows.length, 'show')}`}
      />
      {!manager && (
        <RoleLockNotice role={team.role} teamName={team.name}>
          {`You’re a member of ${team.name}. Only owners and admins can add, edit or delete shows. You see the shows you’ve been given access to.`}
        </RoleLockNotice>
      )}
      {showsLoading ? (
        <LoadingState label="Loading shows…" />
      ) : (
        <Card className="py-2">
          <CardContent className="px-2">
            {shows.length === 0 ? (
              <EmptyState
                icon={<TvIcon aria-hidden="true" />}
                title="No shows yet"
                description={
                  manager
                    ? 'Shows group sessions. Add one to start logging.'
                    : `No one has given you access to a show in ${team.name} yet.`
                }
              />
            ) : (
              <ItemGroup role="list" aria-label={`${team.name} shows`}>
                {shows.map((show, i) => (
                  <Fragment key={show.id}>
                    {i > 0 && <ItemSeparator />}
                    <ShowRow
                      show={show}
                      current={show.id === activeShow?.id}
                      granted={
                        detail.data
                          ? members.filter((m) => grantOf(m, show.id) !== 'none').length
                          : null
                      }
                      memberCount={members.length}
                      canEdit={manager}
                      onEdit={() => openPanel(show.id)}
                    />
                  </Fragment>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          <SettingRow
            label="Add a show"
            description="Shows group sessions. Members only see the shows you let them open."
            disabled={!manager}
          >
            <Button variant="outline" disabled={!manager} onClick={() => openPanel(null)}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add show
            </Button>
          </SettingRow>
        </CardContent>
      </Card>

      {manager && panel && (panel.id === null || panelShow) && (
        <ShowPanel
          key={panel.n}
          open={panel.open}
          team={team}
          show={panelShow}
          members={members}
          membersLoaded={Boolean(detail.data)}
          onClose={closePanel}
        />
      )}
    </>
  );
}

function ShowRow({
  show,
  current,
  granted,
  memberCount,
  canEdit,
  onEdit,
}: {
  show: Show;
  current: boolean;
  granted: number | null;
  memberCount: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const name = show.name || 'Untitled show';
  return (
    <Item role="listitem" size="sm" className="flex-nowrap">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{name}</span>
          {current && <Badge variant="secondary">Current show</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate">
          {`${show.code || 'No code'} · ${SUFFIX_LABEL[show.titleSuffix]} suffix · ${show.defaultFrameRate} fps · ${plural(show.sessionCount, 'session')}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        {granted !== null && memberCount > 0 && (
          <span className="text-right text-sm text-muted-foreground max-sm:hidden">{`${granted} of ${plural(memberCount, 'member')}`}</span>
        )}
        {canEdit && (
          <Button variant="ghost" size="sm" aria-label={`Edit ${name}`} onClick={onEdit}>
            Edit
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

interface ShowPanelDraft {
  name: string;
  code: string;
  defaultFrameRate: number;
  titleSuffix: TitleSuffix;
  nextEpisode: number;
  access: Record<string, GrantLevel>;
}

const accessOf = (members: TeamMember[], showId: string | null) =>
  Object.fromEntries(
    members.map((m) => [m.userId, showId ? grantOf(m, showId) : 'none']),
  ) as Record<string, GrantLevel>;

function ShowPanel({
  open,
  team,
  show,
  members,
  membersLoaded,
  onClose,
}: {
  open: boolean;
  team: Team;
  /** `null` for Add show. */
  show: Show | null;
  members: TeamMember[];
  membersLoaded: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, confirmElement } = useConfirm();
  const isNew = show === null;
  // Add show: the show once created, so a retry after a later step failed never creates it twice.
  const created = useRef<Show | null>(null);
  const baseline: ShowPanelDraft = {
    name: show?.name ?? '',
    code: show?.code ?? '',
    defaultFrameRate: show?.defaultFrameRate ?? 24,
    titleSuffix: show?.titleSuffix ?? 'date',
    nextEpisode: show?.nextEpisode ?? 1,
    access: accessOf(members, show?.id ?? null),
  };
  const [draft, setDraft] = useState<ShowPanelDraft>(baseline);
  const [seeded, setSeeded] = useState(membersLoaded);
  if (!seeded && membersLoaded) {
    setSeeded(true);
    setDraft((d) => ({ ...d, access: accessOf(members, show?.id ?? null) }));
  }
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const update = (patch: Partial<ShowPanelDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function grantSteps(showId: string, before: Record<string, GrantLevel>): SaveStep[] {
    return members
      .filter((m) => (draft.access[m.userId] ?? 'none') !== (before[m.userId] ?? 'none'))
      .map((m) => {
        const access = draft.access[m.userId] ?? 'none';
        const who = memberLabel(m);
        return {
          label: access === 'none' ? `remove ${who}’s access` : `give ${who} ${access} access`,
          run: () => rpc('teams.setGrant', { teamId: team.id, userId: m.userId, showId, access }),
        };
      });
  }

  async function save() {
    const name = draft.name.trim();
    const code = draft.code.trim();
    const steps: SaveStep[] = [];
    let target: Show;
    let before: ShowPanelDraft;
    if (show) {
      target = show;
      before = baseline;
    } else {
      if (!created.current) {
        await runSaveSteps([
          {
            label: 'create the show',
            run: async () => {
              created.current = await rpc('shows.create', {
                teamId: team.id,
                name,
                ...(code ? { code } : {}),
                defaultFrameRate: draft.defaultFrameRate,
              });
            },
          },
        ]);
      }
      target = created.current as Show;
      before = {
        ...baseline,
        name: target.name,
        code: target.code,
        defaultFrameRate: target.defaultFrameRate,
        titleSuffix: target.titleSuffix,
        nextEpisode: target.nextEpisode,
      };
    }
    const patch: OpInput<'shows.update'> = { showId: target.id };
    if (name !== before.name) patch.name = name;
    if (code && code.toUpperCase() !== before.code) patch.code = code;
    if (draft.defaultFrameRate !== before.defaultFrameRate)
      patch.defaultFrameRate = draft.defaultFrameRate;
    if (draft.titleSuffix !== before.titleSuffix) patch.titleSuffix = draft.titleSuffix;
    if (draft.nextEpisode !== before.nextEpisode) patch.nextEpisode = draft.nextEpisode;
    if (Object.keys(patch).length > 1) {
      steps.push({
        label: isNew ? 'finish setting up the show' : 'save the show',
        run: () => rpc('shows.update', patch),
      });
    }
    steps.push(...grantSteps(target.id, show ? baseline.access : {}));
    try {
      await runSaveSteps(steps);
      showToast(isNew ? `${name} added.` : 'Saved.');
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.shows }),
        qc.invalidateQueries({ queryKey: qk.show(target.id) }),
        qc.invalidateQueries({ queryKey: qk.team(team.id) }),
      ]);
    }
  }

  async function handleDelete() {
    if (!show) return;
    const ok = await confirm({
      title: 'Delete show',
      message: `Delete ${show.name}? Its ${plural(show.sessionCount, 'session')} — with their events, transcripts, topics and wiki — are deleted too. This can’t be undone.`,
      confirmLabel: 'Delete show',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await rpc('shows.delete', { showId: show.id });
      showToast(`${show.name} deleted.`);
      onClose();
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.shows }),
        qc.invalidateQueries({ queryKey: qk.sessionsAll }),
        qc.invalidateQueries({ queryKey: qk.team(team.id) }),
      ]);
    } catch (err) {
      setDeleteError(`Couldn’t delete the show: ${errorMessage(err)}`);
    } finally {
      setDeleting(false);
    }
  }

  const initials = showInitials(draft.name);
  const validEpisode = Number.isInteger(draft.nextEpisode) && draft.nextEpisode >= 1;

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        title={isNew ? 'New show' : 'Edit show'}
        description={team.name}
        media={
          <Avatar size="lg">
            <AvatarFallback>
              {initials.slice(0, 2) || <PlusIcon aria-hidden="true" />}
            </AvatarFallback>
          </Avatar>
        }
        value={draft}
        baseline={baseline}
        valid={draft.name.trim() !== '' && validEpisode}
        onSave={save}
        saveLabel={isNew ? 'Add show' : 'Save'}
      >
        <FieldSet>
          <FieldLegend>Show</FieldLegend>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="show-panel-name">Show name</FieldLabel>
              <Input
                id="show-panel-name"
                maxLength={200}
                autoComplete="off"
                placeholder="e.g. Morning Desk"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
              <FieldDescription>Appears in the top bar and on every session.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="show-panel-code">Code</FieldLabel>
              <Input
                id="show-panel-code"
                maxLength={12}
                autoComplete="off"
                spellCheck={false}
                className="font-tc"
                placeholder={initials || 'e.g. MD'}
                value={draft.code}
                onChange={(e) => update({ code: e.target.value.toUpperCase() })}
              />
              <FieldDescription>
                {isNew
                  ? 'Starts the name of every untitled session. Left empty, the name’s initials are used.'
                  : 'Starts the name of every untitled session in this show.'}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel id="show-panel-suffix-label">Suffix</FieldLabel>
              <SuffixToggle
                labelledBy="show-panel-suffix-label"
                value={draft.titleSuffix}
                onChange={(titleSuffix) => update({ titleSuffix })}
              />
              <FieldDescription>
                How an untitled session’s name ends: the date, an episode number, or nothing.
              </FieldDescription>
            </Field>
            {draft.titleSuffix === 'episode' && (
              <Field>
                <FieldLabel htmlFor="show-panel-episode">Next episode</FieldLabel>
                <Input
                  id="show-panel-episode"
                  type="number"
                  min={1}
                  step={1}
                  className="w-32"
                  value={Number.isFinite(draft.nextEpisode) ? draft.nextEpisode : ''}
                  onChange={(e) => update({ nextEpisode: e.target.valueAsNumber })}
                />
                <FieldDescription>The number the next new session suggests.</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="show-panel-fps">Default frame rate</FieldLabel>
              <FpsSelect
                id="show-panel-fps"
                value={draft.defaultFrameRate}
                onChange={(defaultFrameRate) => update({ defaultFrameRate })}
              />
              <FieldDescription>New sessions in this show start at this rate.</FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend>Who can open it</FieldLegend>
          {!membersLoaded ? (
            <FieldDescription className="flex items-center gap-2">
              <Spinner aria-hidden="true" />
              Loading members…
            </FieldDescription>
          ) : members.length === 0 ? (
            <FieldDescription>
              No members on this team yet. Owners and admins can always open every show.
            </FieldDescription>
          ) : (
            <FieldGroup className="gap-3">
              {members.map((m) => (
                <Field key={m.userId} orientation="horizontal" className="justify-between gap-3">
                  <FieldContent className="min-w-0">
                    <FieldTitle className="truncate font-normal">{memberLabel(m)}</FieldTitle>
                    {m.email && <FieldDescription className="truncate">{m.email}</FieldDescription>}
                  </FieldContent>
                  <GrantToggle
                    label={`${memberLabel(m)}’s access`}
                    value={draft.access[m.userId] ?? 'none'}
                    onChange={(v) => update({ access: { ...draft.access, [m.userId]: v } })}
                  />
                </Field>
              ))}
              <FieldDescription>
                Read can open sessions; Write can also log and edit. Owners and admins can always
                open every show.
              </FieldDescription>
            </FieldGroup>
          )}
        </FieldSet>

        {show && (
          <FieldSet>
            <FieldLegend>Delete</FieldLegend>
            <Field orientation="horizontal" className="justify-between gap-4">
              <FieldContent className="min-w-0">
                <FieldTitle>Delete show</FieldTitle>
                <FieldDescription>
                  {`Deletes the show and its ${plural(show.sessionCount, 'session')}.`}
                </FieldDescription>
              </FieldContent>
              <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
                {deleting && <Spinner data-icon="inline-start" aria-hidden="true" />}
                Delete…
              </Button>
            </Field>
            {deleteError && <ErrorAlert>{deleteError}</ErrorAlert>}
          </FieldSet>
        )}
      </SidePanel>
      {confirmElement}
    </>
  );
}
