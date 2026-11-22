// Settings: an overlay view over the workspace (mounted inside <main> by AppShell while the
// `settingsOpen` store names a section). Vertical nav grouped by scope (You / Team / Show /
// Instance); each section mounts on first visit and stays mounted, so drafts survive switching.
// Closing or switching away from a dirty section asks "Discard changes?".

import { ChevronLeftIcon } from 'lucide-react';
import {
  type ComponentType,
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRoute } from 'wouter';
import { useAdminUsers, useMe } from '@/api/queries';
import { useActive } from '@/app/useActive';
import { type SettingsSection, settingsOpen } from '@/lib/store';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { cn } from '@/shared/lib/utils';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { isOverlayOpen } from '@/shared/ui/overlayOpen';
import { type SectionGuardState, type SettingsNav, SettingsNavContext } from './guard';
import { AdminSection } from './sections/AdminSection';
import { AgentsSection } from './sections/AgentsSection';
import { CompanionSection } from './sections/CompanionSection';
import { EventButtonsSection } from './sections/EventButtonsSection';
import { MembersSection } from './sections/MembersSection';
import { ProfileSection } from './sections/ProfileSection';
import { ShowDetailsSection } from './sections/ShowDetailsSection';
import { ShowsSection } from './sections/ShowsSection';
import { TeamSection } from './sections/TeamSection';

const VIEW_SELECTOR = '[data-slot="settings-view"]';

interface SectionDef {
  id: SettingsSection;
  label: string;
  Content: ComponentType;
}

type Scope = 'You' | 'Team' | 'Show' | 'Instance';

const GROUPS: { scope: Scope; sections: SectionDef[] }[] = [
  {
    scope: 'You',
    sections: [
      { id: 'profile', label: 'Profile', Content: ProfileSection },
      { id: 'companion', label: 'Companion devices', Content: CompanionSection },
      { id: 'agents', label: 'Agents', Content: AgentsSection },
    ],
  },
  {
    scope: 'Team',
    sections: [
      { id: 'members', label: 'Members', Content: MembersSection },
      { id: 'shows', label: 'Shows', Content: ShowsSection },
      { id: 'team', label: 'Team details', Content: TeamSection },
    ],
  },
  {
    scope: 'Show',
    sections: [
      { id: 'show-details', label: 'Show details', Content: ShowDetailsSection },
      { id: 'event-buttons', label: 'Event buttons', Content: EventButtonsSection },
    ],
  },
  { scope: 'Instance', sections: [{ id: 'admin', label: 'Users', Content: AdminSection }] },
];

const ALL_SECTIONS = GROUPS.flatMap((g) => g.sections);
const sectionLabel = (id: SettingsSection) => ALL_SECTIONS.find((s) => s.id === id)?.label ?? id;
const tabId = (id: SettingsSection) => `settings-tab-${id}`;
const panelId = (id: SettingsSection) => `settings-panel-${id}`;

