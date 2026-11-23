import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';

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

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
