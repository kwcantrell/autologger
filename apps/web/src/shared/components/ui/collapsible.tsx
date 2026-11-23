import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { cn } from '@/shared/lib/utils';

// base-nova collapsible (Base UI Collapsible), unstyled as in the registry: the caller styles the
// trigger and panel. The trigger carries `aria-expanded` and `data-panel-open`; the panel is
// removed while closed unless `keepMounted` or `hiddenUntilFound` (find-in-page can open it).
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;
}

// Local addition: a trigger that reads as a native <summary> — the browser's own disclosure
// triangle (a `list-item` marker, so it matches <details> exactly), the surrounding type, no
// button chrome. For quiet "Clips" / "N left out" reveals; the caller sets the text colour.
function CollapsibleSummary({
  className,
  children,
  ...props
}: Omit<CollapsiblePrimitive.Trigger.Props, 'className'> & { className?: string }) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        'group/summary block w-full cursor-pointer border-0 bg-transparent p-0 text-left [font:inherit]',
        className,
      )}
      {...props}
    >
      <span className="list-item list-inside [list-style-type:disclosure-closed] group-data-[panel-open]/summary:[list-style-type:disclosure-open]">
        {children}
      </span>
    </CollapsiblePrimitive.Trigger>
  );
}

export { Collapsible, CollapsibleContent, CollapsibleSummary, CollapsibleTrigger };
