// Shared pieces of the Settings sections: the page head, the labelled setting row, the section
// save bar, the role lock notice, the loading/error/empty states and a few small controls.

import type { TeamRole } from '@autologger/contract';
import { CopyIcon, LockIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { showToast } from '@/shared/components/Toast';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { CardFooter } from '@/shared/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/shared/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { Spinner } from '@/shared/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/shared/components/ui/toggle-group';
import { Dialog, DialogActions } from '@/shared/ui/Dialog';

export function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <h3 className="m-0 font-ui text-2xl leading-tight font-semibold">{title}</h3>
      {description && <p className="m-0 text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}

/** One setting: label and help on the left, the control on the right; stacked on narrow screens. */
export function SettingRow({
  label,
  htmlFor,
  labelId,
  description,
  disabled,
  wide,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  labelId?: string;
  description?: ReactNode;
  disabled?: boolean;
  /** The control side sizes to its content instead of the fixed 260px column. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <Field
      orientation="horizontal"
      data-disabled={disabled || undefined}
      className="justify-between gap-4 max-sm:flex-col max-sm:items-stretch"
    >
      <FieldContent className="min-w-0">
        {htmlFor ? (
          <FieldTitle>
            <label htmlFor={htmlFor}>{label}</label>
          </FieldTitle>
        ) : (
          <FieldTitle id={labelId}>{label}</FieldTitle>
        )}
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      {children !== undefined && (
        <div
          className={
            wide
              ? 'flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 max-sm:justify-start'
              : 'flex min-w-0 shrink-0 items-center justify-end gap-2 sm:w-[260px] max-sm:w-full max-sm:justify-start'
          }
        >
          {children}
        </div>
      )}
    </Field>
  );
}

/** Save is disabled and reads "Saved" with nothing to save, "Save" with an edit, a spinner while saving. */
export function SectionSaveBar({
  dirty,
  saving,
  valid = true,
  error,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  valid?: boolean;
  error?: string | null;
  onSave: () => void;
}) {
  return (
    <CardFooter
      data-slot="settings-save-bar"
      className="sticky bottom-0 flex-col items-stretch gap-3 border-t border-(--si-line) bg-card pt-4"
    >
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {!saving && dirty ? 'Unsaved changes' : ''}
        </span>
        <Button disabled={!dirty || !valid || saving} onClick={onSave}>
          {saving && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
    </CardFooter>
  );
}

const ROLE_PHRASE: Record<TeamRole, string> = {
  owner: 'the owner',
  admin: 'an admin',
  member: 'a member',
};

export const YOU_ARE: Record<TeamRole, string> = {
  owner: 'You’re the owner',
  admin: 'You’re an admin',
  member: 'You’re a member',
};

/** Disabled controls are explained, not hidden. */
export function RoleLockNotice({
  role,
  teamName,
  children,
}: {
  role: TeamRole;
  teamName: string;
  children?: ReactNode;
}) {
  return (
    <Alert role="status" data-slot="settings-role-notice">
      <LockIcon aria-hidden="true" />
      <AlertDescription>
        {children ??
          `You’re ${ROLE_PHRASE[role]} of ${teamName}. Only owners and admins can change these.`}
      </AlertDescription>
    </Alert>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <Empty data-state="loading" aria-busy="true">
      <EmptyHeader>
        <EmptyMedia>
          <Spinner aria-hidden="true" />
        </EmptyMedia>
        <EmptyDescription>{label}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <Empty data-state="error">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {detail && <EmptyDescription>{detail}</EmptyDescription>}
      </EmptyHeader>
      {onRetry && (
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        {title && <EmptyTitle>{title}</EmptyTitle>}
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export type TitleSuffix = 'date' | 'episode' | 'none';
export const SUFFIX_LABEL: Record<TitleSuffix, string> = {
  date: 'Date',
  episode: 'Episode Number',
  none: 'None',
};

/** How an untitled session's name ends. */
export function SuffixToggle({
  labelledBy,
  value,
  disabled,
  onChange,
}: {
  labelledBy: string;
  value: TitleSuffix;
  disabled?: boolean;
  onChange: (value: TitleSuffix) => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      aria-labelledby={labelledBy}
      disabled={disabled}
      value={[value]}
      onValueChange={([v]) => {
        if (v === 'date' || v === 'episode' || v === 'none') onChange(v);
      }}
    >
      <ToggleGroupItem value="date">Date</ToggleGroupItem>
      <ToggleGroupItem value="episode">Episode</ToggleGroupItem>
      <ToggleGroupItem value="none">None</ToggleGroupItem>
    </ToggleGroup>
  );
}

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60] as const;

export function FpsSelect({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  value: number;
  disabled?: boolean;
  onChange: (fps: number) => void;
}) {
  const rates: number[] = FRAME_RATES.includes(value as (typeof FRAME_RATES)[number])
    ? [...FRAME_RATES]
    : [...FRAME_RATES, value].sort((a, b) => a - b);
  const items = rates.map((r) => ({ value: String(r), label: `${r} fps` }));
  return (
    <Select
      items={items}
      value={String(value)}
      disabled={disabled}
      onValueChange={(v) => {
        if (v) onChange(Number(v));
      }}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} value={it.value}>
            {it.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export async function copyText(text: string, what = 'Token') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied.`);
  } catch {
    showToast(`Copy failed. Select the ${what.toLowerCase()} and copy it instead.`, true);
  }
}

/** A read-only value with a Copy button (tokens, URLs, commands). */
export function CopyField({
  value,
  label,
  what = 'Token',
}: {
  value: string;
  label: string;
  what?: string;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Input
        readOnly
        aria-label={label}
        value={value}
        className="min-w-0 flex-1 font-tc text-[0.78rem]"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button type="button" variant="outline" onClick={() => void copyText(value, what)}>
        <CopyIcon data-icon="inline-start" aria-hidden="true" />
        Copy
      </Button>
    </div>
  );
}

/** A secret shown once. Closing it (Done, Escape) drops the secret. */
export function TokenDialog({
  token,
  title,
  description,
  onClose,
}: {
  token: string | null;
  title: string;
  description: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      closeOnOverlayClick={false}
    >
      {token !== null && (
        <div className="flex flex-col gap-4">
          <CopyField value={token} label={title} />
          <p className="m-0 text-sm text-muted-foreground">
            Copy this token now. It won’t be shown again.
          </p>
          <DialogActions>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
export const fmtDate = (iso: string | null | undefined, never = 'Never') =>
  iso ? DATE_FMT.format(new Date(iso)) : never;

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A member's access to one show: None / Read / Write. */
export function GrantToggle({
  value,
  label,
  disabled,
  onChange,
}: {
  value: 'none' | 'read' | 'write';
  label: string;
  disabled?: boolean;
  onChange: (value: 'none' | 'read' | 'write') => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      aria-label={label}
      disabled={disabled}
      value={[value]}
      onValueChange={([v]) => {
        if (v === 'none' || v === 'read' || v === 'write') onChange(v);
      }}
    >
      <ToggleGroupItem value="none">None</ToggleGroupItem>
      <ToggleGroupItem value="read">Read</ToggleGroupItem>
      <ToggleGroupItem value="write">Write</ToggleGroupItem>
    </ToggleGroup>
  );
}
