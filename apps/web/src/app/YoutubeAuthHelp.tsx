// What to do when a YouTube import failed because YouTube wants a sign-in (its bot check, or a
// private / members-only / age-restricted video): set the team's YouTube sign-in (Settings › Team
// details › YouTube access, the usual fix), or import from your own computer with the local
// import helper (Settings › Agents). Shown under such errors in the import dialogs and jobs list.

import {
  IMPORT_HELPER_ANCHOR,
  openSettingsAt,
  YOUTUBE_ACCESS_ANCHOR,
} from '@/settings/openSettingsAt';
import { Button } from '@/shared/components/ui/button';
import { useActive } from './useActive';

// The server's YoutubeAuthError messages (apps/server/src/media/youtube.ts) start like this.
const AUTH_ERROR =
  /YouTube is blocking this server.s downloads \(bot check\)|YouTube requires a signed-in account/;

/** Whether an import/compile error is YouTube asking for a sign-in. */
export const isYoutubeAuthError = (message: string | null | undefined) =>
  !!message && AUTH_ERROR.test(message);

export function YoutubeAuthHelp({ onNavigate }: { onNavigate?: () => void }) {
  const { team, canManageTeam } = useActive();
  const go = (section: 'team' | 'agents', anchor: string) => {
    onNavigate?.();
    openSettingsAt(section, anchor);
  };
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {canManageTeam ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => go('team', YOUTUBE_ACCESS_ANCHOR)}
        >
          Set the team’s YouTube sign-in
        </Button>
      ) : (
        <span>
          Ask an owner or admin of {team?.name ?? 'your team'} to set its YouTube sign-in.
        </span>
      )}
      <Button
        type="button"
        variant="link"
        size="xs"
        className="px-0"
        onClick={() => go('agents', IMPORT_HELPER_ANCHOR)}
      >
        Or use the import helper on your computer
      </Button>
    </span>
  );
}
