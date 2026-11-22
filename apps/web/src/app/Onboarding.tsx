import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { qk } from '@/api/queries';
import { auth, errorMessage, rpc } from '@/api/rpc';
import { GATE_PAGE } from '@/components/RouteState';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { Field, FieldLabel } from '@/shared/components/ui/field';
import { Input } from '@/shared/components/ui/input';
import { Spinner } from '@/shared/components/ui/spinner';

/** Create-team form, shared by onboarding and Settings → Team. */
export function CreateTeamForm({ onCreated }: { onCreated?: (teamId: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const team = await rpc('teams.create', { name: name.trim() });
      await Promise.all([qc.invalidateQueries({ queryKey: qk.me }), qc.invalidateQueries({ queryKey: qk.teams })]);
      setName('');
      onCreated?.(team.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3 text-left">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto min-w-[10rem] flex-1">
          <FieldLabel htmlFor="create-team-name">Team name</FieldLabel>
          <Input
            id="create-team-name"
            placeholder="My Crew"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy && <Spinner />}
          {busy ? 'Creating…' : 'Create team'}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not create team. {error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

export function Onboarding() {
  const qc = useQueryClient();
  return (
    <div className={GATE_PAGE}>
      <Card className="box-border w-full max-w-[32rem] items-center gap-0 rounded-card border-(--si-line-strong) bg-si-panel-2 px-7 py-9 text-center">
        <h1 className="m-0 font-league-gothic text-[2rem] font-bold uppercase leading-none tracking-[0.02em]">
          Create your first team
        </h1>
        <p className="mx-auto mt-3 mb-6 max-w-[24rem] text-[0.9rem] leading-[1.5] text-si-muted">
          Teams hold shows, and shows hold sessions. You'll be the owner and can invite people afterwards. If someone
          invited you, their team appears here once you sign in with the invited email.
        </p>
        <CreateTeamForm />
        <Button
          variant="link"
          className="mt-4"
          onClick={async () => {
            await auth.logout().catch(() => null);
            qc.setQueryData(qk.me, null);
          }}
        >
          Sign out
        </Button>
      </Card>
    </div>
  );
}
