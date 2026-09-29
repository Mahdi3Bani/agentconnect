import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { Toggle } from '@/components/ui'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { usePublishedFooter } from '../publish'
import { TokenGuidePane } from '../wizard-chrome'

// Mirrors the Control Plane's checks, so the form flags a typo before the round trip does.
const NICK = /^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/
const CHANNEL = /^[#&!+][^\s,\x07]{1,199}$/

/** Channels as typed: separated by commas or spaces, a missing `#` added. */
export function parseIrcChannels(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((c) => (/^[#&!+]/.test(c) ? c : `#${c}`))
}

export function IrcWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.irc')
  const [server, setServer] = useState('')
  const [port, setPort] = useState('6697')
  const [tls, setTls] = useState(true)
  const [nick, setNick] = useState('')
  const [channels, setChannels] = useState('')
  const [saslAccount, setSaslAccount] = useState('')
  const [saslPassword, setSaslPassword] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)

  const serverTrim = server.trim()
  const portNum = Number(port)
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535
  const nickOk = NICK.test(nick.trim())
  const channelList = parseIrcChannels(channels)
  const channelsOk = channelList.every((c) => CHANNEL.test(c))
  const saslOk = !saslAccount.trim() === !saslPassword
  const valid = !!serverTrim && portOk && nickOk && channelsOk && saslOk

  async function submit() {
    if (!valid || busy.current) return
    busy.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'irc',
        agentId: agent.id,
        irc: {
          host: serverTrim,
          port: portNum,
          tls,
          nick: nick.trim(),
          channels: channelList,
          ...(saslAccount.trim() ? { saslAccount: saslAccount.trim(), saslPassword } : {}),
          ...(serverPassword ? { serverPassword } : {})
        }
      })
      host.close()
    } catch (error) {
      host.setError(error instanceof Error ? error.message : String(error))
      busy.current = false
      setSaving(false)
    }
  }
  usePublishedFooter(host, {
    label: saving ? t('connecting') : t('connect'),
    enabled: valid && !saving,
    onSubmit: () => void submit()
  })
  if (host.mode !== 'create') return null
  return (
    <TokenGuidePane
      mark={<PlatformMark platform="irc" />}
      step1={t('step1')}
      linkHref="https://ircv3.net/support/networks"
      linkLabel={t('networks')}
      step2={t('step2')}
      fields={[
        { label: t('server'), placeholder: 'irc.libera.chat', value: server, invalid: false, onChange: setServer },
        {
          label: t('port'),
          placeholder: '6697',
          value: port,
          invalid: port !== '' && !portOk,
          onChange: (next) => {
            setPort(next)
            // The IANA ports: 6697 is TLS and 6667 plaintext, so picking one sets the other.
            if (next === '6697') setTls(true)
            if (next === '6667') setTls(false)
          }
        },
        { label: t('nick'), placeholder: 'r2d2', value: nick, invalid: nick !== '' && !nickOk, onChange: setNick },
        {
          label: t('channels'),
          placeholder: '#cantina, #hangar',
          value: channels,
          invalid: !channelsOk,
          onChange: setChannels
        },
        {
          label: t('saslAccount'),
          placeholder: t('optional'),
          value: saslAccount,
          invalid: !saslOk && !saslAccount.trim(),
          onChange: setSaslAccount
        },
        {
          label: t('saslPassword'),
          placeholder: t('optional'),
          value: saslPassword,
          invalid: !saslOk && !saslPassword,
          onChange: setSaslPassword,
          secret: true
        },
        {
          label: t('serverPassword'),
          placeholder: t('optional'),
          value: serverPassword,
          invalid: false,
          onChange: setServerPassword,
          secret: true
        }
      ]}
    >
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">{t('tls')}</div>
          <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {tls ? t('tlsOn') : t('tlsOff')}
          </div>
        </div>
        <Toggle checked={tls} onChange={setTls} ariaLabel={t('tls')} />
      </div>
    </TokenGuidePane>
  )
}
