# AutoLogger web UI inventory (for the Vite SPA rebuild)

Source: `/home/autologger/autologger-2/web` (React 19, Tailwind v4, shadcn "base-nova" components on `@base-ui/react`, wouter routing inside one Next `ssr:false` client island, TanStack Query, lucide-react, sonner, cmdk, react-markdown, diff, @tanstack/react-virtual).

Paths below are relative to `web/src/` unless absolute. "COPY" = safe to copy verbatim. "OLD-INTERNAL" = depends on old API hooks / stores / Next and must be re-implemented against the new API. "LEFTOVER/AI" = in-app AI generation or a retired feature; drop or replace in the rebuild (AI generation moves to external agents over MCP; the Assistant tab becomes an "Agents" activity tab).

**Best single reference: `web/DESIGN.md` (381 lines) — COPY it into the new repo.** Its YAML front matter lists every colour, type style, radius, spacing and component token; its prose is the design contract ("Show Ignition"). `web/src/shared/theme/showIgnitionTokens.repo.test.ts` checks tailwind.css against that front matter, so keeping both lets you port that test too.

---

## 0. Quick map

| Area          | Entry file                                          | Notes                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document/head | `app/(index)/layout.page.tsx`                       | Title "AutoLogger", favicon `/static/logo-autologger-transparent.png`, apple icon `/static/logo-autologger-app.png`, `themeColor #101216`, preloads 3 fonts. Body has `data-v4-transport="rolling"` (legacy attribute; harmless). Port to Vite `index.html`.                                       |
| Client root   | `pages/index/IndexRoot.tsx`                         | `QueryClientProvider` (retry 1, staleTime 0) → `ThemeProvider` → `TooltipProvider delay=400` → `AppLocationRouter` (wouter) → `RootGate`.                                                                                                                                                          |
| Auth gate     | `pages/index/RootGate.tsx`                          | profile query: loading → `AppLoadingSkeleton` with looping brand video; error → `RouteState frame="gate"` card "Couldn't reach the server…" + full-width 44px "Try again"; logged-out → public landing page at `/` (`/login` with `LANDING_PAGE=0`), `/login?return=…` elsewhere; else `AppShell`. |
| Shell         | `pages/index/AppShell.tsx`                          | SidebarProvider root carrying `data-transport`, TopBar, V6Rail, `<main>` with route switch + overlays.                                                                                                                                                                                             |
| Routes        | `AppShell.tsx` + `shared/utils/loginReturnPath.ts`  | See section 3.                                                                                                                                                                                                                                                                                     |
| Theme         | `shared/theme/tailwind.css` + `shadcn-tailwind.css` | See section 1.                                                                                                                                                                                                                                                                                     |

---

## 1. Theme

### 1.1 Files

