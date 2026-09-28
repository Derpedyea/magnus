import { Toast as ToastPrimitive } from "@base-ui/react/toast"

// Apart from toast.tsx so that file exports only components, and so the one manager survives Fast Refresh.
export const toast = ToastPrimitive.createToastManager()
