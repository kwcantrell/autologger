import type { ReactNode } from 'react';
import {
  DialogContent,
  DialogDescription,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import {
  DrawerContent,
  DrawerDescription,
  Drawer as DrawerRoot,
  DrawerTitle,
} from '@/shared/components/ui/drawer';
import { useDialogMode } from './breakpoints';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Hide the visual title heading (keeps an SR-only title for a11y).
   * Use when the caller renders its own heading inside `children`.
   */
  hideTitle?: boolean;
  /** Set to false to suppress the close-on-overlay-click default. */
  closeOnOverlayClick?: boolean;
}

/**
 * The app's shared dialog (shadcn-shared-wrappers D2): the shadcn Dialog (V5-styled primitive)
 * as a centered card on desktop, the Drawer as a bottom sheet on mobile. `className` passes
 * through to the content, so consumers' `md:!` / `max-md:!` positioning overrides keep applying.
 * job 088: both are Base UI primitives; an outside press is the Root's `disablePointerDismissal`,
 * and a consumer that keeps `open` true after a close request (a veto) simply stays open.
 */
export function Dialog(props: DialogProps) {
  const isMobile = useDialogMode(props.open);
  return isMobile ? <SheetDialog {...props} /> : <CardDialog {...props} />;
}

function CardDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle = false,
  closeOnOverlayClick = true,
}: DialogProps) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      disablePointerDismissal={!closeOnOverlayClick}
    >
      <DialogContent className={className}>
        <DialogTitle className={hideTitle ? 'sr-only' : undefined}>{title}</DialogTitle>
        {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        <div className="block">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}

function SheetDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideTitle = false,
  closeOnOverlayClick = true,
}: DialogProps) {
  return (
    <DrawerRoot
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      // Only an outside press is switched off; the handle still drags the sheet shut, as before.
      disablePointerDismissal={!closeOnOverlayClick}
    >
      <DrawerContent className={className}>
        <DrawerTitle className={hideTitle ? 'sr-only' : undefined}>{title}</DrawerTitle>
        {description !== undefined && <DrawerDescription>{description}</DrawerDescription>}
        <div className="block">{children}</div>
      </DrawerContent>
    </DrawerRoot>
  );
}

/**
 * The dialog action row (shadcn-port-settings D2): right-aligned buttons with the spacing the
 * legacy `.modal-actions` chrome had. Shared by every ported dialog.
 */
export function DialogActions({ children }: { children: ReactNode }) {
  return (
    <div data-slot="dialog-actions" className="mt-5 flex justify-end gap-[0.6rem]">
      {children}
    </div>
  );
}