| File                               | Lines | Copy?            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ----- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/theme/tailwind.css`        | 1053  | COPY, then prune | Tailwind v4 entry: layer order, imports (`tailwindcss/theme.css`, `preflight.css`, `utilities.css source('../../..')`, `tw-animate-css`, `./shadcn-tailwind.css`), `@theme` animations, `@theme inline` colour/radius utilities, `@theme static` font tokens, `:root` `--si-*` palette, `--tx-*` transport states, shadcn semantic tokens, shell ignition rules, named utilities, `@font-face` block, base layer (focus, selection, scrollbars, body). For Vite: change `source('../../..')` to the new web root (or drop it — Vite's plugin scans from project root); drop the Next/Turbopack commentary. |
| `shared/theme/shadcn-tailwind.css` | 651   | COPY verbatim    | Vendored shadcn 4.23.0 `dist/tailwind.css`: `data-open/closed/checked/...` custom variants matching Base UI's bare `data-*` attrs, accordion keyframes, `no-scrollbar`, `scroll-fade`, shimmer utilities. No colour tokens. Needed by every `components/ui/*` primitive.                                                                                                                                                                                                                                                                                                                                   |
| `shared/theme/ThemeProvider.tsx`   | 24    | Optional         | Renders two empty `div.v5-bg-glow` nodes (backgrounds are now `none`). Visually a no-op — can be dropped along with the `.v5-bg-glow` rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `shared/theme/*.test.ts`           | —     | Optional         | `contrastTokens`, `deadCss.repo`, `fonts.repo`, `showIgnitionTokens.repo`, `tailwindBuild`, `v5Leftovers.repo` — guardrail tests; `tailwindBuild` runs a Next build (rewrite or drop).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `components.json` (web root)       | —     | COPY, edit       | shadcn config: `style: base-nova`, `iconLibrary: lucide`, `baseColor: neutral`, cssVariables, aliases `@/shared/components`, `@/shared/components/ui`, `@/shared/lib/utils`, `@/shared/hooks`. Set `rsc: false` for Vite.                                                                                                                                                                                                                                                                                                                                                                                  |
| `shared/lib/utils.ts`              | 7     | COPY             | `cn()` = `twMerge(clsx(...))`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Dependencies the theme/primitives need: `tailwindcss@4`, `@tailwindcss/vite` (replaces `@tailwindcss/postcss`), `tw-animate-css`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@base-ui/react`, `lucide-react`, `sonner`, `cmdk`.

### 1.2 Fonts

Two locations; both must be served.

| Face                                  | Weights          | File                                                                                                                                                                  | Loaded from                                      |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Barlow (UI/body)                      | 400              | `web/public/static/fonts/barlow-400-latin.woff2`                                                                                                                      | `/static/fonts/...` (public, preloaded)          |
| Barlow                                | 500              | `assets/fonts/barlow-500-latin.woff2`                                                                                                                                 | bundled url()                                    |
| Barlow                                | 600              | `web/public/static/fonts/barlow-600-latin.woff2`                                                                                                                      | public, preloaded                                |
| Barlow                                | 700              | `assets/fonts/barlow-700-latin.woff2`                                                                                                                                 | bundled                                          |
| Barlow Condensed (labels/tabs/status) | 500/600/700      | `assets/fonts/barlow-condensed-{500,600,700}-latin.woff2`                                                                                                             | bundled                                          |
| JetBrains Mono (timecode/measure)     | 500–600 variable | `assets/fonts/jetbrains-mono-latin-var.woff2`                                                                                                                         | bundled                                          |
| League Gothic (wordmark only)         | 400              | latin: `web/public/static/fonts/league-gothic-latin.woff2` (preloaded); vietnamese/latin-ext subsets: `assets/fonts/qFdC35CBi4tvBz81xy7WG7ep0h{c,Y}ojnA4PLDzOA.woff2` | mixed                                            |
| Roboto                                | 500              | `assets/fonts/roboto-500.woff2`                                                                                                                                       | bundled — used only by the Google sign-in button |

All `@font-face` rules are in `tailwind.css` `@layer base` (around line 812), each with `font-display: swap` and a latin `unicode-range`. Copy `assets/fonts/*` and `public/static/fonts/*` verbatim; keep the three `<link rel=preload as=font type=font/woff2 crossorigin=anonymous>` tags in `index.html`.

Font tokens (`@theme static`): `--font-ui: 'Barlow','Segoe UI',system-ui,sans-serif` (also `--font-sans`), `--font-label: 'Barlow Condensed','Arial Narrow','Barlow',system-ui,sans-serif`, `--font-tc: 'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace`, `--font-mono: var(--font-tc)`, `--font-league-gothic`. Utilities: `font-ui`, `font-label`, `font-tc`, `font-mono`, `font-league-gothic`.

Body baseline: Barlow 15px / line-height 1.45, `color: --si-fg`, `background: --si-bg`.

Other assets:

- `assets/video/AutoLogger_Small.webm` — looping brand animation in the boot loader (`.autologger-loading-video__media`, height 3rem, max-width min(40vw,12rem)). `shared/utils/loadingVideo.ts` freezes other instances at frame 0.
- `assets/logos/logo-autologger-transparent.png`, `public/static/logo-autologger-{app,transparent}.png` — favicon/app icons.
- `assets/icons/*.png` (`app_title`, `icon_dropdown`, `icon_menu`, `icon_nav_back`, `icon_next_nav`, `icon_pause_white`, `icon_play_white`, `icon_search`, `tab_select_marker`) — legacy V4 PNGs, not referenced by any current TS/CSS; do not copy (all icons are lucide).

### 1.3 Colour tokens (dark only — there is NO light theme)

There is no `.dark` class, no `prefers-color-scheme` handling, no theme toggle. Everything is one dark set. Viewport `themeColor: #101216`.

Base palette (`:root`, tailwind.css ~line 261):

| Token                                                                            | Value                                        | Role                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `--si-bg`                                                                        | `#101216`                                    | page ground, inputs, scrollbar track                                                         |
| `--si-panel`                                                                     | `#16181d`                                    | cards, transport card at rest, table headers, log buttons                                    |
| `--si-panel-2`                                                                   | `#1c1f25`                                    | raised: secondary buttons, popovers, menus, keycaps                                          |
| `--si-line`                                                                      | `#272b33`                                    | hairlines                                                                                    |
| `--si-line-strong`                                                               | `#343944`                                    | input borders, scrollbar thumb                                                               |
| `--si-fg`                                                                        | `#eceef2`                                    | text                                                                                         |
| `--si-muted`                                                                     | `#a6acb7`                                    | secondary text                                                                               |
| `--si-dim`                                                                       | `#858c98`                                    | column heads, crumb separators                                                               |
| `--si-ink`                                                                       | `#0b0c0f`                                    | text on light pills                                                                          |
| `--si-accent`                                                                    | `#5b7cff`                                    | THE accent                                                                                   |
| `--si-danger` / `--si-danger-line`                                               | `#ff9b9b` / `#5a2e33`                        | destructive                                                                                  |
| `--si-rec`                                                                       | `#ff6464`                                    | idle record glyph only                                                                       |
| `--si-wave-body`                                                                 | fg 13%                                       | waveform unplayed                                                                            |
| `--si-accent-text`                                                               | accent 72% → white                           | accent text (live timecode)                                                                  |
| `--si-primary-tint` / `--si-primary-line`                                        | accent 26% into panel-2 / 55% into line      | primary button                                                                               |
| `--sel-bg` / `--sel-line`                                                        | accent 18% / 48% transparent                 | THE selected state (`background:var(--sel-bg); box-shadow: inset 0 0 0 1px var(--sel-line)`) |
| `--si-tx-stopped/rolling/recording/playback`                                     | accent 10% / 25% / 25% / 18% into near-black | frame tints                                                                                  |
| `--r-ctl` 8px, `--r-card` 12px, `--h-ctl` 36px, `--h-sm` 30px, `--topbar-h` 52px |                                              | shape                                                                                        |

Transport state variables (set by `[data-transport='stopped'|'rolling'|'recording'|'playback']`, `:root` = stopped): `--tx-rail`, `--tx-bar`, `--tx-live`, `--tx-playhead`, `--tx-glow`, `--tx-playhead-glow`, `--tx-wave-progress`, `--tx-pill-bg`, `--tx-pill-fg`, `--tx-pill-line`. Values: see tailwind.css lines 319–366 (copy verbatim). Transition `--tx-dur: 0.6s`, `--tx-ease: cubic-bezier(0.16,1,0.3,1)`.

shadcn semantic tokens (all aliases of `--si-*`): `--background`, `--foreground`, `--card`, `--popover` (=panel-2), `--primary` (=accent) / `--primary-foreground` (=ink), `--secondary` / `--muted` (=panel-2), `--muted-foreground` (=muted), `--accent` (= `rgba(255,255,255,.06)` hover wash, NOT the blue!), `--destructive`, `--border`, `--input` (=line-strong), `--ring` (=accent), `--sidebar` (= `--tx-rail`), `--sidebar-border` (accent 22% into line), `--sidebar-accent` (hover wash) etc. `--radius: 10px` drives `rounded-sm/md/lg/xl`.

Tailwind colour utilities exposed: `bg-background`, `text-muted-foreground`, … plus `bg-si-bg|panel|panel-2`, `text-si-fg|muted|dim|accent|danger`, `border-si-line`, `rounded-ctl`, `rounded-card`. Legacy aliases still in use by components: `text-v5-text|muted|soft|primary|danger`, `border-v5-line|border|border-strong`, `rounded-v5-lg|md|sm` (all re-pointed at `--si-*`), `--color-text #e8eaed`, `--color-legacy-muted #9aa0a6`, `--color-legacy-accent #7cb7ff`, `--legacy-border #343842`, `--accent-dim #4a8fd9`, `--danger #ff6b6b`, `--color-danger`. In the rebuild, rewrite those consumers onto `--si-*` and drop the aliases — EXCEPT keep a mapping for API category colours: `shared/utils/categoryColor.ts` maps a stored category colour of literally `var(--muted|border|accent)` to `var(--legacy-…)` (frozen wire values). If the new API normalises colours to hex, drop this.

Category colours are user data. Default 9-slot palette (`pages/index/utils/palette9.ts`): `#64748b #e53935 #fb8c00 #fdd835 #43a047 #00acc1 #1e88e5 #8e24aa #ec407a`. Shown only as a 2px swatch, a 55% hover edge, and a 22% latched/pressed tint (via `--cat` CSS var on the log button).

Z-index scale (`:root`): `--z-settings-view 1400`, `--z-dialog-overlay 5000`, `--z-dialog-content 5001`, `--z-popover 5300`, `--z-top-float 5500`, `--z-toast 6000`.

Geometry vars still read: `--v4-cat-btn-h 6.665rem`, `--v4-ctrl-btn-my`, `--v4-zoom-handle-w/h`, `--v4-nav-grid-my 0.5rem`, `--v5-timeline-lane-h` (= 1.5 × (3.45rem + 1rem)).

### 1.4 Shell ignition (the signature look)

Pure CSS keyed off `data-transport` on the shell root (`SidebarProvider` wrapper in AppShell). Hooks the rebuild must keep (or rename consistently):

- `#v6-rail` (desktop sidebar container): border-right `--sidebar-border`; rolling/recording → border accent 70% + `box-shadow: 12px 0 36px -18px var(--tx-glow)`; playback → border accent 40%.
- Mobile sheet sidebar `[data-slot='sidebar'][data-mobile='true']` follows via `:root:has([data-transport=…])`.
- `[data-slot='topbar']`: bg `--tx-bar`, border-bottom accent 22% into line; live → 70% accent border + `0 12px 36px -18px` glow.
- `#v5-maximize-log-strip` (the transport card): panel/line at rest; live → bg accent 13% into `#121419`, border accent 55%, glow `0 10px 34px -14px` + 1px accent-28% ring; playback → accent 8% bg, 38% border, softer glow.
- `#session-tc-display` (hero timecode): live → colour `--si-accent-text` + `text-shadow: 0 0 20px var(--tx-glow)`.
- `[data-slot='live-dot']`: blinks (`si-blink 1.2s steps(2)`) while recording.
- All transitions over 0.6s; `prefers-reduced-motion` disables transitions and the blink.

The transport state comes from `pages/index/coordination/transportStatus.ts` (tiny external store; OLD-INTERNAL but trivially re-implementable): `{state:'stopped'|'rolling'|'recording'|'playback', sessionId, title}`; labels `STOPPED / ROLLING / REC / PLAY`.

### 1.5 Custom utilities / global rules heavily used

| Name                                                                  | Where defined                            | Used by                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hover-always:` variant                                               | `@custom-variant hover-always (&:hover)` | toolbar ("glass") buttons and many legacy rows (fires on touch tap).                                                                                                                                                                                                                                                                                                                                 |
| `cat-strip-scrollbar`                                                 | `@utility`                               | CategoryButtonStrip thin scrollbar.                                                                                                                                                                                                                                                                                                                                                                  |
| `pal-slot`                                                            | `@utility`                               | Settings › Event buttons `<input type=color>` swatch (2rem square, 0.4rem radius).                                                                                                                                                                                                                                                                                                                   |
| `timeline-hide-scrollbar`                                             | `@utility`                               | Timeline viewport.                                                                                                                                                                                                                                                                                                                                                                                   |
| Animations                                                            | `@theme`                                 | `animate-tooltip-fade-in`, `animate-popover-fade-in`, `animate-overlay-fade-in`, `animate-content-fade-in`, `animate-wf-label-pulse` (waveform "importing/decoding…"), `animate-yt-import-pulse` (orange `#fb923c`↔`#c2410c`, YouTube import status — the only non-accent hue in chrome), `animate-marker-msg-marquee` (timeline marker message, 15s), `animate-event-row-flash` (22% accent, 2.5s). |
| `#v4-log-sheet tr.event-row-flash > td`                               | components layer                         | Feed row flash when jumping from a timeline marker.                                                                                                                                                                                                                                                                                                                                                  |
| `body[data-hide-internal='1'] .timelineMarker[data-cat='Internal' i]` | components                               | hides "Internal" category markers when the feed's "show internal" toggle is off.                                                                                                                                                                                                                                                                                                                     |
| `body.v4-is-recording #top-bar-recording-dur / #top-bar-mic-level`    | components                               | recording duration + mic meter visible only while THIS client records.                                                                                                                                                                                                                                                                                                                               |
| `body.autologger-audio-saving`                                        | components                               | blocks pointer events except `#autologger-audio-save-overlay` during audio finalize.                                                                                                                                                                                                                                                                                                                 |
| `.hidden { display:none !important }`                                 | components                               | legacy; note it beats `md:block` etc. (V6Rail works around it with `[display:none]`). Drop in rebuild.                                                                                                                                                                                                                                                                                               |
| Base inputs                                                           | components layer                         | `input[type=text], textarea`: ground bg, line-strong border, `--r-ctl`, padding .55rem .65rem, accent border on focus; placeholder muted; textarea resize vertical min 2.5rem.                                                                                                                                                                                                                       |
| Focus                                                                 | base                                     | `:focus-visible { outline: 2px solid accent; outline-offset: 2px }`; buttons use `ring-[3px] ring-ring/50`.                                                                                                                                                                                                                                                                                          |
| Selection/caret                                                       | base                                     | `::selection` accent 45% into ground; `caret-color: accent`.                                                                                                                                                                                                                                                                                                                                         |
| Scrollbars                                                            | base                                     | 8px, track `--si-bg`, thumb `--si-line-strong` (2px transparent border, radius 8) → accent on hover; Firefox `scrollbar-color`.                                                                                                                                                                                                                                                                      |
| Viewport lock                                                         | components                               | desktop: `html,body { height:100dvh; overflow:hidden }`, body flex column; `max-width:767px` unlocks and the page scrolls. Single breakpoint `md = 768px`.                                                                                                                                                                                                                                           |

### 1.6 Button variants (shared/components/ui/button.tsx — COPY)

Base: `rounded-ctl border font-ui text-[0.8125rem] font-semibold leading-none gap-[0.4rem]`, 16px icons, focus ring 3px accent/50, disabled opacity 45%. Sizes: `default` 36px px-[0.9rem], `sm` 30px, `xs` 24px (0.75rem text, 12px icons), `lg` 40px, `icon` 36px, `icon-sm` 30px, `icon-xs` 24px, `icon-lg` 40px. Variants:

- `default` (primary): `--si-primary-tint` fill, `--si-primary-line` edge, hover edge → accent.
- `outline` / `secondary`: panel-2 fill, hairline, hover edge 25% fg.
- `ghost`: transparent, hover wash.
- `destructive`: 8% rose fill, danger-line edge, rose text.
- `link`.
- `transport`: neutral; `data-active=true` → `--tx-pill-*` colours + `0 0 18px -6px var(--tx-glow)`.
- `log`: category button; `--cat` var; hover edge 55% cat; `data-latched=on` or `.cat-btn-press` → full cat edge + 22% cat tint + translate-y 1px.
- `glass` / `glass-primary`: legacy "toolbar" button at `--h-sm` with 2.55rem touch floor on phones (feed toolbars).

Badge (`ui/badge.tsx`) has a `transport` variant reading `--tx-pill-*` (Barlow Condensed 0.7rem, tracking 0.14em, radius 5px, 8px `live-dot` span inside in the top bar).

---

## 2. Shell layout (AppShell)

```
SidebarProvider (root, data-transport=<state>)  h-[100dvh] flex-col; phones: block
├─ <Toast/> (sonner)
├─ SidebarShortcut  ( "[" toggles sidebar; Ctrl/⌘+B is the primitive's own )
├─ TopBar  header[data-slot=topbar]  h-(--topbar-h)=52px, px-2.5 md:px-4, gap-1.5 md:gap-3
└─ div#v6-app  flex-row flex-1 overflow-hidden (phones: block)
   ├─ V6Rail  shadcn <Sidebar collapsible="icon" id="v6-rail">  top-(--topbar-h), width 272px / 68px icon strip / 18rem mobile sheet
   └─ main#v3-main  block flex-1 relative overflow-x-clip
      ├─ overlays (lazy): NewSessionModal, BatchImportModal, YouTubeImportErrorModal, SettingsView
      └─ route switch: /search → SearchRoute | /wiki → WikiRoute | /wiki/:pageId → WikiPageView | /compilations → CompilationsRoute | /changes → ChangesRoute | else SessionRoute (home when no id)
```

- Zero teams → whole shell replaced by `OnboardingPanel` (create-team form).
- Settings is shell state, not a URL (except `/teams`, which opens Settings on "Members" and closes back to `/`). It renders inside `<main>` over the workspace, below the top bar (z `--z-settings-view`). Back label: "Back to session" / "Back to sessions".
- Lazy chunks go through `LazyChunk` (`components/ChunkLoadBoundary.tsx`): route variant shows `RouteLoadingState` ("Loading search", "Loading wiki", "Loading wiki page") and a retry card on failure; overlay variant shows a dismissible error card. In a Vite SPA you can keep `React.lazy` + a simple error boundary with the same card.

### 2.1 TopBar (`components/TopBar.tsx`)

Left→right, no wordmark, no field labels:

1. `SidebarTrigger` (36px square; title "Toggle sidebar ( [ )").
2. `nav[aria-label="Current team and show"]` crumbs:
   - Team crumb: ghost button, name `text-[15px]` (phones `text-sm`), `max-w-[22ch] truncate` (phones 10ch), `ChevronDownIcon`. Dropdown (300px): label "Your teams", radio items with team name + "N shows" (xs muted) + outline `Badge` role (Owner/Admin/Member).
   - `ChevronRightIcon` separator (`size-3.5 text-si-dim`).
   - Show crumb: same, disabled if team has no shows; label "Shows in {team}"; radio list of shows. Placeholders "No team"/"No show".
   - Separator, then status: transport `Badge` (live-dot + STOPPED/ROLLING/REC/PLAY) followed by the session title in `font-tc text-xs text-muted-foreground` (hidden on phones). With a session open it is a ghost button "Return to {title}" (closes Settings via its discard guard and navigates to the session); with none it reads "No session open".
3. `SearchPalette` trigger (Cmd/Ctrl-K palette — see Search section).
4. Wiki: ghost icon button → `/wiki` (`BookOpenIcon`, text "Wiki" from md up), prefetches the wiki chunk on hover/focus.
5. `span[role=status].sr-only` "Transport {label}".

Switching team/show calls `useSwitchActive` (OLD-INTERNAL: posts active studio/show, then closes the session). Data needed: profile `{ auth.user.teams[{id,name}], shows[{id,name,studio_id}], active_studio, active_show_id }`, team role per team.

### 2.2 V6Rail (`components/V6Rail.tsx`)

shadcn `Sidebar` (`shared/components/ui/sidebar.tsx`), `collapsible="icon"`, widths 272px / 68px / mobile 18rem sheet; surface = `--sidebar` = transport tint.

- Header (`px-3 pt-3 gap-3`): if user can create in the active team — 2-col grid: primary "New session" (`Plus`) and outline "Import" (`Upload`); icon strip shows icon-only buttons with right-side tooltips.
- Search: input with leading `Search` icon, placeholder "Search sessions…", 36px, clear `X` (icon-xs ghost); Escape clears. In the icon strip it collapses to an outline `Search` button that expands the rail and focuses the input. Filters the lists client-side.
- Content (hidden in icon strip): group label "Recent sessions" (label type) → `RecentSessionsList`; group "Archived" → `ArchivedSessionsList` (only when non-empty).
- Separator; Footer: `SidebarMenuButton` "Settings" (`Settings` icon, tooltip), then version `v{APP_VERSION}` in `font-tc text-[0.625rem] text-muted-foreground` centered.
- On mobile, every action closes the sheet first.

Keyboard: `[` toggles the rail (ignored in text inputs and when an overlay other than Settings is open); Ctrl/⌘+B (primitive). Sidebar open/collapsed state persists in localStorage (never a cookie).

---

## 3. Routes

Router-known paths (`shared/utils/loginReturnPath.ts`, `isShellSegments` / `isRouterKnownPathname`):

| Path            | Screen                                                                                       | Notes                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | Home (no session): `SessionRoute` with empty id → `HomeRoute`                                | Rail + top bar always present.                                                                                                                                                                                                                                                                    |
| `/sessions/:id` | Session workspace (`SessionRoute` → lazy `SessionWorkspace`)                                 | id is URL-encoded; re-selecting the active id is a no-op. Query `?t=`/moment deep links handled by `MomentDeepLink`.                                                                                                                                                                              |
| `/teams`        | Home + Settings open on Members                                                              | Closing Settings navigates to `/`.                                                                                                                                                                                                                                                                |
| `/search`       | `SearchRoute` (full results page; query in `?q=` etc.)                                       | lazy.                                                                                                                                                                                                                                                                                             |
| `/wiki`         | `WikiRoute` (page list for the active show)                                                  | lazy.                                                                                                                                                                                                                                                                                             |
| `/wiki/:pageId` | `WikiPageView`                                                                               | lazy; keyed on the route so page→page switches re-render in place.                                                                                                                                                                                                                                |
| `/compilations` | `CompilationsRoute` (video compilations of the active show)                                  | lazy; queued/running cards show queue position and ETA, failed ones Retry; linked next to Wiki in the top bar (rail footer on phones).                                                                                                                                                            |
| `/changes`      | `ChangesRoute` (the active show's change log)                                                | lazy; changes folded per op call with Undo / Undo all; filters (where: whole show / show-level / one session, kind, who) kept in the URL; reached from the Wiki's "Changes" button (preselects show-level wiki changes) and the rail footer; live via the show socket's `invalidate change` hint. |
| anything else   | Next `not-found.page.tsx`: bare "404 — Not Found / This page doesn't exist." (unstyled sans) | In SPA: render a `RouteState` card instead. Trailing slashes 404.                                                                                                                                                                                                                                 |
| `/admin/users`  | REMOVED (2026-10-06 "remove-admin-users-page").                                              | There is no admin screen anymore; admin-ish controls live in Settings (role-gated). `fixtures/api-responses/adminUsers.json` is a leftover.                                                                                                                                                       |

Login-return: before redirecting to OAuth, the current router-known path is stashed (`shared/utils/loginReturnStash.ts`, `loginReturnPath.ts` validates same-origin, router-known paths only); `useLoginReturnConsume` navigates there once `auth.logged_in` becomes true.

Navigation goes through `pages/index/navigation.ts` `navigate(path,{replace})`, which first runs the departure watcher (stop a roll this client originated when leaving the session) — OLD-INTERNAL; reproduce the visible behaviour (leaving a session you started rolling stops the transport, with the stop warning) if the new backend still needs it.

`pages/index/appLocation.tsx` is a custom wouter location hook (sync with in-app pushState) — not needed in a plain Vite SPA; use wouter's default `useBrowserLocation` or react-router.

---

## 4. Login, home & recent sessions

### 4.1 Boot / gate states (`pages/index/RootGate.tsx`, `shared/ui/AppLoadingSkeleton.tsx`, `components/RouteState.tsx`, `components/RouteLoadingState.tsx`)

- **Loading (profile pending):** `AppLoadingSkeleton`, a full-viewport centered frame (`relative z-[1] flex min-h-[100dvh] w-full items-center justify-center px-5 py-10`, `role=status aria-busy`).
  - Default content: card `max-w-[25rem] rounded-v5-lg (12px) border-v5-border-strong bg-si-panel-2 px-7 py-9 text-center` with the wordmark "AutoLogger" (League Gothic bold 2.25rem, uppercase, tracking 0.02em).
  - RootGate replaces the card with the looping brand video `assets/video/AutoLogger_Small.webm` (`.autologger-loading-video__media`, muted, autoplay, loop).
- **Error:** `RouteState frame="gate" role="alert" title="AutoLogger"`, copy "Couldn't reach the server. Check your connection and try again.", full-width 44px primary "Try again" ("Retrying…" while fetching).
- **Signed out** (rebuild: `apps/web/src/app/RootGate.tsx`):
  - At `/`: the public landing page (`apps/web/src/routes/landing/LandingPage.tsx`, lazy-loaded so it stays out of the signed-in bundle). The server's `LANDING_PAGE` setting (default `1`, reported as `landingPage` in `/api/capabilities`) turns it off: with `LANDING_PAGE=0`, `/` redirects to `/login`. While capabilities load the loading frame shows; if they fail to load, the landing page stays on. Its documentation links (Docs menu, MCP and Companion links) point at the upstream `docs/` files unless the server sets `DOCS_URL` (reported as `docsUrl`), which replaces that base and keeps the file names; links to the upstream repos stay.
  - Any other path (deep link): redirect to `/login?return=<path and query>`, so sign-in returns there.
- **RouteState** (generic empty/error panel, built on `ui/empty`):
  - Same card as above; title League Gothic 2.25rem uppercase.
  - Optional badge above the title: 0.6875rem semibold uppercase, tracking 0.14em, muted.
  - Copy: 0.9rem / 1.5, muted, max 19rem. Actions in a `mt-6 flex-col gap-3` stack.
  - Frames: `gate` fills the viewport; `route` is `min-h-[calc(100dvh-var(--topbar-h)-2.2rem)] py-16` (under the top bar).
- **RouteLoadingState:** `<output aria-busy>` in the route frame with the brand video at `h-12 w-auto max-w-[min(40vw,12rem)]`. Labels: "Loading session", "Loading search", "Loading wiki", "Loading wiki page".
- **ChunkLoadBoundary error card** (visual only): an `Alert` plus actions, all `h-11 w-full`: "Retry" (primary), "Reload page", and "Dismiss" for overlays.
  - Route title "Couldn't finish loading"; overlay/dialog title "Couldn't load this panel".
  - Generic render error: "Something went wrong" / "This part of the app hit an unexpected error. Reloading the page usually clears it." with Reload only.
  - The overlay variant is a fixed top card `fixed inset-x-0 top-0 z-(--z-toast) mx-auto mt-2 w-[min(28rem,94vw)] p-4 shadow-[0_8px_32px_rgba(0,0,0,0.35)]`.

### 4.2 LoginPage (`components/LoginPage.tsx`)

- **Layout:** full-viewport centered `main max-w-[25rem]` with a `Card` at `px-7 pt-8 pb-9 text-center` (phones `px-5 pb-8`), `animate-overlay-fade-in`.
- **BrandMark** (decorative, `h-12 w-64`), a timeline sketch:
  - Band `h-1.5 rounded-full border-si-line bg-si-panel-2`.
  - Dim dots at 12%, 64% and 86%; one accent pill (`h-2 w-5`) at 34%.
  - Accent playhead (`w-0.5`) at 46% with glow `0 0 10px 1px color-mix(accent 75%)`.
- **Wordmark h1:** "AutoLogger", League Gothic bold 2.75rem (2.4rem on phones), uppercase.
- **Tagline:** "Sign in to open your sessions, markers, and transcripts." (0.9rem, muted).
- **Error banner:** shown when `?login_error=` is set. Destructive `Alert` with a danger-line border, followed by an underlined "Try again" link.

  | `login_error`    | Message                                                                                           |
  | ---------------- | ------------------------------------------------------------------------------------------------- |
  | `state_invalid`  | "This sign-in attempt expired."                                                                   |
  | `provider_error` | "Sign-in was cancelled or refused."                                                               |
  | `signup_closed`  | "This Google account doesn't have access yet. Ask the person who gave you the link to set it up." |
  | anything else    | "Sign-in didn't complete."                                                                        |

- **Google button** (vendor styling, the one non-palette surface):
  - White bg, `border-[#747775]`, h-12, Roboto 500 at 0.9rem, text `#1f1f1f`; hover bg `#f8f9fa`, border `#5f6368`.
  - Inline 4-colour Google "G" SVG. Label "Sign in with Google" → `/auth/google/start`; the click stashes the return path first.
- **Divider row:** separators around "New to AutoLogger?" (0.625rem, tracking 0.18em, uppercase).
- **Second button:** outline h-11 "Create an account with Google", label colour `rgba(229,238,252,0.78)`.
- **Fine print** (0.78rem): "Your account is created automatically the first time you sign in with Google. There is no separate sign-up form."
- **"What is AutoLogger?"** (rebuild): a small muted link under the card back to the landing page at `/`. It follows the same setting: hidden with `LANDING_PAGE=0`, shown when capabilities fail to load.

### 4.3 HomeRoute (`components/HomeRoute.tsx`): `/`, no session open

- **Layout:** centered column `min-h-[calc(100dvh-var(--topbar-h)-4rem)] px-6 py-16`, inner `max-w-[26rem] gap-7`.
- **Header:** "AutoLogger" in League Gothic bold 3.4rem uppercase, with the subline "Every session becomes a searchable, visual record — events, transcripts, topics."
- **Resume card** (only when the first active session is accessible):
  - `max-w-[24rem] rounded-12 border-strong bg-si-panel-2 px-6 py-5 text-left`; hover border 35% accent.
  - Title 1.05rem semibold; `{date} · {n} events` at 0.72rem muted.
  - "Jump back in →" (`ArrowRight`, `--si-accent-text`) is a whole-card link via `::after`.
- **Create button** (if the user can create): outline "New session" when there is a recent session, otherwise primary "Start a session" (`Plus`).

### 4.4 Rail session lists (`components/RecentSessionsList.tsx`)

Rendered inside the Sidebar groups "Recent sessions" and "Archived", filtered client-side by title from the rail's search input.

- **Row** (`SidebarMenuButton size="lg"`, `min-h-12 flex-col py-1.5`):
  - Line 1: title (semibold, truncated), plus a "LIVE" or "REC" `Badge` (0.625rem) while live.
  - Line 2: `{date} · {n} events` (xs muted) against the runtime in `font-tc text-xs tabular-nums`. Runtime is `total_runtime_hms`, or the live timecode in fg; tooltip "Current timecode" / "Total runtime".
  - The active row takes the selected state (`aria-current=page`).
- **Row menu:** `MoreVertical` show-on-hover action; dropdown opens to the right.
  - Active session: Close session, Rename, Archive, Delete (destructive).
  - Archived session: Restore, Delete.
- **Rename dialog:** "Rename session", field "Session name" (max 200, Enter saves), Cancel / Save ("Saving…").
- **Confirms:**
  - Delete: "Permanently delete "X"? This cannot be undone."
  - Archive: "Archive "X"? You can restore it later from Archived sessions."
  - Restore: "Restore "X" to Recent sessions?"
- **Toasts:** "Session updated." / "Session archived." / "Session restored." / "Session permanently deleted."
- **No-access row:** muted title plus "No access — ask a team admin".
- **States** (empty notes are 13px muted):
  - Loading: brand video.
  - Empty: "No sessions yet. Create one to start logging."
  - No filter match: "No sessions match "q"." (archived list: "No archived sessions match "q".").
- **Data per row:** `id, title, show_id, episode_date, created_at_utc, event_count, total_runtime_hms, is_rolling, rolling_timecode, start_offset_frames`. The active row also polls status for `is_rolling`, `timecode` and `audio_recording_lease_alive`.

---

## 5. Search

### 5.1 Command palette (`components/search/SearchPalette.tsx`, `SearchPaletteBody.tsx`)

- **Trigger:** ghost icon button (36px, `SearchIcon`) in the top bar, tooltip "Search" with `Kbd` caps ⌘/Ctrl + K.
- **Shortcut:** ⌘/Ctrl+K opens it globally. Ignored while typing in a field or when another overlay is open; not with Alt or Shift.
- **Dialog:** `top-[12vh] w-[min(100%-2rem,38rem)] p-0`, translate(-50%,0).
- **Body:** cmdk `Command` (`shouldFilter=false`).
  - Placeholder "Search sessions, transcripts, topics, events…"; debounce 200ms; limit 5 per group; list `max-h-[min(60vh,28rem)]`.
- **Groups, in order:**
  1. Studios: name.
  2. Shows: name.
  3. Sessions: title (or "Untitled session") in medium weight, episode xs dim, then a two-line snippet.
  4. Moments: label `Speaker 3 · 1:12:03` (or "Topic"/"Event") with the session title in xs dim, then a two-line snippet (text-sm).
  5. Footer: separator, then "See all results" → `/search?q=`.
- **Status line** (centered, text-sm muted):
  - "Type at least 2 characters to search."
  - "Searching…" with a Spinner.
  - "No results for "q"."
  - The error message.
- **Choosing a result:**
  - Studio or show: switches the active team/show.
  - Session: `/sessions/:id`.
  - Moment: `/sessions/:id?t=<sec>`.
- **Snippet highlighting** (`SearchSnippet.tsx`): the server wraps hits in U+E000…U+E001. Hits render as `<mark class="rounded-[2px] bg-si-accent/20 px-0.5 font-medium text-si-fg">`; the rest is `text-si-muted`.

### 5.2 Search page `/search` (`components/search/SearchRoute.tsx`)

- **Frame** (shared with the wiki pages): `md:absolute md:inset-0 md:overflow-y-auto`, inner `mx-auto max-w-[52rem] flex-col gap-5 px-4 py-6`.
- **Header:** h1 "Search" at 1.35rem semibold.
- **Controls row:** search input with a leading icon, plus two Selects (`md:w-44`), "All studios" and "All shows".
  - State lives in the URL (`q`, `studio_id`, `show_id`), written with replace-navigation. Limit 25.
- **Result groups:** heading xs semibold uppercase dim; rows are full-width ghost rows `rounded-ctl px-3 py-2.5`, hover `bg-si-panel-2`.
  - Studios: name.
  - Shows: name plus team.
  - Sessions: title, episode, and a right-aligned `font-tc` date, then the snippet.
  - Moments: grouped by session under an h3 title.
    - "Show N more in this session" expands the group.
    - Expanded: "Showing X of Y matches in this session" with an "Open session" link.
- **States:**
  - Too short: "Type at least 2 characters to search sessions, transcripts, topics and events."
  - Searching: spinner.
  - Error: message plus outline "Try again".
  - Empty: "No results for "q"."

---

## 6. Wiki

All wiki pages use the Search frame. In markdown, `wiki:<pageId>` is a wiki link and `cite:<sessionId>@<seconds>` is a moment citation.

### 6.1 `/wiki` (`components/wiki/WikiRoute.tsx`)

- **Header:** h1 "Wiki" with the show name below (sm muted); primary "New page" (`PlusIcon`) on the right.
- **No active show:** `Empty`, "No show chosen" / "Choose a show in the top bar to see its wiki."
- **Filter:** input "Filter by title or alias"; accent-folded match over title and aliases.
- **Line tabs:** People, Topics, Running bits, Sessions, Deleted, Suggestions (with count badge). `?tab=suggestions` selects the last one.
- **Page rows** (`rounded-ctl px-3 py-2.5`, hover panel-2):
  - Title.
  - "Also: aliases" (xs muted).
  - "Updated {date} by {name}" (xs dim).
- **Deleted tab:** rows carry an outline sm "Restore".
- **Truncation:** "Showing the first N pages."
- **Empty copy:**

  | Tab          | Copy                    |
  | ------------ | ----------------------- |
  | People       | "No people yet."        |
  | Topics       | "No topics yet."        |
  | Running bits | "No running bits yet."  |
  | Sessions     | "No session pages yet." |
  | Deleted      | "No deleted pages."     |
  | Filter miss  | "No pages match "q"."   |

- **Loading / error:** "Loading pages…" with spinner; error message plus "Try again".
- **Suggestions tab (LEFTOVER/AI):** grouped by page or "New page · Kind". Each item has title, a two-line rationale, a "Stale" badge, a session link and "date · author", and opens `WikiSuggestionSheet`. Empty copy: "No suggestions waiting for review. Use "Update wiki" in a session to get some."
- **Kind labels** (`wikiKindLabels.ts`): person → Person, topic → Topic, bit → Running bit, session → Session.

### 6.2 `/wiki/:pageId` (`components/wiki/WikiPageView.tsx`)

- **Back link:** "← Wiki" (xs dim).
- **Other-show alert:** "This page belongs to {show}" + "Switch to {show}".
- **Header:**
  - Kind outline badge, plus a destructive "Deleted" badge if deleted.
  - h1 at 1.35rem.
  - Alias chips: outline badges with `normal-case tracking-normal`.
  - "Last changed by {name}, {date} · r{rev}" (xs dim).
- **Pending-suggestion alert (LEFTOVER/AI):** `SparklesIcon`, "Review suggestion".
- **Action row** (sm):
  - Edit (`PencilIcon`, primary)
  - History (`HistoryIcon`)
  - Merge into… (`GitMergeIcon`; not on session pages)
  - Split (`ScissorsIcon`)
  - Delete (`Trash2Icon`, ghost danger)
- **Deleted page:** alert with Restore.
- **Body:** WikiMarkdown, or "This page is empty."
- **Edit mode:** WikiEditor with Cancel / Save. Validation: "A page needs a title."
- **Optimistic concurrency** (`expected_revision`): a 409 shows "{name} saved this page while you were editing" with "Load the newer page".
- **Delete confirm:** "Delete this page?" (danger).
- **Other states:**
  - Loading: "Loading page…"
  - 404: "Page not found. It may be in a show you can't open."
  - Merged: "This page was merged…" then a redirect to `merged_into`.

### 6.3 Wiki components

- **WikiEditor:**
  - Title input (max 200).
  - Aliases (not on session pages): removable chips, an input "Add an alias, then press Enter", and "Add".
  - Line tabs Write / Preview.
  - Write: mono textarea `min-h-[18rem] text-[0.85rem]` with a link-syntax hint. Preview: bordered box, or "Nothing to preview yet."
- **WikiMarkdown** (react-markdown, `skipHtml`; URLs limited to `wiki:`, `cite:` and https):
  - Prose 0.9rem relaxed; h1 xl, h2 lg, h3 base.
  - Blockquote: left border line-strong, muted text. `pre`: `bg-si-panel-2`.
  - Links: underlined, hover accent.
  - `cite:` links append a mono `h:mm:ss` (dim). Images render as alt text only.
- **WikiHistorySheet:** right Sheet `sm:max-w-xl`.
  - Revision rows: mono `r{n}`, note, author, time; "Load older" paging.
  - Choosing a revision shows "r{n} → current page": the diff plus Restore.
- **DiffFigure** (`wikiDiff.tsx`): mono 0.78rem in a bordered box. Added lines `bg-(--si-primary-tint)`, removed `bg-(--si-danger-line)`, unchanged muted; marks `+` / `−`.
- **WikiMergeDialog:** "Merge into…" with a cmdk page picker (title + kind). Empty: "No other page to merge into."
- **WikiSplitDialog:** "Split into a new page" (`md:max-w-2xl`).
  - Two mono textareas: "Stays on this page" and "Moves to the new page".
  - Kind radio, new title, aliases (comma-separated).
- **NewWikiPageDialog:** "New page" with a Kind radio (Person / Topic / Running bit) and Title. A title collision shows an alert linking to the existing page.
- **SessionWikiButton** (session header): ghost sm "Wiki page" (`BookOpenIcon`); opens or creates the session's page.
- **UpdateWikiButton (LEFTOVER/AI, remove):** "Update wiki" (`SparklesIcon`) → `sessions/:id/wiki/generate`.
  - Toast "N suggestions ready" with Review.
  - On 503: "Add a language model in Settings → Advanced…".
- **WikiSuggestionSheet (LEFTOVER/AI):** badges, rationale, a diff from the current page to the proposal, stale/conflict alerts. Actions: Accept, "Edit, then accept", Dismiss. In the rebuild, external agents write wiki pages directly via MCP; if a review queue is still wanted, keep this sheet's visual pattern but feed it agent-proposed revisions.

---

## 7. Shared primitives

Every `shared/components/ui/*` file imports only react, `@base-ui/react`, cva/clsx/tailwind-merge (`@/shared/lib/utils`), lucide, cmdk, sonner, or other primitives. None imports from `api/`, `pages/` or Next; some carry a harmless `'use client'`. **COPY all of them verbatim**, plus `shared/lib/utils.ts`, and give the Vite config the alias `@ → src`.

| File            | Importers | Notes                                                                                                                                                                                                                                                                                        |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button`        | ~58       | Variants: default, destructive, outline/secondary, ghost, link, `transport`, `log`, `glass`/`glass-primary` (30px feed-toolbar buttons; legacy name, flat style), `unstyled`. Sizes: 36 / xs 24 / sm 30 / lg 40 / icon*. Exports `TOUCH_TARGET`. Supports `nativeButton={false}` + `render`. |
| `badge`         | 13        | Condensed 0.7rem uppercase, 5px radius; `transport` variant is the status pill.                                                                                                                                                                                                              |
| `alert`         | 17        |                                                                                                                                                                                                                                                                                              |
| `card`          | 15        |                                                                                                                                                                                                                                                                                              |
| `input`         | 25        |                                                                                                                                                                                                                                                                                              |
| `field`         | 18        |                                                                                                                                                                                                                                                                                              |
| `spinner`       | 19        |                                                                                                                                                                                                                                                                                              |
| `empty`         | 12        |                                                                                                                                                                                                                                                                                              |
| `checkbox`      | 9         |                                                                                                                                                                                                                                                                                              |
| `item`          | 6         | Settings lists.                                                                                                                                                                                                                                                                              |
| `tabs`          | 6         | List variants `line` (workspace, wiki) and `nav` (Settings).                                                                                                                                                                                                                                 |
| `label`         | 5         |                                                                                                                                                                                                                                                                                              |
| `textarea`      | 4         |                                                                                                                                                                                                                                                                                              |
| `radio-group`   | 4         |                                                                                                                                                                                                                                                                                              |
| `separator`     | 4         |                                                                                                                                                                                                                                                                                              |
| `table`         | 4         | Feeds.                                                                                                                                                                                                                                                                                       |
| `dropdown-menu` | 4         | TopBar, session row, TeamDetails, EventLogSheet.                                                                                                                                                                                                                                             |
| `sheet`         | 4         | Wiki sheets, Settings SidePanel, mobile sidebar.                                                                                                                                                                                                                                             |
| `sidebar`       | 4         | Depends on button, input, separator, sheet, skeleton, tooltip and `shared/ui/breakpoints`. Ctrl/⌘+B; `collapsible="icon"`; state in localStorage.                                                                                                                                            |
| `toggle-group`  | 3         |                                                                                                                                                                                                                                                                                              |
| `toggle`        | 1         |                                                                                                                                                                                                                                                                                              |
| `kbd`           | 3         |                                                                                                                                                                                                                                                                                              |
| `tooltip`       | 3         |                                                                                                                                                                                                                                                                                              |
| `dialog`        | 3         |                                                                                                                                                                                                                                                                                              |
| `command`       | 2         | cmdk.                                                                                                                                                                                                                                                                                        |
| `avatar`        | 2         |                                                                                                                                                                                                                                                                                              |
| `select`        | 2         | App wrapper `pages/index/components/Select.tsx` (+ `LazySelect.tsx`).                                                                                                                                                                                                                        |
| `alert-dialog`  | 1         |                                                                                                                                                                                                                                                                                              |
| `drawer`        | 1         |                                                                                                                                                                                                                                                                                              |
| `scroll-area`   | 1         | FeedTable.                                                                                                                                                                                                                                                                                   |
| `skeleton`      | 1         |                                                                                                                                                                                                                                                                                              |
| `sonner`        | 1         |                                                                                                                                                                                                                                                                                              |

App-level shared pieces:

| File                                  | Importers | Notes                                                                                                                                                                                 |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/components/Toast.tsx`         | 14        | sonner, bottom-right. Toast is panel-2, 8px radius, 0.85rem; errors get a danger border and `#ffb4b4` text. API: `showToast(msg, isError, {persistent, action})` and `toast.*`. COPY. |
| `shared/ui/Dialog.tsx`                | 12        | Centered dialog on desktop, bottom Drawer on mobile; also `DialogActions`. COPY.                                                                                                      |
| `shared/ui/ConfirmDialog.tsx`         | 19        | `useConfirm()` → `confirm({title,message,confirmLabel,danger})`. COPY.                                                                                                                |
| `shared/ui/PromptDialog.tsx`          | 1         | COPY.                                                                                                                                                                                 |
| `shared/ui/Tooltip.tsx`               | 6         | Wrapper. COPY.                                                                                                                                                                        |
| `shared/ui/breakpoints.ts`            | 3         | COPY.                                                                                                                                                                                 |
| `shared/ui/overlayOpen.ts`            | 7         | COPY.                                                                                                                                                                                 |
| `shared/ui/AppLoadingSkeleton.tsx`    | 2         | COPY.                                                                                                                                                                                 |
| `shared/hooks/useVersionedSave.tsx`   | 5         | **OLD-INTERNAL**: type-imports `VersionGuard` from `api/versionConflict`. Implements the 409 three-way conflict prompt; rebuild for the new API.                                      |
| `shared/hooks/conflictPromptCopy.tsx` | 3         | Depends only on ConfirmDialog; COPY.                                                                                                                                                  |

Copyable utilities in `shared/utils/`: `timecode.ts`, `timelineSec.ts`, `fmtDateOnly.ts`, `categoryColor.ts`, `waveformSvg.ts` / `waveformMerge.ts` / `waveformDecode.ts` (pure rendering helpers). `audioClips.ts`, `recording.ts` and `workerInterval.ts` are recorder internals.

---

## 8. Data shapes (drives the new API)

Source: `web/src/api/types.ts` (1232 lines). `web/src/types/` holds only asset and css-module declarations. Fixtures are in `/home/autologger/autologger-2/fixtures/api-responses/`.

**Profile / teams / shows**

- `ProfilePayload { active_studio_id, active_show_id, active_studio{id,name,categories}, studios[{id,name}], studio_settings, shows: ProfileShow[], new_session_defaults{title_prefix, default_frame_rate}, admin{restart_supported, restart_needs_token}, auth{logged_in, oauth_configured, user} }`
- `user { id, email, given_name, family_name, picture_url, teams[{id,name,role: owner|admin|member}] }`
- `ProfileShow { id, studio_id, name, show_code, title_suffix: date|episode, can_access }`
- `Show` adds `categories: ShowCategory[], event_palette[], event_palette_preset, event_palette_custom[]`.
- Show access is derived client-side from `can_access` plus team role; owner and admin are managers.
- `TeamDetail { id, name, role, enabled_admin_count, members[{id,email,given_name,family_name,role,show_ids?}], invites?[{email, invited_at_utc}] }`. `show_ids` are the per-show grants.
- Team mutations: create `{id, display_name}`, rename, invite `{email}`, role change `{admin|member}`, owner transfer `{user_id}`.

**Sessions**

- `Session { id, title, deck_title, show_id, show_code, show_name, episode, notes, session_status, frame_rate, start_offset_frames, created_at_utc, episode_date, event_count, is_rolling, current_take, rolling_timecode, total_runtime_hms, archived }`. The list response is `{active[], archived[]}`.
- `SessionStatus { is_rolling, timecode, session_timecode, master_timecode, frame_rate, current_take, audio_recording_lease_alive, audio_recording_lease_holder_id, event_count, logged_event_count, title, deck_title, show_name, show_code, episode, session_created_at_utc, now_utc, notes, show_id, events_stream_revision }`
- Transport snapshot: `{ is_rolling, current_take, roll_started_at_utc, elapsed_frames, timecode, timecode_total_frames }`

**Events / categories**

- `LogEvent { event_id, category, category_label, category_color, message, timecode, timecode_total_frames, frame_rate, wall_time_utc, metadata, version }`
- `EventsResponse { events, total, logged_event_count, offset, limit, has_auto_generated }`
- `Category { id, label, color, type: BUTTON|DROPDOWN|TEXT|ON_OFF, dropdown_options[{label, needs_context}], on_label, off_label }`. `ShowCategory` adds `name` and `auto_instruction?` (LEFTOVER/AI).

**Transcript / topics / audio**

- `TranscriptWord { id, session_time, speaker, word, start_sec, end_sec, ordinal, version }`. Segments are grouped client-side.
- `SessionTopic { id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc, version }`
- Version conflicts return 409 `{detail: 'Version conflict.', current}`.
- `AudioSegment { id, ordinal, recording_ordinal, started_at_utc, ended_at_utc, mime_type, url, waveform_peaks, waveform_db_floor, duration_ms, media_status, seams[] }`

**Wiki**

- `WikiPage { id, show_id, kind: person|topic|bit|session, title, body_md, aliases, session_id, revision, merged_into, deleted, created_at_utc, created_by_name, updated_at_utc, updated_by_name }`. List items are a subset, and the list response has `truncated`.
- Revisions: `{revision, title, kind, author_name, at_utc, note}` (+ `body_md, aliases`), paged by `next_before`.
- Merge and split bodies carry expected revisions.
- LEFTOVER/AI: `WikiSuggestion { status, page_id, base_revision, kind, title, aliases, rationale, page, stale, created_*, resolved_* }`

**Search**

- `{ q, studios[{id,name}], shows[{id,name,studio_id}], sessions[{id,title,episode,show_id,studio_id,started_at_utc,archived,match,snippet}], moments[{kind: transcript|topic|event, session_id, session_title, show_id, id, speaker, snippet, sec}], moment_sessions[{session_id,total}] }`

**Settings-area entities**

- `CompanionDevice { id, name, created_at, last_used_at, expired }`. Create returns a one-time `token`.
- `ConnectedApp { grant_id, client_name, redirect_host, scope, created_at, last_used_at }` (OAuth/MCP clients; useful for the "Agents" concept).
- `CustomDashboardListItem { id, title, scope, revision, updated_at, updated_by_name }`. The list also returns `runtime_origin`; code is `{compiled_js, compiler_version}`.
- LEFTOVER/AI: Providers (llm/stt credentials), all `Autogenerate*` and `EventsGenerate*` types.

**Old endpoints** (for orientation):

- Core: `profile`, `sessions`, `sessions/:id`.
- Session sub-paths (`sessions/:id/...`): `status`, `archive`, `restore`, `events`, `topics`, `transcript-words`, `show-categories`, `transport/start|stop`, `audio/segments`, `audio-recording-lease`, `youtube-import`, `custom-dashboards/query`.
- Shows: `shows`, `shows/:id/wiki/pages`.
- Wiki: `wiki/pages/:id` (+ `merge`, `split`, `restore`, `revisions`).
- Settings: `teams`, `companion-devices`, `oauth/connected-apps`.
- AI endpoints to drop: `*/generate` (events, topics, transcript-words, wiki), `wiki/suggestions/*`, `me/providers/*`.

**Fixtures** (`fixtures/api-responses/`, 86 files; `_mutable.ts` is a helper):

| Group              | Files                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile            | profileAuthenticated, profileLoggedOutOauth                                                                                                                           |
| Sessions           | sessionsList, sessionsListNoAccess, sessionDetail, sessionStatus, sessionCreate, sessionUpdate                                                                        |
| Events             | eventsList, eventCreate, eventUpdate, eventUpdateConflict, eventDeleteConflict                                                                                        |
| Topics             | topicsList, topicCreate, topicUpdate, topicUpdateConflict, topicDeleteConflict                                                                                        |
| Transcript         | transcriptWordsList, transcriptWordCreate, transcriptWordUpdate, transcriptWordUpdateConflict, transcriptWordDeleteConflict, transcriptGenerationStatusIdle           |
| Transport          | transportStart, transportStop                                                                                                                                         |
| Shows              | showCategories, showCreate, showDetail, showsList, showGrantPut                                                                                                       |
| Teams              | teamCreate, teamDetailOwner, teamDetailAdmin, teamDetailMember, teamRename, teamRoleChange, teamOwnerTransfer                                                         |
| Devices & apps     | companionDevicesList, companionDeviceCreate, connectedAppsList                                                                                                        |
| Dashboards         | customDashboardsList, customDashboardCode                                                                                                                             |
| Search             | search                                                                                                                                                                |
| Wiki               | wikiPage, wikiPageList, wikiPageCreate, wikiPageUpdate, wikiPageUpdateConflict, wikiPageDelete, wikiPageRestore, wikiRevisionList, wikiRevision, wikiMerge, wikiSplit |
| Audio              | audioSegmentsList, audioSegmentCreate, audioUploadCreate, audioUploadStatus, audioUploadComplete, audioRecordingFinalize                                              |
| Imports            | logImportJobCreate, logImportJobStatus, youtubePlaylistEntries                                                                                                        |
| LEFTOVER/AI        | autogenerate* (7), providersList, providerSave, providerTest, transcriptGenerationStatusBusy, wikiSuggestion* (8)                                                     |
| Retired admin page | adminUsers.json                                                                                                                                                       |

---

## 9. Session workspace & live logging

Paths are relative to `pages/index/components/`.

### 9.1 Mount chain and route states

- **`SessionRoute.tsx`** resolves `/sessions/:id` via `useSession(id)` → `{kind:'found'|'not-found', session}`.
  - **No id:** `HomeRoute`.
  - **Loading:** `RouteLoadingState` ("Loading session").
  - **Error:** `RouteState frame="route" role=alert`.
    - Title "Couldn't load session"; body "Something went wrong loading this session. Check your connection and try again."
    - Primary "Try again" ("Retrying…", `h-11 w-full`) and outline "Back to sessions".
  - **Not found:** "Session not found" / "There's no session at this link. It may have been removed, or the link may be wrong." + "Back to sessions".
  - **Archived interstitial:**
    - Badge "Archived session", title = session title.
    - Body: "This session is archived. Restore it to open the workspace."
    - Buttons "Restore session" ("Restoring…", failure → toast) and "Back to sessions".
  - **Found:** lazy `WorkspaceStatic`, a memo passthrough used only for the chunk split; not needed in the rebuild. It renders `SessionWorkspace`.

### 9.2 `SessionWorkspace.tsx` (layout root)

**Outer structure:**

- `section#v3-session-active.relative flex min-h-0 w-full flex-1 flex-col [isolation:isolate]`, min-height `calc(100dvh - var(--topbar-h) - 2.2rem)` on desktop; block flow below `md`.
- `section#v4-log-session.flex flex-col gap-5` stacks:
  1. **Transport card** `MaximizeLogStrip` (always mounted).
  2. **Feed tabs:** `Tabs` with `TabsList variant="line"`.
     - Tab row: `mx-4 mb-3 pt-[0.3rem] flex items-end` (phones `mx-3`, horizontal scroll, no scrollbar).
     - Right side of the row: ghost wiki buttons (9.13).

**Tabs (id → label, in order):**

| #   | id           | Label      | Notes                                                                                                                                       |
| --- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `events`     | Event Feed | default                                                                                                                                     |
| 2   | `transcript` | Transcript |                                                                                                                                             |
| 3   | `topics`     | Topics     |                                                                                                                                             |
| 4   | `dashboards` | Dashboards | Only when the custom-dashboards list loads or fails with a non-404 (404 = feature off). If it disappears while selected → back to `events`. |
| 5   | `export`     | Export     |                                                                                                                                             |

- **No Assistant tab exists today.** A code comment says the "Assistant chat and AI v2 editor are gone". **Add the new "Agents" activity tab to this row** (`FEED_TABS`).
- Panels stay mounted (`keepMounted` + `hidden`).
- Transcript words are fetched lazily, once Transcript, Topics or Export is first opened (`TranscriptWordsGateProvider`, OLD-INTERNAL).

**Transport state:**

- Precedence: `recording` (`status.audio_recording_lease_alive`) > `rolling` (`status.is_rolling`) > `playback` (local `isPlaying`) > `stopped`.
- Published to the shell for the tint and the top-bar pill, together with sessionId and title.
- `liveDock`: when rolling or recording, the timeline lane in the card is **replaced by the category button strip**.

**Keyboard:** `?` opens ShortcutsDialog (ignored in inputs and when an overlay is open).

**Other behavior:**

- **Marker click → feed reveal:** switches to Event Feed, scrolls to the row, and flashes it (`animate-event-row-flash`: 22% accent fill, held 1.25s, faded 1.25s).
- **Headless children:** `AudioRecorder`, `AudioPlayer`, `AudioSaveOverlay`, `ChunkRescueBanner`, `MomentDeepLink`, `ShortcutsDialog`.
- **Orphan-recording recovery:** `ConfirmDialog` with "Add synthetic stop" / "Cancel".
- **Companion (Stream Deck) remote commands** over the session websocket: `record-start`, `record-stop`, `record-toggle`, `play-toggle`.
  - Toasts: "Companion: play/pause", "Companion: record start", "Companion: record stop", each with " failed" appended on failure.
  - Error replies: "No audio segments.", "Another client holds the recording lease.", "Recorder unavailable."
- **OLD-INTERNAL (reproduce effects only):**
  - `coordination/registry` (`seekAudio`, `seekAudioAndPlay`, `stopTransportIfNeeded`) and the `transportStatus` store.
  - `useSessionSocket`: websocket that invalidates queries and relays companion commands, ~25s ping.
  - `useCompanionPresence`, `useRemoteRecordingGate`, `useRecoveryStopWarning`, `playbackSecStore`.
  - `document.body.dataset.v4Transport`; body CustomEvents `REVEAL_EVENT` and `TIMELINE_SEC_EVENT`.

### 9.3 `ShortcutsDialog.tsx`

`shared/ui/Dialog` with title "Keyboard shortcuts" and description "Shortcuts stay out of the way while you type in any field." Rows, verbatim:

| Keys    | Description                                                             |
| ------- | ----------------------------------------------------------------------- |
| `1–9`   | Log the 1st–9th category button (while the live log is shown)           |
| `Space` | Play / pause recorded audio                                             |
| `←` `→` | Scrub the timeline 1s when the playhead is focused (hold Shift for 10s) |
| `+` `−` | Zoom the timeline in / out                                              |
| `Esc`   | Close dialogs, cancel batch edit, close the drawer                      |
| `?`     | Open this shortcut reference                                            |

- **Layout:** rows `flex justify-between gap-4`, descriptions 0.85rem; key caps mono `min-w-[1.7rem] rounded-[0.4rem] border px-[0.4rem] text-[0.72rem] font-semibold`.
- **Guard:** `isTypingTarget(el)` (INPUT/TEXTAREA/SELECT/contentEditable) is exported and used by every single-key handler, together with `isOverlayOpen`.
- **Other keys** (defined elsewhere, not in the dialog):

  | Key                                                           | Action         | Where                  |
  | ------------------------------------------------------------- | -------------- | ---------------------- |
  | `[`                                                           | toggle sidebar | AppShell               |
  | Ctrl/⌘+B                                                      | toggle sidebar | sidebar primitive      |
  | Ctrl/⌘+K                                                      | search palette | SearchPalette          |
  | `Equal` / `NumpadAdd`, `Minus` / `NumpadSubtract` (`ev.code`) | zoom           | `hooks/useZoomRail.ts` |
  | Mouse wheel over the timeline                                 | zoom           | `hooks/useZoomRail.ts` |
  | Enter / Escape                                                | apply / revert | timeline zoom % input  |

### 9.4 `MaximizeLogStrip.tsx` (transport card, signature surface)

**Card:**

- `section#v5-maximize-log-strip rounded-card border border-si-line bg-si-panel`.
- Phone `mx-3 mt-3 mb-5 p-3`; md `mx-4 mb-0 px-3.5 py-3`.
- Ignites via CSS (section 1.4).

**Composition:** `<Timeline stripOnly stripTrailing={aside} stripLaneSlot={liveDock ? categoryButtons : undefined}/>`.

- Desktop row: aside left `md:w-[min(100%,19.25rem)]`, lane right `flex-1 md:items-end gap-2.5`.
- Phones stack the two.

**Aside, top to bottom:**

1. **Meta line `#session-deck-title`:**
   - `font-ui text-[0.8125rem]`: `ShowName` (semibold, truncate) `·` (`text-si-dim`) `SessionTitle` (`text-si-muted`).
   - Fallbacks: show_name → show_code → title → "—".
   - Tooltip shows "Date MM/DD/YYYY" (UTC, from `session_created_at_utc`).
   - **Status badge (right):** `Badge variant="transport"` with STOPPED/ROLLING/REC/PLAY; while recording it carries a `size-1.5` `data-slot=live-dot`.
     - During a YouTube import it is replaced by an outline badge "Importing YouTube Audio" with an orange pulse (`animate-yt-import-pulse`).
   - **Recording meters** (only with `body.v4-is-recording`, i.e. this client records):
     - Mic level bar `h-2 w-12 rounded-[3px] border bg-si-bg` filled `bg-si-accent` by width.
     - Duration `00:00:00` in `font-tc text-[0.75rem] tabular-nums`.
2. **`TimecodeDisplay compact`.**
3. **Toolbar** `flex flex-wrap md:flex-nowrap gap-1.5`:
   - TransportControls (4) + MarkerNav (2).
   - Keyboard button (lucide `KeyboardIcon`, tooltip "Keyboard shortcuts (?)", hidden below md).
   - On desktop the buttons `flex-1` to share the width.

**Locked (YouTube import pending):** controls disabled, timecode at 50% opacity, lane `opacity-[0.48] pointer-events-none`.

### 9.5 `TransportControls.tsx`

- Four `Button variant="transport" size="icon"` (36px), ids `btn-ctl-1..4`.
  - Pressed: `data-active` → `--tx-pill-bg/fg` + `0 0 18px -6px var(--tx-glow)`.
- **Glyphs are custom inline SVGs, not lucide:** play triangle, pause bars, record (dot + 45%-opacity ring), mic, stop (rounded square); 18px compact / 22px otherwise.
  - The idle Roll glyph is red (`--si-rec` #ff6464).
- Tooltip = aria-label.

| State           | Btn 1                                | Btn 2                                     | Btn 3                               | Btn 4                           |
| --------------- | ------------------------------------ | ----------------------------------------- | ----------------------------------- | ------------------------------- |
| stop            | Play (enabled) "Play or pause audio" | Roll (enabled, red glyph) "Roll timecode" | Mic (disabled) "Record audio"       | Stop (disabled) "Stop timecode" |
| play            | Pause (active) "Pause audio"         | Roll (disabled)                           | Mic (disabled)                      | Stop (disabled)                 |
| rolling         | Play (disabled)                      | Roll (active) "Timecode rolling"          | Mic (enabled) "Record audio"        | Stop (enabled)                  |
| audio-recording | Play (disabled)                      | Roll (active)                             | Mic (active) "Stop recording audio" | Stop (enabled)                  |

- **Locks:**
  - Remote: another client holds the recording lease (`audio_recording_lease_holder_id` ≠ this client) → all disabled.
  - Recovery: Mic disabled with reason "Recovering unsent audio…".
  - Phones (compact): disabled buttons are hidden.
- **Actions:**

  | Button | Does                                                 |
  | ------ | ---------------------------------------------------- |
  | Roll   | `POST transport/start`                               |
  | Stop   | stop recording if active, then `POST transport/stop` |
  | Play   | toggle audio player                                  |
  | Mic    | toggle recorder                                      |

  Roll and Stop refresh events afterwards; a `busy` flag disables buttons while a request is in flight.

### 9.6 `TimecodeDisplay.tsx`

- **Glyphs:** mic glyph (red recording / fg rolling / dim), then record/stop glyph (red dot live / dim stop square).
- **Timecode:** `status.timecode` (default `00:00:00`), `font-tc font-semibold tracking-[-0.01em] tabular-nums`.
  - Size: compact `text-[1.625rem]` (phones 1.5rem); hero `text-[2.125rem]`.
  - Colour: fg live / muted stopped. `#session-tc-display` gets lifted accent + glow while rolling (CSS).

### 9.7 `MarkerNav.tsx`

- Two transport icon buttons, "Previous marker" / "Next marker", with custom double-chevron SVGs (18px).
- Each has a `size-1.5` dot (left/right) in the neighbouring marker's category colour.
- Disabled when there are no markers, while live, or while locked.
- Jumps to that marker's second. Grouping: `utils/markerGrouping.ts`.

### 9.8 `CategoryButtonStrip.tsx` (log buttons)

**Placement and look:**

- Lives in the timeline lane `#cat-strip-live-slot` (min-height `--v4-cat-btn-h` 6.665rem), only while live.
- Strip: `flex flex-wrap gap-1.5 cat-strip-scrollbar`.
- Button: `Button variant="log"` + `min-h-(--h-ctl) gap-2 whitespace-normal py-1.5 pr-3 pl-2 text-left`, inline `--cat: <color>`.
  - Contents: `Kbd` 1–9 (first nine only, only while rolling), swatch `size-2 rounded-[2px] bg-(--cat)`, label (wraps).
  - Hover edge 55% cat; latched/pressed = full cat edge + 22% tint + 1px nudge. `data-latched=on|off` for ON_OFF.

**Per `category.type`:**

- **BUTTON:** logs `{category: id, message: label}` immediately; toast "Logged.".
- **ON_OFF:** logs `on_label`/`off_label` (fallback `label`) for the current phase, then flips. The phase is client-only (`onOffState` map) and the label follows it.
- **DROPDOWN:** captures `marked_at_utc=now` → Dialog "Choose option" (full-width outline button per option).
  - An option with `needs_context` → "Add context": Input "Context" (max 4000), Back / Log.
  - Message: `"<option> || <context>"`.
- **TEXT:** captures `marked_at_utc` → Dialog "Log note".
  - Lead: "Add a note for “Label”. Press Enter or Log."
  - Input "Note" (max 8000); Cancel / Log (disabled while empty).
- Errors → toast.

**Hotkeys:** 1–9 trigger the n-th category while rolling. Ignored on key repeat, with modifiers, in typing targets, or with an overlay open.

**Data:** `id, label, color, type, dropdown_options[{label,needs_context}], on_label, off_label`. Source: `useShowCategories(sessionId)` → `{categories}`.

### 9.9 `Timeline.tsx` + `timeline/*` (scrub lane when not live)

**Lane stack, top to bottom:**

1. **Current-marker chip** (1.7rem, `rounded-t-[6px]`):
   - Background: cat colour 14% into panel-2; left bar 0.25rem in cat colour.
   - Contents: category in label type (Barlow Condensed 0.6875rem uppercase 0.12em), dim separator, message.
   - Long messages marquee (`animate-marker-msg-marquee`, reduced-motion off).
   - Opacity 1 on a marker, 0.52 otherwise.
2. **Track `#timeline-track`:**
   - `role=slider`, "Timeline scrubber". Pointer drag scrubs; double-click clears the manual scrub; ←/→ 1s, Shift 10s.
   - **`TimelineClips`:** thin strip per audio clip at the bottom, legacy blue 40%, active clip brighter. Red strip for missing audio, titled "No audio file for this log interval".
   - **`TimelineWaveform`:** SVG path of merged peaks.
     - Unplayed `--si-wave-body`; played clipped to progress in `--tx-wave-progress`.
     - Overlays "Finalizing recording…" / "Generating waveform…" (2rem uppercase, pulsing) and "Waveform unavailable".
   - **Hover playhead:** faint line + `HH:MM:SS` tooltip.
   - **`TimelineMarkers`:** 0.62rem dot per event in cat colour.
     - Hover: multi-ring glow + tooltip (category + message). Selected: scale 1.18, strong glow.
     - Click selects and reveals the row in the feed.
     - `data-cat`; Internal markers hidden via `body[data-hide-internal='1']`.
   - **Playhead:** 2px rounded, `--tx-playhead` with `--tx-playhead-glow`.
3. **`TimelineTicks`:** `font-tc text-[0.6875rem] text-si-dim tabular-nums`, justify-between on the track's bottom border.
4. **Zoom rail** (toolbar "Timeline zoom"):
   - Editable zoom % input ("Timeline zoom percent").
   - Pill range `rounded-full bg-si-panel-2 border` with accent bar and two round handles `bg-si-fg border-2 border-si-accent` ("Reduce/Increase timeline zoom").
   - Readout `HH:MM:SS` (`font-tc 0.8125rem semibold`) `/ HH:MM:SS` (0.6875rem dim).

**Playhead source:** audio playback when playing, else manual scrub, else status timecode. Seeking calls the audio player. Horizontal scrollbar hidden (`timeline-hide-scrollbar`).

**OLD-INTERNAL:** `hooks/useZoomRail.ts` (863 lines, imperative DOM), `useWaveforms`, `waveformMerge`, `waveformDecode` — rewrite declaratively.

**Data:**

- Audio segments `{id, ordinal, recording_ordinal, started_at_utc, ended_at_utc, url, mime_type, waveform_peaks[], waveform_db_floor, duration_ms, media_status, seams[]}`.
- Events.
- Status `timecode`, `frame_rate`.

### 9.10 Feed chrome: `FeedShell.tsx`, `FeedTable.tsx`, `JumpToTimeButton.tsx`, `feedToolbarCaption.tsx`

**FeedShell card:**

- `bg-si-panel border rounded-card mx-4` (phones `mx-3`), `px-6 pt-3 pb-6` (phones `px-3 pb-3`).
- Header: left `h2` count label ("12 events", "2000+ events"; Barlow 1.25rem semibold tabular, `role=status`); right toolbar `flex flex-wrap gap-2`.
- `feedCountLabel(n, noun, {capped})` pluralises and adds "+".

**Toolbar buttons:**

- `Button variant="glass" | "glass-primary"` with `FeedToolbarCaption`: label on desktop with icon hidden; icon-only on phones (label sr-only).
- lucide 18px icons: `Sparkles`, `Plus`, `Pencil`, `Check`, `X`, `Clock`, `Filter`, `Download`.

**FeedTable:**

- Virtualised (`@tanstack/react-virtual`, ~31px rows, overscan 10) in a scroll area.
- Headers: label type, dim, sticky; sort buttons with accent ↑/↓ suffix and `aria-sort`.
- States (full-width cell): "Loading…"; empty-message box `px-4 py-[1.35rem] text-center text-[0.85rem] muted border rounded-card bg-black/22`.
- Cell face `FEED_CELL`: `px-[0.4rem] py-[0.1rem] text-[0.78rem]`, bottom border white 4%. Timecode cells `font-tc` tabular. Inline inputs flat, borderless, transparent.

**JumpToTimeButton:**

- Leading column in every feed (header sr-only "Jump to time", `w-8`).
- 24px ghost square `h-6 w-6 rounded-[0.35rem]` with lucide `Play` (`size-3`, filled); hover = selected tint + accent text.
- Hidden when no time resolves.
- `aria-disabled` (45%) while rolling, while status loads, or in batch edit (sr-only reason).
- Seeks and plays.

### 9.11 Event Feed: `EventLogSheet.tsx` + `EventLogRow.tsx`

**Columns:**

| Column          | Content                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Jump            | —                                                                                                                   |
| Time (w 6.5rem) | "Session Time" (`HH:MM:SS` from timecode) or "World Clock" (`YY-MM-DD HH:MM:SS` UTC)                                |
| Event (w-32)    | category label, semibold, nowrap, coloured with the category colour (legacy exception to the category-channel rule) |
| Message         | max `min(28rem,38vw)`; `--color-text`, or the category colour for internal rows                                     |

- Phones: Event folds under the time (0.68rem semibold, cat colour).
- Default sort: timecode ascending; all columns sortable.

**Toolbar (left → right):**

1. **[LEFTOVER/AI] "Auto generate" dropdown** (Sparkles): "Generate All" / "Regenerate All", "Custom" (→ `EventGenerateCustomModal`).
   - Disabled reasons: "Add a language model in Settings → Advanced to generate events. Manual logging still works." / "No event buttons carry auto-generate instructions yet…".
   - Regenerate confirm "Regenerate all auto events" / "Delete and regenerate".
   - `GenerateToolbar` shows the error or the outcome ("Created N events — per-run cap reached.") at 0.78rem.
   - **Remove.**
2. **"Edit"** (Pencil), batch edit.
   - Enabled only when stopped and not recording; title "Available when timecode is stopped and audio is not recording."
   - In batch mode: "Save changes" (glass-primary, Check) + "Cancel" (X).
   - Cancel when dirty: "Discard changes" / "Discard all unsaved changes to the log sheet?" / "Discard changes" / "Keep editing".
   - Save toast "Changes saved." or "Changes saved, N kept theirs." (version conflicts).
3. **"Time display"** (Clock): radio "Session Time" / "World Clock".
4. **"Filter"** (Filter): checkbox per category label + "Internal" (also hides internal timeline markers).

**Editing:**

- While rolling, inline edit is on for non-automatic rows, saved on blur:
  - Time cell stacks a UTC input (placeholder `YY-MM-DD HH:MM:SS`) and a Timecode input.
  - Category `Select`; message input.
  - Edit cells white 4% bg; inputs `bg-[#161825]` with a 1px focus outline.
- While stopped, the same controls appear under batch edit.
- Automatic rows are never editable: messages `Recording N Started|Stopped`, `Log Audio Recording Started|Stopped`, `Take N Session Started|Ended`.

**Row delete:**

- Hover/focus 24px trash button (lucide `Trash2` `size-3`, red-tinted hover), "Delete row".
- Single delete confirms: "Delete log row" / "Delete this log row? This cannot be undone."
- Batch: pending-delete row red `bg-[#8d4545]`, struck through, outline xs "UNDELETE" ("Restore row").

**"auto" chip [LEFTOVER/AI]:** tiny mono uppercase badge on `metadata.auto_generated === true`. Keep the idea; relabel for agent-created events.

**Conflicts:** optimistic `version`; a 409 opens a theirs-vs-yours dialog (Category, Message, Timecode, UTC) via `useVersionedSave` / `conflictPromptCopy`.

**Empty / toasts:**

- Empty: "— No logged items yet."; filtered: "No events logged."; no-LLM variant mentioning Settings → Advanced is [LEFTOVER/AI].
- Toasts: "Stop timecode and recording to use batch edit.", "Update failed.", "Delete failed.", "Save failed."

**Data:**

- `LogEvent {event_id, category(id), category_label, category_color, message, timecode (SMPTE|null), timecode_total_frames, frame_rate, wall_time_utc, metadata{auto_generated?}, version}`.
- List limit 2000 → `{events,total,logged_event_count,offset,limit,has_auto_generated}`.
- Create body `{category, message, metadata?, marked_at_utc?}`.

**OLD-INTERNAL:** `draftStore`, `seedStore`, `rowHolds`, `useRowEdit`, `useClearOnLanguageModelSave`, `useGatedGenerate`.

### 9.12 Transcript, Topics, Dashboards, Export tabs

**Transcript (`TranscribeFeed.tsx`, `TranscribeRow.tsx`):**

- Count "N words".
- Columns: Jump | "Session Time" (w-6.5rem, inline timecode input) | "Speaker" (w-32, inline "Person N") | "Word(s)" (inline input, ellipsis, title = full word).
  - Speaker number is offset so the lowest speaker is Person 1 (`utils/speakerOffset.ts`).
- Always inline-editable, saved on blur, version-conflict dialog; toast "Saving the word failed."
- Toolbar:
  - [LEFTOVER/AI] "Auto generate" (Deepgram) + `TranscriptGenerationLockBanner` ("Transcribing “<title>”… mm:ss", linking to the other session when it is elsewhere).
  - "Insert" (Plus) — keep.
- Empty states are AI-flavoured ("Generating transcript…", Deepgram-key explainer, "No transcript yet. Click Auto generate to transcribe audio.") — replace with neutral copy.
- Data: `TranscriptWord {id, session_time, speaker, word, start_sec, end_sec, ordinal, version}`.

**Topics (`TopicsFeed.tsx`, `TopicsRow.tsx`):**

- Count "N topics".
- Columns: Jump | "Session Time" | "Duration (s)" (w-24 numeric) | "Level" (w-16 numeric) | "Summary" (min-w-56, auto-growing textarea).
  - Phones fold Duration/Level under the time: "Duration 30s · Level 1".
- Inline save on blur with versioning; toast "Saving the topic failed."
- Toolbar: [LEFTOVER/AI] "Auto generate"; "Insert".
- Empty copy is AI-flavoured ("No topics yet. Generate a transcript first, then click Auto generate.") — replace with "agents produce topics" copy.
- Data: `SessionTopic {id, session_time, duration_sec, topic_level, summary, ordinal, created_at_utc, version}`.

**Dashboards (`customDashboards/*`):**

- **`CustomDashboardsSection`:** `section mx-4 mb-3 flex flex-col gap-2 max-h-[70%] overflow-y-auto`, heading "Custom dashboards" (0.85rem semibold).
  - Error: destructive Alert `TriangleAlertIcon` "Could not load the custom dashboards."
  - Empty: "No custom dashboards for this session yet. Owners and admins make them through Claude." (already agent-model friendly).
  - List: `ItemGroup` of `Item size="sm"`: title + outline Badge "Custom" (+ "Template" when `scope==='template'`), "Updated <date> by <name>", outline sm "Open"/"Reopen".
- **`CustomDashboardViewer`:** `rounded-card border p-3` above the list.
  - Header: h3 0.9rem semibold, badges, ghost close (lucide `XIcon`).
  - Status: "Loading the dashboard…" plus stop texts ("This dashboard tried to reload itself and was stopped", "…stopped responding", "…asked for too much data", "Too many data requests; try again in N s").
  - Body: sandboxed iframe (`sandbox="allow-scripts"`) at `<runtime_origin>/runtime/v1/frame.html`, MessagePort protocol, 2s ping, 6s watchdog.
  - `runtimeHost.ts` (600 lines) hand-mirrors `packages/contract` + `packages/dashboard-runtime` — import those packages directly in the rebuild.
- Data: list `{dashboards[{id,title,scope,revision,updated_at,updated_by_name}], runtime_origin}`; code `{id,title,revision,compiled_js,compiler_version}`; 404 = feature off.

**Export (`ExportFeed.tsx`):**

- FeedShell, label "Export", no toolbar; line "Download a CSV for each feed individually."
- `max-w-md flex-col gap-2` stack of primary buttons with Download icon:

  | Button                     | Source                                                   |
  | -------------------------- | -------------------------------------------------------- |
  | "Event feed CSV"           | link `sessions/{id}/export.csv`                          |
  | "Transcript CSV (N)"       | client-built: Session Time, Speaker, Word(s)             |
  | "Topics CSV (N)"           | client-built: Session Time, Duration (s), Level, Summary |
  | outline "Event feed JSONL" | link `export.jsonl`                                      |

- Transcript/Topics buttons disabled while loading or empty.

### 9.13 Wiki buttons in the tab row

- **`wiki/UpdateWikiButton.tsx` [LEFTOVER/AI — remove]:**
  - Ghost sm "Update wiki" + `SparklesIcon` (busy: Spinner "Updating wiki…"), `ml-auto`, muted.
  - Toasts "No suggestions this time"; on 503 "Add a language model in Settings → Advanced…".
- **`wiki/SessionWikiButton.tsx` (keep):**
  - Ghost sm "Wiki page" + `BookOpenIcon`, `text-si-muted hover:text-si-fg`.
  - Finds or creates the session's `kind:'session'` page (POST `{kind:'session', title, session_id}`) and navigates to `/wiki/:pageId`.
  - Disabled without a show id; toast "Could not open the wiki page."
  - Give it `ml-auto` once UpdateWikiButton is gone.

### 9.14 Audio

**`AudioRecorder.tsx` (1102 lines, headless; handle `toggle()`, `isRecording()`, `isUploading()`):**

- Phases: scanning → idle → claiming → recording → stopping → uploading (+ drain_blocked).
- Start: claim the recording lease (`client_id`) → `getUserMedia` → chunked `MediaRecorder` with periodic rollover → each chunk persisted locally and multipart-uploaded.
- **Visible effects:**
  - Sets `body.v4-is-recording` (reveals the strip's mic meter and duration) and writes the mic level and `HH:MM:SS` recording duration.
  - Toasts: "Another window, tab, or user now holds the recording lease.", "Checking this browser for unsent recordings; try again in a moment.", "Could not claim recording lease.", "Microphone access denied."
  - **`HiddenTabWarning.tsx`:** fixed bottom-centred Alert (`w-[min(640px,94vw)]`, toast z):
    - "Microphone changed; recording continues."
    - "Recording continued in the background for X (hh:mm–hh:mm). Browsers may throttle a hidden tab; keep this tab visible while recording." (separate mobile-Safari wording)
  - beforeunload guard while recording or uploading.
- **OLD-INTERNAL, do not copy:** `utils/chunkUploadQueue.ts` (1335 lines), `utils/chunkStore/*` (OPFS/IndexedDB/memory + worker), `recorderLocks` (Web Locks), `micReacquire`, `wakeLock`, `workerInterval`, `uploadBackoff`, `chunkLeaveWarning`. The rebuild needs equivalent recovery semantics, but the design is free.

**`AudioPlayer.tsx`:**

- `<audio>` over the session's segments mapped to timeline seconds; handle `toggle()`, `seekToTimelineSec()`, `seekToTimelineSecAndPlay()`.
- **Space** toggles play/pause (not in typing targets, not with modifiers, not with an overlay open, not when a focused button would handle the key).
- Reports `isPlaying` (→ PLAY state) and the playback second (→ playhead).

**`AudioSaveOverlay.tsx`:**

- While the last chunk uploads: fixed full-screen `bg-[rgba(8,10,14,0.88)]` with the looping logo video (`w-[min(220px,55vw)]`) and "Saving Audio...".
- Persistent toast "Saving Audio..."; fades out over 0.35s.

**`ChunkRescueBanner.tsx`:**

- Fixed top-centred Alert for failed or crash-recovered audio chunks.
- Header actions: "Retry all", destructive "Discard all".
- Per chunk (`rounded-ctl border px-3 py-2`): name, red status label ("Failed permanently", "Signed out", …), detail; Download / Retry / Discard.
- Recovered audio: Download / Discard ("Discard the recovered recording audio?"). All discards confirm.

### 9.15 `MomentDeepLink.tsx`

- Renders nothing.
- Reads `?t=<sec>`, `?topic=<id>`, `?event=<id>` once status and timeline are ready (never while rolling).
- Seeks, or reveals the event row, then strips the params with a history replace. Search results link here.

---

## 10. Settings view & modals

Paths are relative to `pages/index/components/`. Design rules: `web/DESIGN.md` § Layout ("Settings is a full overlay view…").

### 10.1 Open / close (AppShell)

- **State:** shell state `settings: {section} | null`, never the URL.
  - Rail "Settings" opens the last visited section, else **Show details** (`DEFAULT_SETTINGS_SECTION='show-details'`).
  - `/teams` opens on **Members**; closing there navigates to `/`.
- **Mounting:** `settings/SettingsView.tsx` is lazy, prefetched 2.5s after boot.
  - Mounts inside `<main>`, so it covers the workspace but not the top bar or rail.
  - Root: `role=dialog aria-modal data-slot="settings-view" absolute inset-0 z-(--z-settings-view) flex flex-col bg-background`; phones `max-md:bottom-auto max-md:min-h-full`.
- **Close paths:** back button ("Back to session" / "Back to sessions"), Escape (ignored while a nested overlay is open), the top-bar status pill.
- **Discard guard** (`settings/settingsGuard.ts`): each section registers `{dirty, discard}`.
  - Closing, switching section, or switching team/show while dirty asks a ConfirmDialog: "Discard changes?" / "You have unsaved changes in {Section A and Section B}. Discard them?" / **Discard** (danger) / **Keep editing**.
  - Pure UI — keep.
- **Keyboard:** `[` still toggles the sidebar; Esc closes; arrow keys move through the vertical tablist.

### 10.2 Layout (`SettingsView.tsx`)

**Structure:** `Tabs orientation="vertical"` (ui/tabs `variant="nav"`), `flex-row` → `max-md:flex-col`.

**Nav column:** `w-[250px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-(--si-line) px-3 pt-4 pb-5`.

- Back: ghost sm button + `ChevronLeftIcon`.
- `<h2>` "Settings": `mx-2 font-ui text-[1.375rem] leading-tight font-semibold`.
- Group heading: scope **name** semibold `text-[0.8125rem]` + scope word muted `text-xs` (e.g. "Morning Desk Show"); the "You" group reads just "You"; later groups `mt-4`.
- Triggers: sentence-case Barlow 0.875rem, muted until hover; selected = `--sel-bg` + inset `--sel-line`.
- Phones: one horizontal scrolling row of bordered chips (`max-md:flex-row gap-1.5 overflow-x-auto`; triggers `max-md:border px-3 py-1.5`), group headings hidden.

**Content column:** `min-w-0 flex-1 overflow-y-auto`.

- Each `TabsContent` is `keepMounted` + `hidden`: `flex max-w-[860px] flex-col gap-[18px] px-8 pt-6 pb-10` (phones `px-4 pt-[18px] pb-7`).
- A section mounts on first visit and stays mounted, so drafts survive switching.

**Building blocks (`settings/settingsParts.tsx`, COPY):**

- **`SettingsSectionHeader`:** `<h3>` `font-ui text-2xl font-semibold leading-tight` + description `text-sm text-muted-foreground`. No eyebrow.
- **`SettingRow`:** horizontal `Field`.
  - Label + description left; control column `sm:w-[260px]` right-aligned (`flex items-center justify-end gap-2`), stacked below `sm`.
  - Rows sit in `Card > CardContent > FieldGroup gap-4` with `FieldSeparator`.
- **`SectionSaveBar`:** `CardFooter sticky bottom-0 border-t border-(--si-line) bg-card pt-4`.
  - Optional destructive Alert (`TriangleAlertIcon`), muted "Unsaved changes".
  - Primary **Save** / **Saving…** (Spinner) / **Saved** (disabled); enabled only when dirty and valid.
- **`RoleLockNotice`:** Alert + `LockIcon`: "You're {the owner|an admin|a member} of {team}. Only owners and admins can change these." Controls disabled via `data-disabled`.
- **`OrphanedNotice`:** "This team has no owner. Contact support."
- **`ShowsNotReady`:** Empty states.
  - Loading: Spinner "Loading shows…".
  - Error: `TriangleAlertIcon` "Couldn't load shows." + **Retry**.
  - Offline: `WifiOffIcon` "You're offline — can't load shows." / "Shows will load on their own once you're back online."
- **`SuffixToggle`:** outline ToggleGroup **Date** / **Episode Number**.
- **`YOU_ARE`:** "You're the owner" / "You're an admin" / "You're a member".

**SidePanel sheets (`settings/SidePanel.tsx`, `useSidePanel.ts`)** — members, shows and event buttons edit here:

- `SheetContent side="right" w-full sm:max-w-[420px] gap-0`.
- Header `flex-row items-center gap-3 pr-12`: optional media (`Avatar size="lg"` or `Kbd`), truncated title, description.
- Body `flex-col gap-4 overflow-y-auto px-4 pb-4`.
- Footer `border-t`: error Alert, **Cancel** (outline) and **Save** (custom label possible) with Spinner.
- Dirty = serialized value differs from the snapshot at open. Closing dirty asks "Discard changes? Your changes to {title} haven't been saved…".
- Save runs ordered `runSaveSteps`; a failure shows "Couldn't {step label}: {detail}" and keeps the sheet open; success closes it.

**Toast:** inline saves toast "Saved."

### 10.3 Section list (`settings/sections.ts`, `settingsScopes.tsx`)

| Group | id                   | Label                  | Gating                                                       |
| ----- | -------------------- | ---------------------- | ------------------------------------------------------------ |
| You   | `account`            | Account                | always                                                       |
| You   | `companion-devices`  | Companion devices      | always                                                       |
| You   | `connected-apps`     | Connected apps         | flag-gated: hidden when `GET /api/oauth/connected-apps` 404s |
| You   | `advanced`           | Advanced               | always — **LEFTOVER/AI, drop** (provider keys)               |
| Team  | `members`            | Members                | editing needs owner/admin                                    |
| Team  | `shows`              | Shows                  | add/edit needs owner/admin                                   |
| Team  | `team-details`       | Team details           | editing needs owner/admin; owner vs non-owner action card    |
| Team  | `batch-autogenerate` | Batch autogenerate     | manager-only — **LEFTOVER/AI, drop**                         |
| Show  | `show-details`       | Show details (default) | editing needs owner/admin                                    |
| Show  | `event-buttons`      | Event buttons          | editing needs owner/admin                                    |

- No nav icons; icons appear only inside sections.
- **Roles** (`settings/teamRules.ts`): `owner | admin | member`; `isManager` = owner or admin.
- **`memberPermissions(viewer, member, selfId)`:**
  - `changeRole`: viewer is owner and the target is neither owner nor self.
  - `remove`: target is not owner and not self, and the viewer is owner or (admin and the target is a member).
  - `grantShows`: viewer is a manager and the target is a member.
- **Rebuild list:**
  - You: Account, Companion devices, Connected apps (consider renaming to "Agents / connected apps").
  - Team: Members, Shows, Team details.
  - Show: Show details, Event buttons.

### 10.4 Sections

**Account (`settings/AccountSection.tsx`)** — "Your profile on this AutoLogger server."

- **Card 1** (inline draft + save bar):
  - **First name** (max 200, autocomplete given-name).
  - **Last name** (placeholder "Not set").
  - **Email** read-only muted: "The account you sign in with."
- **Card 2:** **Sign out** row, "Ends your session on this device."
  - Destructive link to `/auth/logout`, wrapped in the unsent-audio guard (`useChunkSignOutGuard`, OLD-INTERNAL).
- Empty: "You're not signed in."
- Data: `user.{id, given_name, family_name, email}`.

**Show details (`settings/ShowDetailsSection.tsx`)** — "{show} in {team}".

- **States:**
  - No team: "Join or create a team to set up its shows."
  - `ShowsNotReady`.
  - No shows: `TvIcon` "No shows yet"; managers also see "{team} has no shows. Add one in Shows." + **Go to Shows**.
- **Show name** (max 200): "Appears in the sidebar and on every session."
- **Code** (max 40, `font-mono`, auto-uppercase): "Starts the name of every untitled session in this show."
  - When it differs from the name's initials: "Usually the show name's initials (XY). Yours differs, which is fine if intended."
- **Suffix** (SuffixToggle): "How an untitled session's name ends: the date, or an episode number."
- Members see RoleLockNotice and disabled inputs.
- Data: `show.{id, studio_id, name, show_code, title_suffix}`.

**Shows (`settings/ShowsSection.tsx`)** — "{team} · N show(s)".

- **List:** `Card py-2 > CardContent px-2 > ItemGroup` of `Item size="sm"`:
  - name (fallback "Untitled show"), secondary Badge "Current show";
  - "{CODE or 'No code'} · {Date|Episode Number} suffix";
  - **Edit**.
- Empty: `TvIcon` "No shows yet" / "Shows group sessions. Add one to start logging."
- **Add row:** "Shows group sessions. Members only see the shows you let them open." + **Add show** (`PlusIcon`).
- **Show sheet** ("New show" / "Edit show"; description = team; media = Avatar initials or `PlusIcon`):
  - **FieldSet "Show":**
    - Name (placeholder "e.g. Morning Desk"; "Appears in the top bar and on every session.").
    - Code (placeholder initials or "e.g. MD"; when new "Left empty, the name's initials are used.").
    - Suffix.
  - **FieldSet "Who can open it":**
    - Checkbox per member-role user (name + truncated email).
    - "Loading members…"; "No members on this team yet. Owners and admins can always open every show."
    - Footer note "Owners and admins can always open every show."
  - Save label **Add show** / **Save**.
  - Save steps: create/update the show, then each grant change ("give X access" / "remove X's access").

**Team details (`settings/TeamDetailsSection.tsx`):**

- **No team:** Card "Create a team" / "You'll be its owner." + `CreateTeamForm`.
- **Header:** "{team} · You're …"; OrphanedNotice; RoleLockNotice for non-managers.
- **Settings card:**
  - **Team name** ("Shown to everyone on the team.").
  - **Team id** read-only slug ("Set when the team was created. Can't be changed.").
  - **Default frame rate** `FpsSelect` ("New sessions in this team start at this rate."; `studio_settings[id].default_frame_rate`, default 24).
  - Loading: "Loading the team…".
- **Action card** ("Handing over" for the owner, "Leaving" otherwise):
  - **Owner — Transfer ownership:** outline "Transfer…" DropdownMenu (`ChevronDownIcon`) of other members.
    - "Make someone else the owner. You become an admin."
    - Alone: "There's no one else on the team yet. Invite someone from Members first."
    - Confirm: "Make {email} the owner of {team}? You will become an admin."
  - **Owner — Delete team** (destructive):
    - Disabled while shows exist: "{team} still has N shows, and a team with shows can't be deleted."
    - Otherwise "Permanently deletes {team}."; confirm "Delete {team}? This can't be undone."
  - **Non-owners — Leave team:** "You'll lose access to {team}'s shows and sessions."; confirm "Leave {team}? You'll have to be re-invited to rejoin."
- **Extra card "Create a team":** "You'll be its owner. Invite people from Members afterwards."

**Members (`settings/MembersSection.tsx`):**

- No team: "Create a team to invite people to it." + **Go to Team details**.
- Header "{team} · You're …"; RoleLockNotice variant "…Only owners and admins can invite people or change roles and show access."
- **Invite card "Invite someone":**
  - "They join as a member when they first sign in. Choose their shows here afterwards."
  - Email Input ("name@company.com") + **Send invite** (Spinner); errors in a destructive Alert; disabled for non-managers.
- **Members card:** title with count; "Open a member to change their role or show access."
  - Row: Avatar lg (initials or first email letter), name (a button when openable), secondary Badge "You", email, outline role Badge, `ChevronRightIcon text-si-dim`.
  - Access summary: "N of M shows" (members) / "All shows".
  - Pending invites: Avatar "@", email, "Invited. Joins at first sign-in.", Badge "Invited", **Revoke**.
  - Loading "Loading members…"; error "Couldn't load the members." + **Retry**.
- **Member sheet** (title = name; description "{email}" or "{email} · You"; media = Avatar):
  - **Role:** ToggleGroup **Admin / Member** (an owner shows a Badge instead).
    - Owner: "The owner manages roles and can transfer or delete the team."
    - Others: "Admins invite, remove members and grant shows. Members log and review."
  - **Show access:** checkbox per show (members only).
    - Otherwise "{Role}s can open every show in the team."
    - Staged removal: "Removed members lose access to every show."
    - No shows: "{team} has no shows yet."
  - **Membership:** "Remove from team" / "They lose access right away, including any open sessions."
    - **Remove…** (confirm) stages the removal → **Keep on team** + destructive Alert "{name} will be removed from {team} when you save".
    - Save label becomes **Remove member**.

**Event buttons (`settings/EventButtonsSection.tsx`, `settings/eventButtonsModel.ts`, `utils/palette9.ts`)** — "The logging strip for the active show."

_Card "Buttons":_

- **Palette row:** ToggleGroup **Custom / Default / Neon / Desert / Aqua** ("The colours every button in this show picks from.").
- **Colours row:** `grid grid-cols-9 gap-2 md:w-88` of nine native `<input type="color" class="pal-slot">` ("Change one and the palette becomes Custom."); saved via SectionSaveBar.
- **Preset hexes:**

  | Preset  | Hexes                                                                     |
  | ------- | ------------------------------------------------------------------------- |
  | default | `#ff7a7a #ffd98a #e7ff95 #83fff3 #50caff #aa57ff #ff87d9 #e1a8ff #d6dfff` |
  | neon    | `#ff2525 #ff9229 #fff725 #7aff25 #25ffec #2567ff #4c25ff #be25ff #ff25b8` |
  | desert  | `#ebe1bd #fad0ba #f18565 #d34c34 #a53f45 #967d62 #a9bb96 #85cb48 #57b4e4` |
  | aqua    | `#a6d5dd #6fa9c2 #038c95 #3ee6e0 #47f39b #7fcba4 #9cde56 #bdee11 #cfe583` |

- **Button list** (`ItemGroup`):
  - `Kbd` hotkey (1–9, "–" after), name (fallback "Untitled button").
  - Summary: type · "N options" / "ON / OFF" · "Auto-generates" (that last part is LEFTOVER/AI).
  - **Edit**; final row **Add button** (outline, `PlusIcon`).

_Card "Copy from another show":_

- Row "Copy buttons from": local `Select` ("Choose a show…") + **Copy**.
- Confirm: "Replace this show's buttons?" / "{show}'s N buttons and colours will be replaced with a copy of {src}'s …" / **Replace buttons**.
- No other show: "No other shows on this team".

_Button sheet ("New button" / "Edit button"; media = `Kbd`):_

- **Preview:** real `Button variant="log"` with `--cat` (Kbd + `size-2 rounded-[2px] bg-(--cat)` swatch + label), `aria-hidden` div.
- **FieldSet "Button":**
  - **Name** ("Event name"; "Shown on the button and as the event's category.").
  - **Type:** outline sm ToggleGroup, help text per type:

    | Type     | Help text                                                                |
    | -------- | ------------------------------------------------------------------------ |
    | Button   | "Logs one event with the button's name."                                 |
    | Dropdown | "You pick an option when logging. The option becomes the event message." |
    | Text     | "You type a short message when logging."                                 |
    | On / Off | "Toggles between two states and logs each change."                       |

  - **Colour:** `RadioGroup grid-cols-9` of palette swatches; "From this show's {Preset} palette."; off-palette: "Its colour (#hex) isn't in this show's palette. Pick one to change it."
- **Options (Dropdown):** "The chosen option becomes the event message. 'Needs context' asks for a note after it is picked."
  - Per option: Input "Option N", remove (`XIcon`), **Needs context** checkbox, Textarea "Instruction for this option" (LEFTOVER/AI).
  - **Add option**; choosing Dropdown seeds "Option 1", "Option 2".
- **States (On / Off):** **On label** ("Logged when it switches on."), **Off label** ("Logged when it switches off."); defaults ON / OFF.
- **Auto-generate — LEFTOVER/AI:** Instruction textarea (max 2000, "e.g. Log when the host introduces a new segment."); On/Off buttons say they can't auto-generate. Drop, or keep only as agent-readable metadata.
- **Position:** "Key N" / "No key"; "Position X of Y in the logging strip. Only the first nine have a key."; **Move up** / **Move down** (order = hotkey order).
- **Delete:** "Events already logged with it stay in their sessions."; two-click destructive "Delete" → "Click again to delete".
- Each sheet save writes the whole show immediately (`show_updates`).

_Category data:_ `{id, name/label, type: BUTTON|DROPDOWN|TEXT|ON_OFF, color, dropdown_options[{label, needs_context, auto_instruction?}], on_label, off_label, auto_instruction}` + show `event_palette[9], event_palette_preset, event_palette_custom[9]`.

**Companion devices (`settings/CompanionDevicesSection.tsx`)** — "Tokens that let a Stream Deck running the AutoLogger Companion module act as you."

- **Add row:** **Device name** ("Name the Stream Deck, so you can tell its token apart later.", placeholder "Booth A") + **Add device** (Spinner).
- **Pairing flow:**
  1. `POST /api/companion-devices {name}` → `{id, name, created_at, token}` (the only response that carries the token).
  2. TokenDialog "Device token" / "Paste it into the Companion module's Device token field.": read-only Input + **Copy** (`CopyIcon`; toast "Token copied." / "Copy failed. Select the token and copy it instead.").
  3. Warning "Copy this token now. It won't be shown again." + **Done**.
- **Rows:** name, outline Badge "Expired" (90 days unused), "Created {date} · Last used {date|Never}" (`shared/utils/fmtDateOnly`), **Revoke**.
  - Confirm: "Revoke {name}? Its token stops working at once, and the Stream Deck using it needs a new one."
- **States:** "Loading your devices…"; error Alert; empty `KeyRoundIcon` "No devices yet" / "Add one to get a token for the Companion module."
- Data: `CompanionDevice {id, name, created_at, last_used_at|null, expired}`.

**Connected apps (`settings/ConnectedAppsSection.tsx`)** — "Claude connections you approved. Revoking one ends its access to your sessions."

- **Rows:** `client_name`; "{redirect_host} · Connected {date} · Last used {date|Never}"; permission lines from scope:

  | Scope                   | Line                                                       |
  | ----------------------- | ---------------------------------------------------------- |
  | `dashboards`            | "Read every session you can open, and manage dashboards"   |
  | `session-data:write`    | "Edit events, topics and wiki pages"                       |
  | `session-data:generate` | "Start AI runs billed to your own model key" (LEFTOVER/AI) |

  **Revoke**, confirm "Revoke {app}? It loses access at once, and has to be connected again to use your sessions."
- Empty: `PlugIcon` "No connected apps" / "Connect AutoLogger from Claude and it will be listed here."
- Data: `ConnectedApp {grant_id, client_name, redirect_host, scope, created_at, last_used_at|null}`.
- **Rebuild:** central to the MCP-agent model; drop the flag gate and link it from the Agents tab.

**Advanced (`settings/AdvancedSection.tsx`) — LEFTOVER/AI, drop:**

- Line tabs **Language model** / **Speech to text**; provider card with "Connected" / "Not set up" badge.
- Fields: Provider Select (OpenAI-compatible, Anthropic, OpenAI, Google; STT: DeepGram), Base URL, Model, API key (Replace), Test connection (`PlugZapIcon`), Remove, save bar.
- Keep only if per-user STT keys survive.

**Batch autogenerate (`settings/BatchAutogenerateSection.tsx`) — LEFTOVER/AI, drop:**

- Team Select, Shows checkbox group ("All shows"), AutogenerateOptions (Transcripts / Log events / Topics / Wiki; wiki mode radio).
- Estimate preview, **Start**, live job card ("Now: {session} · {step}", **Cancel job**), report, "Recent jobs". Hook `api/hooks/useAutogenerateJobs.ts`.

### 10.5 Team creation / onboarding

- **`CreateTeamForm.tsx`:** wrapping row (`Field w-auto min-w-[10rem] flex-1`).
  - **Team id (slug)** ("my-crew"; "Lowercase, starts with a letter, letters/digits/hyphens only, 2–63 characters…").
  - **Display name** ("My Crew").
  - **Create team** / "Creating…"; error Alert "Could not create team."
- **`OnboardingPanel.tsx`:** replaces the shell when logged in with zero teams.
  - Page: `flex min-h-[100dvh] items-center justify-center px-5 py-10`.
  - Card: `max-w-[32rem] rounded-v5-lg border-v5-border-strong bg-si-panel-2 px-7 py-9 text-center`.
  - Title "Create your first team": `font-league-gothic font-bold text-[2rem] uppercase tracking-[0.02em]`; muted copy `text-[0.9rem] max-w-[24rem]`; then the form.

### 10.6 Modals

All use `shared/ui/Dialog.tsx` (centered `DialogContent` on desktop, bottom-sheet `Drawer` on phones) with `DialogActions` and a 44px `TOUCH_TARGET` floor on phones. Each is lazy-mounted from AppShell behind an open flag.

**New Session (`NewSessionModal.tsx`):**

- **Header:** lucide `Plus` (size-5) + `h2` "NEW SESSION" (`text-[1rem] font-semibold tracking-[0.06em] uppercase`) + close icon. The Dialog title is sr-only.
- Desktop offset for the rail: `md:translate(calc(-50% + 8.125rem), -50%)`.
- **Fields:**
  - **Show:** Select "{name} ({code})"; none → "No shows linked to this team" (disabled).
  - **Episode:** only when `title_suffix==='episode'`; required (toast "Enter an episode.").
  - **Notes (optional):** "Session notes".
- **Disclosure "Import audio from YouTube":** ghost, `ChevronRight` rotates 90°; label gets "— link added" when collapsed with a URL.
  - Input `https://www.youtube.com/watch?v=…`.
  - Checkbox "Use the video's publish date as the session date".
- **Disclosure "Timecode settings — {fps} fps · offset {n}":**
  - Frame rate Select: 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120, Other… (custom 1–120). Default from the team default.
  - Start offset (frames), default 0.
- **Submit:** **Create & open** / "Creating…"; errors toast.
- **On success:** navigate to `/sessions/:id`; with a URL, AppShell starts the YouTube import (failure → toast + error modal).

**YouTube import failed (`YouTubeImportErrorModal.tsx`):**

- Body: "Could not download audio from the YouTube link. What would you like to do?"
- **Try a different link** → Input ("Link to YouTube video") + **Import** (Enter submits).
- **Continue without audio** (outline).
- **Don't create session** → archive + delete ("Deleting…"), go home.

**Batch Import (`BatchImportModal.tsx`, `PlaylistPicker.tsx`, logic in `pages/index/batchImport/*`):**

- **Header:** `Upload` + "BATCH IMPORT"; Show Select.
- **Import Audio** (outline):
  - Hidden `<input type=file multiple webkitdirectory>`; folder name shown below.
  - Files grouped by filename stem into sessions; multi-part groups stitched client-side into WAV (`stitch.ts`, `wavEncode.ts`, cap 150 MB per group).
  - An existing same-named session is matched or skipped.
- **Import YouTube Playlist** (outline):
  - PromptDialog "Import YouTube playlist" / "YouTube playlist link (public or unlisted)" / **Load playlist** ("Loading playlist…").
  - **PlaylistPicker:**
    - Checkbox rows "N. Title" ("Unavailable video") in a `max-h-64` scroll.
    - **Select all** / **Select none**; **From**/**To** + **Apply range**.
    - **Use publish date** (default on); cap note "only the first 5000 videos are shown".
  - Runner per entry: create session → `youtube-import`.
