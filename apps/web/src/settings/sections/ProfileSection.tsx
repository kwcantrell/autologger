import { useState } from 'react';
import { qk, useMe, useOpMutation } from '@/api/queries';
import { auth, errorMessage } from '@/api/rpc';
import { showToast } from '@/shared/components/Toast';
import { Button } from '@/shared/components/ui/button';
import { Card, CardContent } from '@/shared/components/ui/card';
import { FieldGroup, FieldSeparator } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Spinner } from '@/shared/components/ui/spinner';
import { useInlineDraft, useSectionGuard } from '../guard';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SectionSaveBar,
  SettingRow,
  SettingsSectionHeader,
} from '../parts';

export function ProfileSection() {
  const meQ = useMe();
  const me = meQ.data;
  const update = useOpMutation('me.update', { invalidate: () => [qk.me] });
  const draft = useInlineDraft(me?.id ?? null, me ? { name: me.name } : null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  useSectionGuard('profile', draft.dirty, draft.discard);

  const header = (
    <SettingsSectionHeader title="Profile" description="Your profile on this AutoLogger server." />
  );
  if (meQ.isPending)
    return (
      <>
        {header}
        <LoadingState label="Loading your profile…" />
      </>
    );
  if (meQ.isError)
    return (
      <>
        {header}
        <ErrorState
          title="Couldn’t load your profile."
          detail={errorMessage(meQ.error)}
          onRetry={() => void meQ.refetch()}
        />
      </>
    );
  if (!me || !draft.value)
    return (
      <>
        {header}
        <EmptyState description="You’re not signed in." />
      </>
    );

  const value = draft.value;

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ name: value.name.trim() });
      draft.markSaved();
      showToast('Saved.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await auth.logout();
    } catch {
      /* the session may already be gone; go to the login page either way */
    }
    location.assign('/login');
  }

  return (
    <>
      {header}
      <Card>
        <CardContent>
          <FieldGroup className="gap-4">
            <SettingRow
              label="Name"
              htmlFor="settings-profile-name"
              description="Shown on the events, topics and wiki edits you make."
            >
              <Input
                id="settings-profile-name"
                maxLength={200}
                autoComplete="name"
                value={value.name}
                onChange={(e) => draft.update({ name: e.target.value })}
              />
            </SettingRow>
            <FieldSeparator />
            <SettingRow
              label="Email"
              description="The account you sign in with. It can’t be changed here."
            >
              <span className="truncate text-sm text-muted-foreground">{me.email}</span>
            </SettingRow>
          </FieldGroup>
        </CardContent>
        <SectionSaveBar
          dirty={draft.dirty}
          saving={update.isPending}
          valid={value.name.trim() !== ''}
          error={error}
          onSave={() => void save()}
        />
      </Card>
      <Card>
        <CardContent>
          <SettingRow label="Sign out" description="Ends your session on this device.">
            <Button variant="destructive" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut && <Spinner data-icon="inline-start" aria-hidden="true" />}
              Sign out
            </Button>
          </SettingRow>
        </CardContent>
      </Card>
    </>
  );
}
