import { describe, it, expect } from 'vitest'
import {
  bucketForChannel,
  assetTypeForMime,
} from '../../src/lib/chat/repository/chatAttachmentUploader'

describe('bucketForChannel', () => {
  it('customer channel maps to chat-customer', () => {
    expect(bucketForChannel('customer')).toBe('chat-customer')
  })
  it('dispute channel maps to chat-dispute', () => {
    expect(bucketForChannel('dispute')).toBe('chat-dispute')
  })
  it('office/team/assignment map to chat-internal', () => {
    expect(bucketForChannel('office')).toBe('chat-internal')
    expect(bucketForChannel('team')).toBe('chat-internal')
    expect(bucketForChannel('assignment')).toBe('chat-internal')
  })
})

describe('assetTypeForMime', () => {
  it('image/* → image', () => {
    expect(assetTypeForMime('image/jpeg')).toBe('image')
    expect(assetTypeForMime('image/png')).toBe('image')
    expect(assetTypeForMime('image/heic')).toBe('image')
  })
  it('video/* → video', () => {
    expect(assetTypeForMime('video/mp4')).toBe('video')
    expect(assetTypeForMime('video/quicktime')).toBe('video')
  })
  it('audio/* → voice', () => {
    expect(assetTypeForMime('audio/mp4')).toBe('voice')
    expect(assetTypeForMime('audio/wav')).toBe('voice')
  })
  it('application/* → document', () => {
    expect(assetTypeForMime('application/pdf')).toBe('document')
  })
  it('unknown defaults to document', () => {
    expect(assetTypeForMime('text/plain')).toBe('document')
    expect(assetTypeForMime('')).toBe('document')
  })
})