- **Import Logs** (outline): PromptDialog "Import logs" / "Public Google Sheets URL (anyone with the link can view)" / **Use URL**; URL shown truncated.
- **Autogenerate after import:** checkbox + AutogenerateOptions — **LEFTOVER/AI, drop**.
- **Start Import** / "Importing…".
- **Progress:** ProgressBar + completed / skipped / failed lines (`aria-live`); abort supported.

**Other modals:**

- **`EventGenerateCustomModal.tsx` — LEFTOVER/AI, drop:** "Custom event generation", a checkbox per instruction-bearing button/option, Cancel / Generate.
- **`TranscribeModal.tsx` — dead code:** imported only by its test ("Transcribing… this may take a few minutes." → Download CSV). Do not port.
- **`autogenerate/AutogenerateOptions.tsx`, `autogenerateModel.ts` — LEFTOVER/AI, drop:** steps, wiki mode, `BLOCKED_TEXT`, "The work runs on your own provider accounts."

### 10.7 Primitives used here / internals

- **Primitives:**
  - `shared/components/ui`: button, input, textarea, checkbox, radio-group, toggle-group, select, dropdown-menu, field, card (+CardFooter), tabs (nav/line), sheet, item, alert, badge, avatar, empty, spinner, kbd.
  - `shared/ui`: ConfirmDialog (`useConfirm`), PromptDialog (`useTextPrompt`), Dialog / DialogActions.
  - Local: `components/Select.tsx`, `components/FpsSelect.tsx`.
