import { createContext } from 'react'
import type { ToastAPI } from './toastTypes'

export const ToastContext = createContext<ToastAPI | null>(null)
