import type { Category, CategoryKind, OpInput, Show } from '@autologger/contract';
import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TvIcon, XIcon } from 'lucide-react';
import { type CSSProperties, Fragment, useState } from 'react';
import { qk, useCategories } from '@/api/queries';
import { errorMessage, rpc } from '@/api/rpc';
import { useActive } from '@/app/useActive';
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
  Field,
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
import { Kbd } from '@/shared/components/ui/kbd';
import { RadioGroup, RadioGroupItem } from '@/shared/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { useConfirm } from '@/shared/ui/ConfirmDialog';
import { Tooltip } from '@/shared/ui/Tooltip';
import { useSettingsNav } from '../guard';
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  LoadingState,
  plural,
  RoleLockNotice,
  SettingRow,
  SettingsSectionHeader,
} from '../parts';
import { runSaveSteps, SidePanel, useSidePanel } from '../SidePanel';
import { isManager } from '../teamRules';

/** The nine swatches every button picks from (the old app's default palette). */
export const PALETTE = [
  '#ff7a7a',
  '#ffd98a',
  '#e7ff95',
  '#83fff3',
  '#50caff',
  '#aa57ff',
  '#ff87d9',
  '#e1a8ff',
  '#d6dfff',
] as const;

const KINDS: { value: CategoryKind; label: string; help: string }[] = [
  { value: 'button', label: 'Button', help: 'Logs one event with the button’s name.' },
  {
    value: 'dropdown',
    label: 'Dropdown',
    help: 'You pick an option when logging. The option becomes the event message.',
  },
  { value: 'text', label: 'Text', help: 'You type a short message when logging.' },
  { value: 'toggle', label: 'On / Off', help: 'Toggles between two states and logs each change.' },
];
const kindLabel = (k: CategoryKind) => KINDS.find((x) => x.value === k)?.label ?? k;
const keyLabel = (index: number) => (index < 9 ? String(index + 1) : '–');
const MAX_BUTTONS = 40;

type ButtonDraft = OpInput<'categories.save'>['categories'][number] & {
  kind: CategoryKind;
  options: string[];
  onLabel: string;
  offLabel: string;
};

const toInput = (c: Category): ButtonDraft => ({
  id: c.id,
  name: c.name,
  color: c.color,
  kind: c.kind,
  options: c.options,
  onLabel: c.onLabel,
  offLabel: c.offLabel,
});

function summary(c: Pick<ButtonDraft, 'kind' | 'options' | 'onLabel' | 'offLabel'>) {
  const parts = [kindLabel(c.kind)];
  if (c.kind === 'dropdown') parts.push(plural(c.options.length, 'option'));
  if (c.kind === 'toggle') parts.push(`${c.onLabel || 'ON'} / ${c.offLabel || 'OFF'}`);
  return parts.join(' · ');
}

export function EventButtonsSection() {
  const { team, show, showsLoading } = useActive();
  const nav = useSettingsNav();
  const header = (
    <SettingsSectionHeader
      title="Event buttons"
      description={
        show
          ? `The logging strip for ${show.name}. Keys 1–9 log while the console has focus.`
          : 'The logging strip for the active show.'
      }
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
              : `You don’t have access to a show in ${team.name} yet.`
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
      {show.access !== 'manage' && (
        <RoleLockNotice role={team.role} teamName={team.name}>
          {`Only owners and admins of ${team.name} can change ${show.name}’s buttons.`}
        </RoleLockNotice>
      )}
      <EventButtons show={show} canEdit={show.access === 'manage'} />
    </>
  );
}

