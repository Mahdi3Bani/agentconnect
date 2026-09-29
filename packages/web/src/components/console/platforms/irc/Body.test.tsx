import { describe, expect, it } from 'vitest'
import { parseIrcChannels } from './Body'

describe('IRC channel entry', () => {
  it('splits on commas or spaces and adds a missing #', () => {
    expect(parseIrcChannels('#cantina, hangar  &local\n+modeless')).toEqual([
      '#cantina',
      '#hangar',
      '&local',
      '+modeless'
    ])
    expect(parseIrcChannels('  ')).toEqual([])
  })
})
