import { DEFAULT_MARK_FILL_PCT, markBox } from '@/components/mark-box'

// IRC has no owner and so no brand; the mark is the channel sigil.
export function IrcMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <img src="/brands/irc.svg" alt="" style={markBox(fillPct)} className="object-contain" aria-hidden />
}
