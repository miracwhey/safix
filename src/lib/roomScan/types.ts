export interface WallInfo {
  widthM: number
  heightM: number
}

export interface OpeningInfo {
  widthM: number
  heightM: number
}

export interface RoomScanMetadata {
  capturedAt: string
  floorAreaM2: number
  ceilingHeightM: number
  walls: WallInfo[]
  doors: OpeningInfo[]
  windows: OpeningInfo[]
  furnitureCount: number
  furnitureCategories: string[]
}

export type RoomScanStatus = 'idle' | 'scanning' | 'uploading' | 'done' | 'error'

export interface RoomScanState {
  status: RoomScanStatus
  uploadProgress: number | null
  scanUrl: string | null
  metadata: RoomScanMetadata | null
  error: string | null
}
