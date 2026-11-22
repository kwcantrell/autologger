import { Component, type ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button';
import { RouteState } from './RouteState';

interface State {
  error: Error | null;
}

/** Catches render errors and lazy-chunk failures with the app's route-state card. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = /dynamically imported module|Loading chunk|Failed to fetch/i.test(error.message);
    return (
      <RouteState
        frame="route"
        role="alert"
        title={chunk ? "Couldn't finish loading" : 'Something went wrong'}
        actions={
          <>
            {chunk && (
              <Button className="h-11 w-full" onClick={() => this.setState({ error: null })}>
                Retry
              </Button>
            )}
            <Button variant={chunk ? 'outline' : 'default'} className="h-11 w-full" onClick={() => location.reload()}>
              Reload page
            </Button>
          </>
        }
      >
        {chunk
          ? 'Part of the app failed to download. Check your connection and try again.'
          : `This part of the app hit an unexpected error (${error.message}). Reloading the page usually clears it.`}
      </RouteState>
    );
  }
}
