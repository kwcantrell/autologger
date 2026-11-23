import type { CompanionDevice, Show } from '@autologger/contract';
import { KeyRoundIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { qk, useCompanionDevices, useOpMutation, useSessions } from '@/api/queries';
import { errorMessage } from '@/api/rpc';
import { useActive } from '@/app/useActive';
import { DocsLink } from '@/components/DocsLink';
import { DOC_PAGES } from '@/lib/docsLinks';
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
import { FieldGroup, FieldSeparator } from '@/shared/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  fmtDate,
  LoadingState,
  relativeTime,
  SettingRow,
  SettingsSectionHeader,
  TokenDialog,
} from '../parts';

const FOLLOW = '__follow';

export function CompanionSection() {
  const { allShows, show: activeShow, showsLoading } = useActive();
  const list = useCompanionDevices();
  const create = useOpMutation('companion.create', { invalidate: () => [qk.companion] });
  const revoke = useOpMutation('companion.revoke', { invalidate: () => [qk.companion] });
  const { confirm, confirmElement } = useConfirm();
  const manageable = allShows.filter((s) => s.access === 'manage');
  const [showId, setShowId] = useState<string>('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  // Default to the show selected in the app, so a device isn't added to the wrong show.
  const chosenShow =
    manageable.find((s) => s.id === showId) ??
    manageable.find((s) => s.id === activeShow?.id) ??
    manageable[0] ??
    null;

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!chosenShow || !name.trim()) return;
    setError(null);
    try {
      const res = await create.mutateAsync({ showId: chosenShow.id, name: name.trim() });
      setToken(res.token);
      setName('');
    } catch (err) {
      setError(`Couldn’t add the device: ${errorMessage(err)}`);
    }
  }

  async function handleRevoke(device: CompanionDevice) {
    const ok = await confirm({
      title: 'Revoke device',
      message: `Revoke ${device.name}? Its token stops working at once, and the Stream Deck using it needs a new one.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await revoke.mutateAsync({ deviceId: device.id });
      showToast(`${device.name} revoked.`);
    } catch (err) {
      setError(`Couldn’t revoke ${device.name}: ${errorMessage(err)}`);
    }
  }

  const showItems = manageable.map((s) => ({
    value: s.id,
    label: manageable.some((o) => o !== s && o.name === s.name)
      ? `${s.name} (${s.teamName})`
      : s.name,
  }));
  const devices = list.data ?? [];
  const showById = new Map(allShows.map((s) => [s.id, s]));

  return (
    <>
      <SettingsSectionHeader
        title="Companion devices"
        description="Tokens that let a Stream Deck running the AutoLogger Companion module log events in one show."
      />
      <Card>
        <CardHeader>
          <CardTitle>Add a device</CardTitle>
          <CardDescription>
            Each device is tied to one show and logs into its sessions as you. Setting up the Stream
            Deck: <DocsLink page={DOC_PAGES.companion}>Bitfocus Companion</DocsLink>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {showsLoading ? (
            <LoadingState label="Loading shows…" />
          ) : manageable.length === 0 ? (
            <EmptyState
              description={
                allShows.length === 0
                  ? 'No shows yet. A device logs into one show — add one in Shows first.'
                  : 'Only owners and admins of a team can add devices to its shows, and you don’t manage any show.'
              }
            />
          ) : (
            <form onSubmit={(e) => void add(e)}>
              <FieldGroup className="gap-4">
                <SettingRow
                  label="Show"
                  labelId="settings-companion-show-label"
                  description="The show whose buttons and sessions the device uses."
                >
                  <Select
                    items={showItems}
                    value={chosenShow?.id ?? null}
                    onValueChange={(v) => v && setShowId(v)}
                  >
                    <SelectTrigger
                      aria-labelledby="settings-companion-show-label"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {showItems.map((it) => (
                        <SelectItem key={it.value} value={it.value}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <FieldSeparator />
                <SettingRow
                  label="Device name"
                  htmlFor="settings-companion-name"
                  description="Name the Stream Deck, so you can tell its token apart later."
                >
                  <Input
                    id="settings-companion-name"
                    maxLength={200}
                    placeholder="Booth A"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Button type="submit" disabled={!name.trim() || create.isPending}>
                    {create.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
                    Add device
                  </Button>
                </SettingRow>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      <Card>
        <CardContent>
          {list.isError ? (
            <ErrorState
              title="Couldn’t load your devices."
              detail={errorMessage(list.error)}
              onRetry={() => void list.refetch()}
            />
          ) : list.isPending ? (
            <LoadingState label="Loading your devices…" />
          ) : devices.length === 0 ? (
            <EmptyState
              icon={<KeyRoundIcon aria-hidden="true" />}
              title="No devices yet"
              description="Add one to get a token for the Companion module."
            />
          ) : (
            <ItemGroup role="list" aria-label="Companion devices">
              {devices.map((d, i) => (
                <Fragment key={d.id}>
                  {i > 0 && <ItemSeparator />}
                  <DeviceRow
                    device={d}
                    show={showById.get(d.showId)}
                    revoking={revoke.isPending && revoke.variables?.deviceId === d.id}
                    onRevoke={() => void handleRevoke(d)}
                    onError={setError}
                  />
                </Fragment>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      <TokenDialog
        token={token}
        title="Device token"
        description="Paste it into the Companion module’s Device token field."
        onClose={() => setToken(null)}
      />
      {confirmElement}
    </>
  );
}

function DeviceRow({
  device,
  show,
  revoking,
  onRevoke,
  onError,
}: {
  device: CompanionDevice;
  show: Show | undefined;
  revoking: boolean;
  onRevoke: () => void;
  onError: (msg: string | null) => void;
}) {
  const sessions = useSessions(device.showId);
  const setTarget = useOpMutation('companion.setTarget', { invalidate: () => [qk.companion] });
  const live = (sessions.data ?? []).filter(
    (s) => !s.archivedAt || s.id === device.targetSessionId,
  );
  const items = [
    { value: FOLLOW, label: 'Live or newest session' },
    ...live.map((s) => ({
      value: s.id,
      label: s.archivedAt ? `${s.title} (archived)` : s.title || 'Untitled session',
    })),
  ];
  const lastSeen = device.online ? 'Connected now' : `Last seen ${relativeTime(device.lastSeenAt)}`;

  return (
    <Item role="listitem" size="sm" className="flex-wrap gap-y-2">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{device.name}</span>
          <Badge variant={device.online ? 'default' : 'outline'}>
            {device.online ? 'Online' : 'Offline'}
          </Badge>
        </ItemTitle>
        <ItemDescription className="truncate">
          {`${show ? show.name : 'A show you no longer manage'} · ${lastSeen} · Added ${fmtDate(device.createdAt)}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0 max-sm:w-full">
        <Select
          items={items}
          value={device.targetSessionId ?? FOLLOW}
          disabled={setTarget.isPending || sessions.isPending}
          onValueChange={(v) => {
            if (!v) return;
            onError(null);
            setTarget.mutate(
              { deviceId: device.id, sessionId: v === FOLLOW ? null : v },
              {
                onError: (err) =>
                  onError(`Couldn’t change what ${device.name} follows: ${errorMessage(err)}`),
              },
            );
          }}
        >
          <SelectTrigger
            aria-label={`Session ${device.name} logs into`}
            className="w-56 max-sm:flex-1"
          >
            <SelectValue placeholder={sessions.isPending ? 'Loading sessions…' : undefined} />
          </SelectTrigger>
          <SelectContent>
            {items.map((it) => (
              <SelectItem key={it.value} value={it.value}>
                {it.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          aria-label={`Revoke ${device.name}`}
          onClick={onRevoke}
        >
          {revoking && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}
