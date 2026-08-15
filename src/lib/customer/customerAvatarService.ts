import { uploadMediaFile, fetchMediaForEntity } from '../media/mediaUploadService'
import { updateCustomerContext } from './customerContextStore'
import { logError, logInfo } from '../observability'

export async function uploadCustomerAvatar(
  file: File,
  customerUserId: string,
): Promise<string> {
  const record = await uploadMediaFile({
    file,
    entityType: 'profile',
    entityId: customerUserId,
    ownerUserId: customerUserId,
    mediaRole: 'avatar',
  })

  updateCustomerContext({ avatarUrl: record.publicUrl })
  logInfo('media.customer_avatar.upload_complete', { customerUserId, publicUrl: record.publicUrl })
  return record.publicUrl
}

export async function loadCustomerAvatarFromStorage(
  customerUserId: string,
): Promise<string | null> {
  try {
    const records = await fetchMediaForEntity('profile', customerUserId)
    const avatar = records.find((r) => r.mediaRole === 'avatar')
    return avatar?.publicUrl ?? null
  } catch (err) {
    logError('media.customer_avatar.load_failed', err, { customerUserId })
    return null
  }
}
