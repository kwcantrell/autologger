import type { OpInput, Show } from '@autologger/contract';
import { TvIcon } from 'lucide-react';
import { useState } from 'react';
import { qk, useOpMutation } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Card, CardContent } from '@/shared/components/ui/card';
import { FieldGroup, FieldSeparator } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { useInlineDraft, useSectionGuard, useSettingsNav } from '../guard';
import {
  EmptyState,
  FpsSelect,
  LoadingState,
  RoleLockNotice,
  SectionSaveBar,
  SettingRow,
  SettingsSectionHeader,
  SuffixToggle,
  type TitleSuffix,
} from '../parts';
import { isManager, showInitials } from '../teamRules';

interface ShowDetailsDraft {
  name: string;
  code: string;
  titleSuffix: TitleSuffix;
  defaultFrameRate: number;
  nextEpisode: number;
}

const draftOf = (s: Show): ShowDetailsDraft => ({
  name: s.name,
  code: s.code,
  titleSuffix: s.titleSuffix,
  defaultFrameRate: s.defaultFrameRate,
  nextEpisode: s.nextEpisode,
});

export function ShowDetailsSection() {
  const { team, show, showsLoading } = useActive();
  const nav = useSettingsNav();
  const header = (
    <SettingsSectionHeader
      title="Show details"
      description={show && team ? `${show.name} in ${team.name}` : 'The active show.'}
    />
  );
  if (!team)
    return (
      <>
        {header}
        <EmptyState description="Join or create a team to set up its shows." />
      </>
    );
  if (showsLoading)
    return (
      <>
        {header}
        <LoadingState label="Loading shows…" />
      </>
    );
  if (!show) {
    const manager = isManager(team.role);
    return (
      <>
        {header}
        <EmptyState
          icon={<TvIcon aria-hidden="true" />}
          title="No shows yet"
          description={
            manager
              ? `${team.name} has no shows. Add one in Shows.`
              : `You don’t have access to a show in ${team.name} yet. Ask an owner or admin.`
          }
          action={
            manager && (
              <Button variant="outline" onClick={() => nav?.goTo('shows')}>
                Go to Shows
              </Button>
            )
          }
        />
      </>
    );
  }
  return (
    <>
      {header}
      <ShowDetails show={show} teamName={team.name} role={team.role} />
    </>
  );
}

function ShowDetails({
  show,
  teamName,
  role,
}: {
  show: Show;
  teamName: string;
  role: 'owner' | 'admin' | 'member';
}) {
  const canEdit = show.access === 'manage';
  const update = useOpMutation('shows.update', { invalidate: (s) => [qk.shows, qk.show(s.id)] });
  const draft = useInlineDraft(show.id, draftOf(show));
  useSectionGuard('show-details', draft.dirty, draft.discard);
  const [error, setError] = useState<string | null>(null);
  const value = draft.value ?? draftOf(show);

  async function save() {
    setError(null);
    const patch: OpInput<'shows.update'> = { showId: show.id };
    if (value.name.trim() !== show.name) patch.name = value.name.trim();
    if (value.code.trim() && value.code.trim() !== show.code) patch.code = value.code.trim();
    if (value.titleSuffix !== show.titleSuffix) patch.titleSuffix = value.titleSuffix;
    if (value.defaultFrameRate !== show.defaultFrameRate)
      patch.defaultFrameRate = value.defaultFrameRate;
    if (value.nextEpisode !== show.nextEpisode) patch.nextEpisode = value.nextEpisode;
    try {
      await update.mutateAsync(patch);
      draft.markSaved();
      showToast('Saved.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const initials = showInitials(value.name);
  const codeHint =
    value.name.trim() && value.code.trim() && value.code.trim().toUpperCase() !== initials
      ? `Starts the name of every untitled session. Usually the show name’s initials (${initials}); yours differs, which is fine if intended.`
      : 'Starts the name of every untitled session in this show.';
  const validEpisode = Number.isInteger(value.nextEpisode) && value.nextEpisode >= 1;

  return (
    <>
      {!canEdit && (
        <RoleLockNotice role={role} teamName={teamName}>
          {`You can ${show.access === 'write' ? 'log in' : 'open'} ${show.name}, but only owners and admins of ${teamName} can change its details.`}
        </RoleLockNotice>
      )}
      <Card>
        <CardContent>
          <FieldGroup className="gap-4">
            <SettingRow
              label="Show name"
              htmlFor="settings-show-name"
              description="Appears in the sidebar and on every session."
              disabled={!canEdit}
            >
              <Input
                id="settings-show-name"
                maxLength={200}
                autoComplete="off"
                disabled={!canEdit}
                value={value.name}
                onChange={(e) => draft.update({ name: e.target.value })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Code"
              htmlFor="settings-show-code"
              description={codeHint}
              disabled={!canEdit}
            >
              <Input
                id="settings-show-code"
                maxLength={12}
                autoComplete="off"
                spellCheck={false}
                className="font-tc"
                disabled={!canEdit}
                value={value.code}
                onChange={(e) => draft.update({ code: e.target.value.toUpperCase() })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Suffix"
              labelId="settings-show-suffix-label"
              description="How an untitled session’s name ends: the date, an episode number, or nothing."
              disabled={!canEdit}
            >
              <SuffixToggle
                labelledBy="settings-show-suffix-label"
                disabled={!canEdit}
                value={value.titleSuffix}
                onChange={(titleSuffix) => draft.update({ titleSuffix })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Next episode"
              htmlFor="settings-show-episode"
              description={
                value.titleSuffix === 'episode'
                  ? 'The episode number the next new session suggests.'
                  : 'Used when the suffix is Episode. Kept for when you switch to it.'
              }
              disabled={!canEdit}
            >
              <Input
                id="settings-show-episode"
                type="number"
                min={1}
                step={1}
                disabled={!canEdit}
                aria-invalid={!validEpisode || undefined}
                value={Number.isFinite(value.nextEpisode) ? value.nextEpisode : ''}
                onChange={(e) => draft.update({ nextEpisode: e.target.valueAsNumber })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Default frame rate"
              htmlFor="settings-show-fps"
              description="New sessions in this show start at this rate."
              disabled={!canEdit}
            >
              <FpsSelect
                id="settings-show-fps"
                disabled={!canEdit}
                value={value.defaultFrameRate}
                onChange={(defaultFrameRate) => draft.update({ defaultFrameRate })}
              />
            </SettingRow>
          </FieldGroup>
        </CardContent>
        {canEdit && (
          <SectionSaveBar
            dirty={draft.dirty}
            saving={update.isPending}
            valid={value.name.trim() !== '' && value.code.trim() !== '' && validEpisode}
            error={error}
            onSave={() => void save()}
          />
        )}
      </Card>
    </>
  );
}
