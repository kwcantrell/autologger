import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import type * as React from 'react';
import { cn } from '@/shared/lib/utils';

// base-nova (job 088): the Base UI Drawer replaces vaul. The app uses it only as the mobile bottom
// sheet (shared/ui/Dialog), so this keeps the base-nova anatomy (Backdrop, Viewport > Popup >
// Content) for a downward swipe and drops the other directions, snap points and nesting.

function Drawer({ swipeDirection = 'down', ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" swipeDirection={swipeDirection} {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

// V5 (shadcn-shared-wrappers D1/D2): the app's mobile bottom sheet — legacy shared/ui/Dialog sheet
// classes. The primitive owns the slide/drag transform (`--drawer-swipe-movement-y`).
function DrawerOverlay({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        'fixed inset-0 z-(--z-dialog-overlay) min-h-dvh bg-[rgba(8,10,14,0.72)] animate-overlay-fade-in opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:pointer-events-none data-ending-style:opacity-0 data-swiping:duration-0',
        className,
      )}
      {...props}
    />
  );
}

/** The drag handle: the only surface that starts a swipe-to-dismiss (the body below carries
 * `data-base-ui-swipe-ignore`, so content keeps scrolling and selecting). */
function DrawerHandle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-handle"
      aria-hidden="true"
      className={cn(
        'mx-auto mt-1 mb-3 h-[5px] w-[32px] shrink-0 cursor-grab rounded-full bg-v5-border-strong active:cursor-grabbing',
        className,
      )}
      {...props}
    />
  );
}

// `initialFocus` defaults to the first focusable control in the sheet (Base UI's drawer would focus
// the popup itself), as the vaul sheet with `autoFocus` did.
function DrawerContent({
  className,
  children,
  initialFocus = true,
  ...props
}: DrawerPrimitive.Popup.Props) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="pointer-events-none fixed inset-0 z-(--z-dialog-content)"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            'pointer-events-auto fixed inset-x-0 top-auto bottom-0 z-(--z-dialog-content) flex h-auto w-full max-h-[88dvh] flex-col rounded-t-v5-md border border-v5-border-strong bg-si-panel-2 border-b-0 px-[1.15rem] pt-2 pb-[calc(1.4rem+env(safe-area-inset-bottom))] text-v5-text outline-none focus-visible:outline-2 focus-visible:outline-v5-primary focus-visible:-outline-offset-4',
            'transform-[translate3d(0,var(--drawer-swipe-movement-y,0px),0)] transition-transform duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform [--closed-transform:translate3d(0,calc(100%+2px),0)] data-starting-style:transform-(--closed-transform) data-ending-style:transform-(--closed-transform) data-ending-style:duration-[calc(var(--drawer-swipe-strength,1)*400ms)] data-swiping:duration-0',
            className,
          )}
          initialFocus={initialFocus}
          {...props}
        >
          <DrawerHandle />
          <DrawerPrimitive.Content
            data-slot="drawer-body"
            data-base-ui-swipe-ignore=""
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
          >
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-0.5 p-4 text-center md:gap-1.5 md:text-left', className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('mx-0 mt-0 mb-3 text-[1.05rem] font-semibold text-v5-text', className)}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn(
        'mx-0 mt-0 mb-[0.85rem] text-[0.85rem] leading-[1.45] text-v5-muted',
        className,
      )}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHandle,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
};