function EventButtons({ show, canEdit }: { show: Show; canEdit: boolean }) {
  const qc = useQueryClient();
  const { shows } = useActive();
  const cats = useCategories(show.id);
  const { confirm, confirmElement } = useConfirm();
  const { panel, openPanel, closePanel } = useSidePanel<number | null>();
  const others = shows.filter((s) => s.id !== show.id);
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function write(next: ButtonDraft[], label: string) {
    await runSaveSteps([
      {
        label,
        run: async () => {
          const saved = await rpc('categories.save', { showId: show.id, categories: next });
          qc.setQueryData(qk.categories(show.id), saved);
        },
      },
    ]);
    void qc.invalidateQueries({ queryKey: qk.show(show.id) });
  }

  async function copyButtons() {
    const src = others.find((s) => s.id === copyFrom);
    if (!src) return;
    setCopyError(null);
    setCopying(true);
    try {
      const srcCats = await rpc('categories.list', { showId: src.id });
      const n = srcCats.length;
      const ok = await confirm({
        title: 'Replace this show’s buttons?',
        message: `${show.name}’s ${plural(cats.data?.length ?? 0, 'button')} will be replaced with a copy of ${src.name}’s ${plural(n, 'button')}. Events already logged keep their labels.`,
        confirmLabel: 'Replace buttons',
        danger: true,
      });
      if (!ok) return;
      await write(
        srcCats.map((c) => ({ ...toInput(c), id: undefined })),
        `copy the buttons from ${src.name}`,
      );
      setCopyFrom(null);
      showToast(`Copied ${plural(n, 'button')} from ${src.name}.`);
    } catch (err) {
      setCopyError(errorMessage(err));
    } finally {
      setCopying(false);
    }
  }

  if (cats.isError)
    return (
      <ErrorState
        title="Couldn’t load the buttons."
        detail={errorMessage(cats.error)}
        onRetry={() => void cats.refetch()}
      />
    );
  if (cats.isPending) return <LoadingState label="Loading buttons…" />;
  const buttons = cats.data;
  const otherItems = others.map((s) => ({ value: s.id, label: s.name }));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Buttons</CardTitle>
          <CardDescription>
            {buttons.length === 0
              ? 'No buttons yet. Add one to start logging.'
              : `${plural(buttons.length, 'button')}, in logging-strip order. The first nine have keys 1–9.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemGroup role="list" aria-label="Event buttons">
            {buttons.map((btn, i) => (
              <Fragment key={btn.id}>
                {i > 0 && <ItemSeparator />}
                <ButtonRow btn={btn} index={i} canEdit={canEdit} onEdit={() => openPanel(i)} />
              </Fragment>
            ))}
            {buttons.length > 0 && <ItemSeparator />}
            <Item role="listitem" size="sm" className="justify-end">
              <ItemActions>
                {buttons.length >= MAX_BUTTONS && (
                  <span className="text-sm text-muted-foreground">
                    A show can have up to {MAX_BUTTONS} buttons.
                  </span>
                )}
                <Button
                  variant="outline"
                  disabled={!canEdit || buttons.length >= MAX_BUTTONS}
                  onClick={() => openPanel(null)}
                >
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  Add button
                </Button>
              </ItemActions>
            </Item>
          </ItemGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Copy from another show</CardTitle>
          <CardDescription>
            Replaces this show’s buttons with a copy of another show’s.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SettingRow
            label="Copy buttons from"
            labelId="settings-copy-from-label"
            disabled={!canEdit}
          >
            {others.length ? (
              <>
                <Select
                  items={otherItems}
                  value={copyFrom}
                  disabled={!canEdit || copying}
                  onValueChange={(v) => setCopyFrom(v)}
                >
                  <SelectTrigger
                    aria-labelledby="settings-copy-from-label"
                    className="min-w-0 flex-1"
                  >
                    <SelectValue placeholder="Choose a show…" />
                  </SelectTrigger>
                  <SelectContent>
                    {otherItems.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={!canEdit || !copyFrom || copying}
                  onClick={() => void copyButtons()}
                >
                  {copying && <Spinner data-icon="inline-start" aria-hidden="true" />}
                  Copy
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">No other shows on this team</span>
            )}
          </SettingRow>
          {copyError && <ErrorAlert>{`Couldn’t copy the buttons: ${copyError}`}</ErrorAlert>}
        </CardContent>
      </Card>

      {canEdit && panel && (
        <ButtonPanel
          key={panel.n}
          open={panel.open}
          index={panel.id}
          show={show}
          saved={buttons.map(toInput)}
          onWrite={write}
          onClose={closePanel}
        />
      )}
      {confirmElement}
    </>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 rounded-[4px] border border-(--si-line)"
      style={{ backgroundColor: color }}
    />
  );
}

function ButtonRow({
  btn,
  index,
  canEdit,
  onEdit,
}: {
  btn: Category;
  index: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const name = btn.name || 'Untitled button';
  return (
    <Item role="listitem" size="sm" className="flex-nowrap">
      <ItemMedia>
        <Kbd aria-label={index < 9 ? `Key ${index + 1}` : 'No key'}>{keyLabel(index)}</Kbd>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{name}</span>
        </ItemTitle>
        <ItemDescription className="truncate">{summary(btn)}</ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Swatch color={btn.color} />
        {canEdit && (
          <Button variant="ghost" size="sm" aria-label={`Edit ${name}`} onClick={onEdit}>
            Edit
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

interface PanelDraft {
  button: ButtonDraft;
  position: number;
}

function withKind(btn: ButtonDraft, kind: CategoryKind): ButtonDraft {
  const next = { ...btn, kind };
  if (kind === 'dropdown' && btn.options.length === 0) next.options = ['Option 1', 'Option 2'];
  if (kind === 'toggle') {
    next.onLabel = btn.onLabel || 'ON';
    next.offLabel = btn.offLabel || 'OFF';
  }
  return next;
}

function ButtonPanel({
  open,
  index,
  show,
  saved,
  onWrite,
  onClose,
}: {
  open: boolean;
  /** `null` for Add button. */
  index: number | null;
  show: Show;
  saved: ButtonDraft[];
  onWrite: (next: ButtonDraft[], label: string) => Promise<void>;
  onClose: () => void;
}) {
  const isNew = index === null;
  const count = saved.length;
  const [baseline] = useState<PanelDraft>(() =>
    index === null
      ? {
          button: {
            name: '',
            color: PALETTE[count % PALETTE.length],
            kind: 'button',
            options: [],
            onLabel: 'ON',
            offLabel: 'OFF',
          },
          position: count,
        }
      : { button: saved[index] as ButtonDraft, position: index },
  );
  const [draft, setDraft] = useState<PanelDraft>(baseline);
  const [optKeys, setOptKeys] = useState<string[]>(() =>
    baseline.button.options.map(() => crypto.randomUUID()),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const btn = draft.button;
  const patch = (p: Partial<ButtonDraft>) =>
    setDraft((d) => ({ ...d, button: { ...d.button, ...p } }));
  const setOptions = (options: string[], keys: string[]) => {
    patch({ options });
    setOptKeys(keys);
  };

  function changeKind(kind: CategoryKind) {
    const next = withKind(btn, kind);
    if (next.options.length !== optKeys.length)
      setOptKeys(next.options.map(() => crypto.randomUUID()));
    setDraft((d) => ({ ...d, button: next }));
  }

  async function save() {
    const final: ButtonDraft = {
      ...btn,
      name: btn.name.trim(),
      options:
        btn.kind === 'dropdown' ? btn.options.map((o) => o.trim()).filter(Boolean) : btn.options,
      onLabel: btn.onLabel.trim() || 'ON',
      offLabel: btn.offLabel.trim() || 'OFF',
    };
    const rest = isNew ? [...saved] : saved.filter((_, k) => k !== index);
    rest.splice(draft.position, 0, final);
    await onWrite(rest, isNew ? 'add the button' : 'save the button');
    showToast(isNew ? `${final.name} added.` : 'Saved.');
  }

  async function handleDelete() {
    if (index === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await onWrite(
        saved.filter((_, k) => k !== index),
        'delete the button',
      );
      showToast(`${btn.name || 'Button'} deleted.`);
      onClose();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  const position = draft.position;
  const key = position < 9 ? String(position + 1) : null;
  const kindInfo = KINDS.find((k) => k.value === btn.kind);
  const previewLabel =
    btn.kind === 'toggle' ? btn.offLabel.trim() || btn.name.trim() : btn.name.trim();
  const colourIndex = PALETTE.indexOf(btn.color.toLowerCase() as (typeof PALETTE)[number]);
  const optionsValid = btn.kind !== 'dropdown' || btn.options.some((o) => o.trim());

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={isNew ? 'New button' : 'Edit button'}
      description={show.name}
      media={<Kbd aria-hidden="true">{key ?? '–'}</Kbd>}
      value={draft}
      baseline={baseline}
      valid={btn.name.trim() !== '' && optionsValid}
      onSave={save}
      saveLabel={isNew ? 'Add button' : 'Save'}
    >
      <Field>
        <FieldTitle>Preview</FieldTitle>
        <Button
          variant="log"
          size={null}
          className="min-h-(--h-ctl) w-fit! max-w-full gap-2 whitespace-normal py-1.5 pr-3 pl-2 text-left"
          style={{ '--cat': btn.color } as CSSProperties}
          data-latched={btn.kind === 'toggle' ? 'off' : undefined}
          nativeButton={false}
          render={<div aria-hidden="true" />}
        >
          <span className="flex items-center gap-2">
            {key && <Kbd>{key}</Kbd>}
            <span className="size-2 shrink-0 rounded-[2px] bg-(--cat)" />
          </span>
          <span className="min-w-0 break-words leading-tight">{previewLabel || 'Untitled'}</span>
        </Button>
      </Field>

      <FieldSet>
        <FieldLegend>Button</FieldLegend>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="event-button-name">Name</FieldLabel>
            <Input
              id="event-button-name"
              maxLength={60}
              autoComplete="off"
              placeholder="Event name"
              value={btn.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <FieldDescription>Shown on the button and as the event’s category.</FieldDescription>
          </Field>
          <Field>
            <FieldTitle id="event-button-type-label">Type</FieldTitle>
            <ToggleGroup
              variant="outline"
              size="sm"
              className="flex-wrap"
              aria-labelledby="event-button-type-label"
              value={[btn.kind]}
              onValueChange={([v]) => {
                if (v) changeKind(v as CategoryKind);
              }}
            >
              {KINDS.map((k) => (
                <ToggleGroupItem key={k.value} value={k.value}>
                  {k.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{kindInfo?.help}</FieldDescription>
          </Field>
          <Field>
            <FieldTitle id="event-button-colour-label">Colour</FieldTitle>
            <div className="flex items-center gap-2">
              <RadioGroup
                aria-labelledby="event-button-colour-label"
                className="grid flex-1 grid-cols-9 gap-2"
                value={colourIndex >= 0 ? String(colourIndex) : ''}
                onValueChange={(v) => patch({ color: PALETTE[Number(v)] })}
              >
                {PALETTE.map((hex, i) => (
                  <RadioGroupItem
                    key={hex}
                    value={String(i)}
                    aria-label={`Colour ${i + 1} ${hex}`}
                    className="size-auto w-full rounded-md data-checked:ring-2 data-checked:ring-foreground data-checked:ring-offset-2 data-checked:ring-offset-background"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </RadioGroup>
              <Tooltip content={`Custom colour: ${btn.color}`}>
                <input
                  type="color"
                  className="pal-slot shrink-0"
                  aria-label="Custom colour"
                  value={btn.color}
                  onChange={(e) => patch({ color: e.target.value })}
                />
              </Tooltip>
            </div>
            <FieldDescription>
              {colourIndex >= 0
                ? 'From the swatches, or pick any colour on the right.'
                : `A custom colour (${btn.color}). Pick a swatch to change it.`}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      {btn.kind === 'dropdown' && (
        <FieldSet>
          <FieldLegend>Options</FieldLegend>
          <FieldDescription>The chosen option becomes the event message.</FieldDescription>
          <FieldGroup className="gap-2">
            {btn.options.map((opt, i) => {
              const n = i + 1;
              const k = optKeys[i] ?? String(i);
              return (
                <Field key={k} orientation="horizontal" className="items-center gap-2">
                  <Input
                    aria-label={`Option ${n}`}
                    placeholder={`Option ${n}`}
                    maxLength={80}
                    className="min-w-0 flex-1"
                    value={opt}
                    onChange={(e) =>
                      patch({ options: btn.options.map((o, j) => (j === i ? e.target.value : o)) })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove option ${n}`}
                    disabled={btn.options.length < 2}
                    onClick={() =>
                      setOptions(
                        btn.options.filter((_, j) => j !== i),
                        optKeys.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </Field>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={btn.options.length >= 30}
              onClick={() => setOptions([...btn.options, ''], [...optKeys, crypto.randomUUID()])}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add option
            </Button>
          </FieldGroup>
        </FieldSet>
      )}

      {btn.kind === 'toggle' && (
        <FieldSet>
          <FieldLegend>States</FieldLegend>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="event-button-on">On label</FieldLabel>
              <Input
                id="event-button-on"
                maxLength={20}
                value={btn.onLabel}
                onChange={(e) => patch({ onLabel: e.target.value })}
              />
              <FieldDescription>Logged when it switches on.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-button-off">Off label</FieldLabel>
              <Input
                id="event-button-off"
                maxLength={20}
                value={btn.offLabel}
                onChange={(e) => patch({ offLabel: e.target.value })}
              />
              <FieldDescription>Logged when it switches off.</FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>
      )}

      {!isNew && (
        <FieldSet>
          <FieldLegend>Position</FieldLegend>
          <SettingRow
            wide
            label={key ? `Key ${key}` : 'No key'}
            description={`Position ${position + 1} of ${count} in the logging strip.${key ? '' : ' Only the first nine have a key.'}`}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={position === 0}
              onClick={() => setDraft((d) => ({ ...d, position: d.position - 1 }))}
            >
              Move up
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={position >= count - 1}
              onClick={() => setDraft((d) => ({ ...d, position: d.position + 1 }))}
            >
              Move down
            </Button>
          </SettingRow>
        </FieldSet>
      )}

      {!isNew && (
        <FieldSet>
          <FieldLegend className="sr-only">Delete</FieldLegend>
          <SettingRow
            wide
            label="Delete button"
            description="Events already logged with it stay in their sessions."
          >
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {confirmDelete ? 'Click again to delete' : 'Delete'}
            </Button>
          </SettingRow>
          {deleteError && <ErrorAlert>{deleteError}</ErrorAlert>}
        </FieldSet>
      )}
    </SidePanel>
  );
}
