// The base-nova primitives added for the shadcn migration render their slots, their Show Ignition
// classes and the semantics their callers rely on.

import { SearchIcon } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card, CardContent } from '@/shared/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleSummary,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/shared/components/ui/input-group';
import { NativeSelect, NativeSelectOption } from '@/shared/components/ui/native-select';
import { Progress } from '@/shared/components/ui/progress';

describe('base-nova primitives', () => {
  it('native-select: a real select in the well, with a decorative chevron', () => {
    const html = renderToStaticMarkup(
      <NativeSelect id="fps" defaultValue="25" aria-invalid>
        <NativeSelectOption value="24">24 fps</NativeSelectOption>
        <NativeSelectOption value="25">25 fps</NativeSelectOption>
      </NativeSelect>,
    );
    expect(html).toMatch(/<div class="[^"]*w-full[^"]*" data-slot="native-select-wrapper"/);
    expect(html).toMatch(/<select[^>]*data-slot="native-select"[^>]*id="fps"/);
    expect(html).toContain('bg-(--si-bg)');
    expect(html).toContain('rounded-ctl');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-slot="native-select-icon"/);
    expect(html).toMatch(/<option[^>]*value="25" selected=""/);
  });

  it('input-group: one well, a bare control and addons on either side', () => {
    const html = renderToStaticMarkup(
      <InputGroup>
        <InputGroupInput type="search" aria-label="Search" />
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search">
            x
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
    expect(html).toMatch(/data-slot="input-group" role="group"/);
    expect(html).toMatch(/<input[^>]*data-slot="input-group-control"/);
    expect(html).toMatch(/<input[^>]*class="[^"]*border-0[^"]*bg-transparent/);
    expect(html).toContain('data-align="inline-start"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Clear search"/);
  });

  it('collapsible: the trigger reports its state and the closed panel stays out', () => {
    const closed = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger>Clips</CollapsibleTrigger>
        <CollapsibleContent>clip list</CollapsibleContent>
      </Collapsible>,
    );
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-slot="collapsible-trigger"/);
    expect(closed).not.toContain('clip list');
    const open = renderToStaticMarkup(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Clips</CollapsibleTrigger>
        <CollapsibleContent>clip list</CollapsibleContent>
      </Collapsible>,
    );
    expect(open).toMatch(/aria-expanded="true"/);
    expect(open).toContain('clip list');
  });

  it('collapsible summary: a button with the native disclosure marker, panel findable', () => {
    const html = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleSummary className="text-si-muted">Clips</CollapsibleSummary>
        <CollapsibleContent hiddenUntilFound>clip list</CollapsibleContent>
      </Collapsible>,
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).toContain('[list-style-type:disclosure-closed]');
    expect(html).toContain('group-data-[panel-open]/summary:[list-style-type:disclosure-open]');
    // Kept in the page while closed (the browser sets `until-found` once mounted).
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*>clip list</);
  });

  it('progress: a progressbar with an accent fill on the hairline track', () => {
    const html = renderToStaticMarkup(<Progress value={40} aria-label="Level" />);
    expect(html).toMatch(/role="progressbar"/);
    expect(html).toMatch(/aria-valuenow="40"/);
    expect(html).toContain('data-slot="progress-track"');
    expect(html).toMatch(/style="[^"]*width:40%"[^>]*data-slot="progress-indicator"/);
  });

  it('card: one spacing variable, 24px by default and 16px when small', () => {
    const html = renderToStaticMarkup(
      <Card size="sm">
        <CardContent>body</CardContent>
      </Card>,
    );
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('[--card-spacing:--spacing(6)]');
    expect(html).toContain('data-[size=sm]:[--card-spacing:--spacing(4)]');
    expect(html).toMatch(/data-slot="card-content" class="px-\(--card-spacing\)"/);
  });
});