- **OLD-INTERNAL:**
  - `api/hooks/*` (useProfile + mutation, useTeams, useShows, useShowAccess, useCompanionDevices, useConnectedApps, useProviders, useAutogenerateJobs).
  - `settings/settingsModel.ts`: profile-centric save where show edits ride the profile as `show_updates[]` — prefer per-show endpoints.
  - `chunkLeaveWarning` (Account).
- **Copyable visual parts:** SidePanel, settingsParts, the guard pattern.

### 10.8 Settings data the new API needs

- **Profile:** `auth.logged_in`, `auth.user{id,email,given_name,family_name,teams[{id,name,role}]}`, `active_studio_id`, `active_show_id`, `studios[{id,name}]`, `shows[{id,studio_id,name,show_code,title_suffix}]`, team default frame rate.
- **Team:** `{id(slug), display_name, members[TeamMember{id,email,given_name,family_name,role,show_ids?}], invites[{email}]}`.
  - Operations: create, rename, invite, revoke invite, change role, remove member, transfer ownership, delete (blocked while shows exist), leave.
- **Show:** `{id, studio_id, name, show_code, title_suffix, categories[], event_palette[9], event_palette_preset, event_palette_custom[9]}`; create, update, grant `{showId,userId,granted}`.
- **Companion device:** list / create (token returned once) / revoke.
- **Connected app:** list / revoke.
- **Session create:** `{show_id, episode?, notes?, fps, start_offset_frames, youtube_url?, use_publish_date?}`.

