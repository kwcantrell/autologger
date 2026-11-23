// The header and footer shared by the public landing page and the docs pages: logo, the Product /
// Docs / Resources / Developers menus (a sheet on phones), "Connect an agent" and Sign in — or
// Open app for a signed-in reader of the docs. On the landing page the Product menu jumps to its
// sections; on the docs pages it goes back to them on `/`, and is left out for signed-in readers
// (whose `/` is the app, not the landing page).

import { ChevronDown, ExternalLink, Menu } from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { Link } from 'wouter';
import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { cn } from '@/shared/lib/utils';
import { type LandingLinks, landingLinks, PRODUCT_LINKS, SIGN_IN_HREF } from './links';

export const WRAP = 'mx-auto w-full max-w-[72rem] px-4 sm:px-6 lg:px-8';
export const FOCUS =
  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:rounded-ctl';

export type Chrome = {
  links: LandingLinks;
  /** Which page the chrome is on. */
  page: 'landing' | 'docs';
  signedIn: boolean;
};

// Doc links follow the server's DOCS_URL (capabilities.docsUrl); the built-in docs until it loads.
const ChromeContext = createContext<Chrome>({
  links: landingLinks(),
  page: 'landing',
  signedIn: false,
});
export const ChromeProvider = ChromeContext;
export const useChrome = () => useContext(ChromeContext);
export const useLinks = () => useChrome().links;

export function isExternal(href: string) {
  return href.startsWith('http');
}

export function ext(href: string) {
  return isExternal(href) ? { target: '_blank', rel: 'noreferrer' } : {};
}

/** In-app routes (not `#…` jumps or `/#…`, which the landing page scrolls to on load). */
function isRoute(href: string) {
  return href.startsWith('/') && !href.startsWith('/#');
}

