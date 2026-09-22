import { describe, expect, it } from 'vitest'
import { zcodeStructuredPermissionModeForSettings } from './zcode-structured-permission-policy'

describe('zcodeStructuredPermissionModeForSettings', () => {
  it('bypasses when the user has never opened Agent settings', () => {
    expect(zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: {} })).toBe('yolo')
    expect(zcodeStructuredPermissionModeForSettings({})).toBe('yolo')
    expect(zcodeStructuredPermissionModeForSettings(null)).toBe('yolo')
    expect(zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: { claude: '' } })).toBe(
      'yolo'
    )
  })

  it('resolves yolo when the flag is present, alone or beside other tokens', () => {
    for (const zcode of [
      '--mode=yolo',
      '--mode=yolo --model glm-5.3',
      '--model glm-5.3 --mode=yolo'
    ]) {
      expect(zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: { zcode } }), zcode).toBe(
        'yolo'
      )
    }
  })

  it('keeps quoted mentions and operands after -- in default', () => {
    for (const zcode of ['--config "note=--mode=yolo only as text"', '-- --mode=yolo']) {
      expect(zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: { zcode } }), zcode).toBe(
        'default'
      )
    }
  })

  it('answers default when Manual cleared the flag or named another mode', () => {
    expect(zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: { zcode: '' } })).toBe(
      'default'
    )
    expect(
      zcodeStructuredPermissionModeForSettings({ agentDefaultArgs: { zcode: '--mode=build' } })
    ).toBe('default')
  })
})