---

## 11. Leftovers and AI-in-app pieces (drop or repurpose)

In the rebuild, AI generation is removed from the app: external agents do that work via MCP. The Assistant tab becomes an "Agents" activity tab.

| Piece                                                                             | Files                                                                                                                                                                                                              | Action                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events "Auto generate" dropdown (Generate All / Regenerate All / Custom)          | `EventLogSheet.tsx`, `GenerateToolbar.tsx` (generate half), `EventGenerateCustomModal.tsx`                                                                                                                         | Remove. Keep Edit, Time display and Filter.                                                                                                                                                                                                                                                             |
| Transcript "Auto generate" (Deepgram), lock banner, "Generating transcript…" copy | `TranscribeFeed.tsx`, `TranscriptGenerationLockBanner.tsx`, `api/hooks/useTranscriptGenerationStatus.ts`                                                                                                           | Remove. Keep Insert and inline edit. Rewrite the empty-state copy ("Agents add transcripts…").                                                                                                                                                                                                          |
| Topics "Auto generate"                                                            | `TopicsFeed.tsx`                                                                                                                                                                                                   | Remove. Keep Insert. Rewrite the empty-state copy.                                                                                                                                                                                                                                                      |
| AI gating hooks                                                                   | `hooks/useGatedGenerate.ts`, `hooks/useClearOnLanguageModelSave.tsx`                                                                                                                                               | Remove.                                                                                                                                                                                                                                                                                                 |
| Provider keys (LLM / STT)                                                         | `settings/AdvancedSection.tsx`, `api/hooks/useProviders.ts`, `providers*` fixtures                                                                                                                                 | Remove the section. Keep STT keys only if server-side transcription stays per-user.                                                                                                                                                                                                                     |
| Batch autogenerate                                                                | `settings/BatchAutogenerateSection.tsx`, `autogenerate/*`, `api/hooks/useAutogenerateJobs.ts`, `batchImport/autogenerateAfterImport.ts`, `autogenerate*` fixtures                                                  | Remove.                                                                                                                                                                                                                                                                                                 |
| Per-button `auto_instruction` and per-option instructions                         | `settings/EventButtonsSection.tsx`, `eventButtonsModel.ts`                                                                                                                                                         | Drop from the UI. Optionally keep as an "Agent hint" field if agents should read it via MCP.                                                                                                                                                                                                            |
| Wiki "Update wiki" and the suggestion review flow                                 | `wiki/UpdateWikiButton.tsx`, `wiki/WikiSuggestionSheet.tsx`, Suggestions tab in `WikiRoute.tsx`, the pending-suggestion alert in `WikiPageView.tsx`, `api/hooks/useWikiSuggestions.ts`, `wikiSuggestion*` fixtures | Remove the generate button. If agents should propose rather than write, the suggestion sheet and diff can be repurposed as an "agent proposals" review. Otherwise drop it.                                                                                                                              |
| "auto" chip on events (`metadata.auto_generated`)                                 | `EventLogRow.tsx`                                                                                                                                                                                                  | Repurpose as an "agent" chip showing the authoring agent or client name.                                                                                                                                                                                                                                |
| Connected-app scope `session-data:generate`                                       | `ConnectedAppsSection.tsx`                                                                                                                                                                                         | Drop that permission line.                                                                                                                                                                                                                                                                              |
| Assistant chat tab                                                                | already deleted (a comment in `SessionWorkspace.tsx`)                                                                                                                                                              | Add the new **Agents** tab to the workspace tab row. Use the FeedShell / FeedTable chrome: a count label like "N agent actions", rows with time, agent (connected-app `client_name`), action, target (event/topic/word/wiki page/dashboard) and a jump button. It pairs with Settings › Connected apps. |
| `TranscribeModal.tsx`                                                             | dead (test-only import)                                                                                                                                                                                            | Don't port.                                                                                                                                                                                                                                                                                             |
| `/admin/users` page                                                               | removed 2026-10-06; `fixtures/api-responses/adminUsers.json` remains                                                                                                                                               | Don't port.                                                                                                                                                                                                                                                                                             |
| Legacy theme aliases                                                              | `--v5-*`, `--v4-*`, `--legacy-*`, `.v5-bg-glow`, `ThemeProvider`, `.hidden !important`, `assets/icons/*.png`, `glass` button variant name                                                                          | Optional cleanup. The look is the same with `--si-*` only.                                                                                                                                                                                                                                              |
| Next-specific                                                                     | `app/**/*.page.tsx`, `IndexIsland`, `next.config.ts`, `pageExtensions`, `force-dynamic`, `source('../../..')` in tailwind.css                                                                                      | Replace with Vite `index.html` and `main.tsx`.                                                                                                                                                                                                                                                          |

