import { Toast } from "@base-ui/react/toast";
import type { UseToastManagerReturnValue } from "@base-ui/react/toast";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

const ToastManagerContext = createContext<UseToastManagerReturnValue | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      <ToastManagerBridge>{children}</ToastManagerBridge>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-3 bottom-3 z-[100] flex w-80 flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastManagerBridge({ children }: { children: ReactNode }) {
  const manager = Toast.useToastManager();
  return (
    <ToastManagerContext.Provider value={manager}>
      {children}
    </ToastManagerContext.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <>
      {toasts.map((toast) => (
        <Toast.Root
          key={toast.id}
          toast={toast}
          className="relative border-2 border-border bg-paper p-2 pr-8 shadow-hard data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        >
          <Toast.Title className="text-sm font-bold">{toast.title}</Toast.Title>
          {toast.description ? (
            <Toast.Description className="text-xs text-muted">
              {toast.description}
            </Toast.Description>
          ) : null}
          <Toast.Close className="absolute top-1 right-1 border-2 border-transparent px-1 text-xs hover:border-border">
            ✕
          </Toast.Close>
        </Toast.Root>
      ))}
    </>
  );
}

export function useToast() {
  const manager = useContext(ToastManagerContext);
  if (!manager) {
    throw new Error("useToast must be used within ToastProvider");
  }
  const show = useCallback(
    (title: string, description?: string) => {
      manager.add({ title, description, timeout: 3200 });
    },
    [manager],
  );
  return useMemo(() => ({ show }), [show]);
}
