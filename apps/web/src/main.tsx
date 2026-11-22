import '@/shared/theme/tailwind.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RpcError } from '@/api/rpc';
import { App } from '@/app/App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Never retry what retrying can't fix.
      retry: (count, e) =>
        count < 1 &&
        !(
          e instanceof RpcError &&
          ['forbidden', 'not_found', 'unauthenticated', 'bad_request', 'unavailable'].includes(
            e.code,
          )
        ),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