export function SettingsView({ section }: { section: SettingsSection }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const me = useMe().data;
  const { team, show } = useActive();
  const superadmin = Boolean(me?.isSuperadmin);
  const adminUsers = useAdminUsers(superadmin);
  const pending = (adminUsers.data ?? []).filter((u) => u.status === 'pending').length;
  const [onSession] = useRoute('/sessions/:id');
  const backLabel = onSession ? 'Back to session' : 'Back to sessions';

  const [visited, setVisited] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));

  const guards = useRef(new Map<SettingsSection, SectionGuardState>());
  const { confirm, confirmElement } = useConfirm();

  const confirmDiscard = useCallback(
    async (ids: SettingsSection[]) => {
      const names = ids.map(sectionLabel).join(' and ');
      const ok = await confirm({
        title: 'Discard changes?',
        message: `You have unsaved changes in ${names}. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (ok) for (const id of ids) guards.current.get(id)?.discard?.();
      return ok;
    },
    [confirm],
  );

  const requestClose = useCallback(() => {
    const dirty = [...guards.current].filter(([, g]) => g.dirty).map(([id]) => id);
    if (dirty.length === 0) {
      settingsOpen.set(null);
      return;
    }
    void confirmDiscard(dirty).then((ok) => {
      if (ok) settingsOpen.set(null);
    });
  }, [confirmDiscard]);

  const sectionRef = useRef(section);
  sectionRef.current = section;
  const requestSection = useCallback(
    (next: SettingsSection) => {
      const cur = sectionRef.current;
      if (next === cur) return;
      if (!guards.current.get(cur)?.dirty) {
        settingsOpen.set(next);
        return;
      }
      void confirmDiscard([cur]).then((ok) => {
        if (ok) settingsOpen.set(next);
      });
    },
    [confirmDiscard],
  );

  const nav = useMemo<SettingsNav>(
    () => ({
      set: (id, state) => {
        if (state) guards.current.set(id, state);
        else guards.current.delete(id);
      },
      goTo: requestSection,
    }),
    [requestSection],
  );

  // Escape closes the view, unless a layer above it (a sheet, a confirm, a menu) is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isOverlayOpen(document, VIEW_SELECTOR)) return;
      e.preventDefault();
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // Keep the current section's chip in view on the phone's horizontal nav row.
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`#${tabId(section)}`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);

  // Focus moves in on open and back to the invoking control on close.
  useEffect(() => {
    const active = document.activeElement;
    const invoker = active instanceof HTMLElement && active !== document.body ? active : null;
    rootRef.current?.querySelector<HTMLElement>('[role="tab"][data-active]')?.focus();
    return () => {
      if (invoker?.isConnected) invoker.focus();
    };
  }, []);

  const scopeName: Record<Scope, string | undefined> = {
    You: undefined,
    Team: team?.name,
    Show: show?.name,
    Instance: undefined,
  };
  const groups = GROUPS.filter((g) => g.scope !== 'Instance' || superadmin || section === 'admin');

  return (
    <SettingsNavContext.Provider value={nav}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-slot="settings-view"
        className="absolute inset-0 z-(--z-settings-view) flex flex-col bg-background max-md:bottom-auto max-md:min-h-full"
      >
        <Tabs
          value={section}
          onValueChange={(v) => requestSection(v as SettingsSection)}
          orientation="vertical"
          className="min-h-0 flex-1 flex-row max-md:flex-col"
        >
          <div className="flex w-[250px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-(--si-line) px-3 pt-4 pb-5 max-md:w-full max-md:overflow-visible max-md:border-r-0 max-md:border-b max-md:pb-4">
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              data-slot="settings-back"
              onClick={requestClose}
            >
              <ChevronLeftIcon data-icon="inline-start" aria-hidden="true" />
              {backLabel}
            </Button>
            <h2 id={headingId} className="mx-2 font-ui text-[1.375rem] leading-tight font-semibold">
              Settings
            </h2>
            <TabsList
              variant="nav"
              aria-label="Settings sections"
              className="max-md:-mx-3 max-md:flex-row max-md:gap-1.5 max-md:overflow-x-auto max-md:px-3 max-md:pb-1"
            >
              {groups.map((group, i) => {
                const name = scopeName[group.scope];
                return (
                  <Fragment key={group.scope}>
                    <div
                      aria-hidden="true"
                      className={cn(
                        'mx-2 mb-1 flex min-w-0 items-baseline gap-2 max-md:hidden',
                        i > 0 && 'mt-4',
                      )}
                    >
                      <span
                        data-slot="settings-nav-group"
                        className="min-w-0 truncate text-[0.8125rem] leading-tight font-semibold"
                      >
                        {name ?? group.scope}
                      </span>
                      {name && (
                        <span
                          data-slot="settings-nav-scope"
                          className="shrink-0 text-xs leading-tight text-muted-foreground"
                        >
                          {group.scope}
                        </span>
                      )}
                    </div>
                    {group.sections.map((s) => (
                      <TabsTrigger
                        key={s.id}
                        variant="nav"
                        value={s.id}
                        id={tabId(s.id)}
                        aria-controls={panelId(s.id)}
                        className="max-md:w-auto max-md:shrink-0 max-md:border max-md:border-(--si-line) max-md:px-3 max-md:py-1.5"
                      >
                        {s.label}
                        {s.id === 'admin' && pending > 0 && (
                          <Badge
                            variant="secondary"
                            className="ml-auto"
                            aria-label={`${pending} waiting for approval`}
                          >
                            {pending}
                          </Badge>
                        )}
                      </TabsTrigger>
                    ))}
                  </Fragment>
                );
              })}
            </TabsList>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto max-md:overflow-visible">
            {ALL_SECTIONS.map(({ id, Content }) => (
              <TabsContent
                key={id}
                value={id}
                keepMounted
                id={panelId(id)}
                aria-labelledby={tabId(id)}
                hidden={section !== id}
                className="flex max-w-[860px] flex-col gap-[18px] px-8 pt-6 pb-10 max-md:px-4 max-md:pt-[18px] max-md:pb-7"
              >
                {visited.has(id) && <Content />}
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </div>
      {confirmElement}
    </SettingsNavContext.Provider>
  );
}