/** An anchor for any chrome link: client-side navigation for app routes, a new tab for others. */
export function ChromeLink({
  href,
  className,
  onClick,
  children,
}: {
  href: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  if (isRoute(href))
    return (
      <Link href={href} className={className} onClick={onClick}>
        {children}
      </Link>
    );
  return (
    <a href={href} {...ext(href)} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

/** The element a Button renders as to link to `href` (see ChromeLink). */
export function linkRender(href: string) {
  return isRoute(href) ? <Link href={href} /> : <a href={href} {...ext(href)} />;
}

function useMenuGroups() {
  const { links, page, signedIn } = useChrome();
  if (page === 'docs' && signedIn) return links.navGroups;
  const product =
    page === 'landing' ? PRODUCT_LINKS : PRODUCT_LINKS.map((l) => ({ ...l, href: `/${l.href}` }));
  return [{ id: 'product', label: 'Product', links: product }, ...links.navGroups];
}

export function Logo() {
  const { page } = useChrome();
  const className = cn('flex shrink-0 items-center gap-2 text-si-fg no-underline', FOCUS);
  const content = (
    <>
      <img
        src="/static/logo-autologger-transparent.png"
        alt=""
        width={28}
        height={28}
        className="size-7"
      />
      <span className="font-league-gothic text-[1.6rem] uppercase leading-none tracking-[0.02em]">
        AutoLogger
      </span>
    </>
  );
  return page === 'landing' ? (
    <a href="#top" className={className}>
      {content}
    </a>
  ) : (
    <Link href="/" className={className}>
      {content}
    </Link>
  );
}

/** Sign in, or Open app for a signed-in reader of the docs. */
export function AccountButton({
  className,
  size,
}: {
  className?: string;
  size?: 'default' | 'lg';
}) {
  const { signedIn } = useChrome();
  return (
    <Button
      nativeButton={false}
      size={size}
      className={className}
      render={<Link href={signedIn ? '/' : SIGN_IN_HREF} />}
    >
      {signedIn ? 'Open app' : 'Sign in'}
    </Button>
  );
}

function DesktopNav() {
  const menuGroups = useMenuGroups();
  return (
    <nav aria-label="Main" className="flex items-center gap-1 max-md:hidden">
      {menuGroups.map((g) => (
        <DropdownMenu key={g.id}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="gap-1 px-3 text-si-muted data-popup-open:text-si-fg hover:text-si-fg"
              />
            }
          >
            {g.label}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[17rem]">
            {g.links.map((l) => (
              <DropdownMenuLinkItem
                key={l.href + l.label}
                {...(isRoute(l.href)
                  ? { render: <Link href={l.href} /> }
                  : { href: l.href, ...ext(l.href) })}
                className="flex-col items-start gap-0.5 py-2"
              >
                <span className="flex items-center gap-1.5 text-[0.84rem] font-semibold tracking-normal">
                  {l.label}
                  {isExternal(l.href) && (
                    <ExternalLink aria-hidden="true" className="size-3 text-si-dim" />
                  )}
                </span>
                <span className="text-[0.75rem] tracking-normal text-si-dim">{l.hint}</span>
              </DropdownMenuLinkItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </nav>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const menuGroups = useMenuGroups();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label="Open menu"
          />
        }
      >
        <Menu aria-hidden="true" />
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-sm">
        <SheetHeader className="pr-12">
          <SheetTitle>AutoLogger</SheetTitle>
          <SheetDescription>Product tour, docs and developer links.</SheetDescription>
        </SheetHeader>
        <nav aria-label="Main" className="flex flex-col gap-5 px-4 pb-6">
          {menuGroups.map((g) => (
            <section key={g.id} aria-labelledby={`m-nav-${g.id}`}>
              <h2
                id={`m-nav-${g.id}`}
                className="m-0 mb-1.5 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
              >
                {g.label}
              </h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.links.map((l) => (
                  <li key={l.href + l.label}>
                    <ChromeLink
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'flex min-h-11 items-center gap-1.5 rounded-ctl px-2 text-[0.9375rem] text-si-fg no-underline hover:bg-[rgba(255,255,255,0.06)]',
                        FOCUS,
                      )}
                    >
                      {l.label}
                      {isExternal(l.href) && (
                        <ExternalLink aria-hidden="true" className="size-3.5 text-si-dim" />
                      )}
                    </ChromeLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <AccountButton className="h-11 w-full" />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

export function Header() {
  const { links, page } = useChrome();
  return (
    <header className="sticky top-0 z-30 border-b border-[color-mix(in_oklab,var(--si-accent)_22%,var(--si-line))] bg-[color-mix(in_oklab,var(--si-accent)_10%,#0c0d10)]">
      <div className={cn(WRAP, 'flex h-14 items-center gap-4 lg:gap-8')}>
        <div className="flex shrink-0 items-center gap-3">
          <Logo />
          {page === 'docs' && (
            <Link
              href="/docs"
              className={cn(
                'border-l border-si-line pl-3 font-label text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-si-muted no-underline hover:text-si-fg',
                FOCUS,
              )}
            >
              Docs
            </Link>
          )}
        </div>
        <DesktopNav />
        <div className="ml-auto flex items-center gap-2">
          <Button
            nativeButton={false}
            variant="ghost"
            className="text-si-muted hover:text-si-fg max-lg:hidden"
            render={linkRender(links.connectAgentHref)}
          >
            Connect an agent
          </Button>
          <AccountButton className="max-md:hidden" />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  const menuGroups = useMenuGroups();
  const { signedIn } = useChrome();
  return (
    <footer className="border-t border-si-line bg-[color-mix(in_oklab,var(--si-accent)_10%,#0c0d10)]">
      <div
        className={cn(
          WRAP,
          'grid grid-cols-2 gap-x-6 gap-y-10 py-12 lg:grid-cols-[1.4fr_repeat(4,minmax(0,1fr))]',
        )}
      >
        <div className="col-span-2 flex flex-col gap-3 lg:col-span-1">
          <Logo />
          <p className="m-0 max-w-[18rem] text-[0.875rem] leading-[1.55] text-si-muted">
            Session logging for production teams, with AI that works through MCP.
          </p>
        </div>
        {menuGroups.map((g) => (
          <nav key={g.id} aria-labelledby={`f-nav-${g.id}`}>
            <h2
              id={`f-nav-${g.id}`}
              className="m-0 mb-3 font-label text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-si-dim"
            >
              {g.label}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {g.links.map((l) => (
                <li key={l.href + l.label}>
                  <ChromeLink
                    href={l.href}
                    className={cn(
                      'text-[0.875rem] text-si-muted no-underline hover:text-si-fg hover:underline',
                      FOCUS,
                    )}
                  >
                    {l.label}
                  </ChromeLink>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className={WRAP}>
        {/* The hairline sits inside the padding so it lines up with the content column. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-si-line py-5">
          <p className="m-0 text-[0.8125rem] text-si-dim">AutoLogger is open source.</p>
          <Link
            href={signedIn ? '/' : SIGN_IN_HREF}
            className={cn('text-[0.8125rem] text-si-muted no-underline hover:text-si-fg', FOCUS)}
          >
            {signedIn ? 'Open app' : 'Sign in'}
          </Link>
        </div>
      </div>
    </footer>
  );
}