---

## 12. Rebuild checklist (visual fidelity)

1. **Copy verbatim:**
   - `web/DESIGN.md` and `src/shared/theme/{tailwind.css, shadcn-tailwind.css}`.
   - `src/assets/fonts/*`, `public/static/fonts/*` and `public/static/logo-*.png`.
   - `src/assets/video/AutoLogger_Small.webm`.
   - `src/shared/components/ui/*`, `src/shared/lib/utils.ts`, `src/shared/components/Toast.tsx` and `src/shared/ui/*`.
   - Pure utils: `shared/utils/{timecode, timelineSec, fmtDateOnly, categoryColor, waveformSvg, waveformMerge}.ts`, `pages/index/utils/{palette9, markerGrouping, speakerOffset, topicsCsv, transcriptCsv}.ts`.
   - `settings/settingsParts.tsx` and `settings/SidePanel.tsx`.
2. **Add to `index.html`:** title "AutoLogger", `theme-color #101216`, the favicon and apple icon, and the three font preloads.
3. **Shell:** `SidebarProvider` root with `data-transport`, a 52px TopBar, the V6Rail (272 / 68 / 18rem), `<main>`, and the Settings overlay inside main. The transport store drives `data-transport`.
4. **Keep these DOM hooks,** because the CSS targets them:
   - `[data-slot=topbar]`, `#v6-rail`, `#v5-maximize-log-strip`, `#session-tc-display`, `[data-slot=live-dot]`.
   - `#v4-log-sheet tr.event-row-flash`.
   - `.timelineMarker[data-cat]` with `body[data-hide-internal]`.
   - `body.v4-is-recording` with `#top-bar-recording-dur` and `#top-bar-mic-level`.
   - `body.autologger-audio-saving` with `#autologger-audio-save-overlay`.
   - If you rename any of them, rename the selectors in tailwind.css to match.
5. **Keyboard:**
   - `[`, Ctrl/⌘+B, Ctrl/⌘+K, `?`, 1–9 (while rolling), Space (play/pause), ←/→ with Shift on the playhead, +/− zoom, Esc.
   - Every single-key handler skips typing targets and open overlays.
6. **States to reproduce on every screen:**
   - Loading: the brand video, or `RouteLoadingState`.
   - Error: a `RouteState` card with "Try again".
   - Empty: the copy listed per screen.
   - Denied: RoleLockNotice, a "No access — ask a team admin" row, the wiki "Page not found. It may be in a show you can't open.", and the zero-team onboarding.
   - Locked: YouTube import pending, remote recording lease, and recovering audio.
