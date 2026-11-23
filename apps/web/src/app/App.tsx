import { lazy, Suspense } from 'react';
import { Route, Switch } from 'wouter';
import { GATE_PAGE, LoadingVideo } from '@/components/RouteState';
import { ConsentPage } from '@/routes/ConsentPage';
import { LoginPage } from '@/routes/LoginPage';
import { Toast } from '@/shared/components/Toast';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { TooltipHost } from '@/shared/ui/Tooltip';
import { RootGate } from './RootGate';

// The documentation is public: it renders for signed-out and signed-in visitors alike, outside
// RootGate, and loads on demand so neither the landing page nor the app carries it.
const DocsRoute = lazy(() =>
  import('@/routes/docs/DocsRoute').then((m) => ({ default: m.DocsRoute })),
);

function Docs() {
  return (
    <Suspense
      fallback={
        <div className={GATE_PAGE} role="status" aria-busy="true" aria-label="Loading">
          <LoadingVideo />
        </div>
      }
    >
      <DocsRoute />
    </Suspense>
  );
}

export function App() {
  return (
    <TooltipProvider delay={400}>
      <Toast />
      <TooltipHost />
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/oauth/consent" component={ConsentPage} />
        <Route path="/docs" component={Docs} />
        <Route path="/docs/*" component={Docs} />
        <Route>
          <RootGate />
        </Route>
      </Switch>
    </TooltipProvider>
  );
}
