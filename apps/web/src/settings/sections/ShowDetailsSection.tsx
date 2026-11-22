import {
  keyTermsChars,
  MAX_KEY_TERM_LENGTH,
  MAX_KEY_TERMS,
  MAX_KEY_TERMS_TOTAL_CHARS,
  type OpInput,
  type Show,
} from '@autologger/contract';
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
import { Textarea } from '@/shared/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { useInlineDraft, useSectionGuard, useSettingsNav } from '../guard';
import {
  EmptyState,
  FpsSelect,
  LoadingState,
  plural,
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
  smartFormat: boolean;
  /** Key terms as typed: one per line. */
  keyTerms: string;
}

const draftOf = (s: Show): ShowDetailsDraft => ({
  name: s.name,
  code: s.code,
  titleSuffix: s.titleSuffix,
  defaultFrameRate: s.defaultFrameRate,
  nextEpisode: s.nextEpisode,
  smartFormat: s.smartFormat,
  keyTerms: s.keyTerms.join('\n'),
});

/** One term per line; blank lines and repeats dropped (the server de-duplicates too). */
const parseKeyTerms = (text: string): string[] => [
  ...new Set(
    text
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

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
  const keyTerms = parseKeyTerms(value.keyTerms);
  const longTerm = keyTerms.find((t) => t.length > MAX_KEY_TERM_LENGTH);
  const charsLeft = MAX_KEY_TERMS_TOTAL_CHARS - keyTermsChars(keyTerms);
  const keyTermsError =
    keyTerms.length > MAX_KEY_TERMS
      ? `At most ${MAX_KEY_TERMS} key terms; this list has ${keyTerms.length}.`
      : longTerm
        ? `“${longTerm.slice(0, 24)}…” is longer than ${MAX_KEY_TERM_LENGTH} characters.`
        : charsLeft < 0
          ? `Key terms can total ${MAX_KEY_TERMS_TOTAL_CHARS} characters; remove ${-charsLeft} more.`
          : null;

  async function save() {
    setError(null);
    const patch: OpInput<'shows.update'> = { showId: show.id };
    if (value.name.trim() !== show.name) patch.name = value.name.trim();
    if (value.code.trim() && value.code.trim() !== show.code) patch.code = value.code.trim();
    if (value.titleSuffix !== show.titleSuffix) patch.titleSuffix = value.titleSuffix;
    if (value.defaultFrameRate !== show.defaultFrameRate)
      patch.defaultFrameRate = value.defaultFrameRate;
    if (value.nextEpisode !== show.nextEpisode) patch.nextEpisode = value.nextEpisode;
    if (value.smartFormat !== show.smartFormat) patch.smartFormat = value.smartFormat;
    if (keyTerms.join('\n') !== show.keyTerms.join('\n')) patch.keyTerms = keyTerms;
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
            <FieldSeparator />
            <SettingRow
              label="Smart formatting"
              labelId="settings-show-smart-format-label"
              description="Transcripts write numbers, dates and money as digits and symbols. Turn it off for technical or math talk, where it turns “x squared” into “x2”. Applies to new transcriptions; re-transcribe a session to update it."
              disabled={!canEdit}
            >
              <ToggleGroup
                variant="outline"
                aria-labelledby="settings-show-smart-format-label"
                disabled={!canEdit}
                value={[value.smartFormat ? 'on' : 'off']}
                onValueChange={([v]) => {
                  if (v === 'on' || v === 'off') draft.update({ smartFormat: v === 'on' });
                }}
              >
                <ToggleGroupItem value="on">On</ToggleGroupItem>
                <ToggleGroupItem value="off">Off</ToggleGroupItem>
              </ToggleGroup>
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Key terms"
              htmlFor="settings-show-key-terms"
              description={
                keyTermsError ??
                `Names and jargon the transcriber should listen for, one per line (up to ${MAX_KEY_TERMS}; ${plural(charsLeft, 'character')} left). Applies to new transcriptions.`
              }
              disabled={!canEdit}
            >
              <Textarea
                id="settings-show-key-terms"
                rows={4}
                spellCheck={false}
                placeholder={'dx\nL’Hôpital'}
                disabled={!canEdit}
                aria-invalid={keyTermsError ? true : undefined}
                value={value.keyTerms}
                onChange={(e) => draft.update({ keyTerms: e.target.value })}
              />
            </SettingRow>
          </FieldGroup>
        </CardContent>
        {canEdit && (
          <SectionSaveBar
            dirty={draft.dirty}
            saving={update.isPending}
            valid={
              value.name.trim() !== '' && value.code.trim() !== '' && validEpisode && !keyTermsError
            }
            error={error}
            onSave={() => void save()}
          />
        )}
      </Card>
    </>
  );
}
