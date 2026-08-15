import { useContext } from 'react'
import { ToastContext } from '../components/system/toastContext'
import type { ToastAPI } from '../components/system/toastTypes'

export type { ToastAPI }

const noopToast: ToastAPI = {
  success: () => {},
  error: () => {},
  info: () => {},
  dismiss: () => {},
}

export function useToast(): ToastAPI {
  return useContext(ToastContext) ?? noopToast
}
