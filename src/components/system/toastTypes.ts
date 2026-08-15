export type ToastTone = 'success' | 'error' | 'info'

export type ToastItem = {
  id: string
  message: string
  tone: ToastTone
  duration: number
  exiting: boolean
}

export type ToastAPI = {
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  dismiss: (id: string) => void
}
