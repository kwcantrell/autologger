import { Route, Switch } from 'wouter';
import { Toast } from '@/shared/components/Toast';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { ConsentPage } from '@/routes/ConsentPage';
import { LoginPage } from '@/routes/LoginPage';
import { RootGate } from './RootGate';

export function App() {
  return (
    <TooltipProvider delay={400}>
      <Toast />
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/oauth/consent" component={ConsentPage} />
        <Route>
          <RootGate />
        </Route>
      </Switch>
    </TooltipProvider>
  );
}
