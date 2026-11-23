// Deep links into Settings: open a section and bring one of its cards into view. The Settings
// view and its sections load lazily, so the card is looked for on each frame for a few seconds.

import { type SettingsSection, settingsOpen } from '@/lib/store';

/** Settings › Agents › Import from your computer (the local import helper). */
export const IMPORT_HELPER_ANCHOR = 'settings-import-helper';
/** Settings › Team details › YouTube access (the team's YouTube sign-in). */
export const YOUTUBE_ACCESS_ANCHOR = 'settings-team-youtube';

export function openSettingsAt(section: SettingsSection, anchorId: string) {
  settingsOpen.set(section);
  const until = performance.now() + 5000;
  const find = () => {
    const el = document.getElementById(anchorId);
    if (!el) {
      if (performance.now() < until) requestAnimationFrame(find);
      return;
    }
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  };
  requestAnimationFrame(find);
}
