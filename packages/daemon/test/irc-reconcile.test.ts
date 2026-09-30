import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { startTestServer, type TestServer } from '../src/platforms/irc/test-server.js'

let servers: TestServer[] = []
let reconciler: ConnectionReconciler | undefined

afterEach(async () => {
  await reconciler?.dispose()
  for (const s of servers) await s.close()
  servers = []
  reconciler = undefined
})

async function server(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(options)
  servers.push(s)
  return s
}

const agentOn = (port: number, nick = 'r2d2'): LoadedAgent =>
  ({
    id: 'agent',
    integrations: [
      {
        id: 'irc-install',
        platform: 'irc',
        config: { host: '127.0.0.1', port, tls: false, nick, channels: ['#cantina'] }
      }
    ]
  }) as unknown as LoadedAgent

function harness(agents: () => LoadedAgent[]) {
  const inbound: { msg: NormalizedMessage; ids?: string[] }[] = []
  const bound = new Map<string, string>()
  const connOf = new Map<string, unknown>()
  const timers: (() => void)[] = []
  reconciler = new ConnectionReconciler({
    transportAgents: agents,
    draining: () => false,
    log: () => ({ info: vi.fn(), warn: vi.fn() }),
    clock: () => ({
      now: () => Date.now(),
      setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
      clearTimeout: vi.fn()
    }),
    channelNameResolver: () => undefined,
    // Mirrors daemon.ts' reverse lookup: only the installs this very connection serves.
    srcIntegrationIds: (conn: unknown) => [...connOf].filter(([, c]) => c === conn).map(([id]) => id),
    onInbound: (msg: NormalizedMessage, ids?: string[]) => inbound.push({ msg, ids }),
    bindIrc: (id: string, conn: unknown, nick: string) => (connOf.set(id, conn), bound.set(id, nick))
  } as unknown as ConnectionReconcilerHost)
  return { reconciler, inbound, bound, timers }
}

describe('IRC connections under the reconciler', () => {
  it('opens one connection per login, binds its nick, and routes what it hears', async () => {
    const irc = await server()
    const { reconciler, inbound, bound } = harness(() => [agentOn(irc.port)])
    await reconciler.reconcileIrcConnections()
    expect(reconciler.ircPool.all()).toHaveLength(1)
    expect(bound.get('irc-install')).toBe('r2d2')
    await vi.waitFor(() => expect(irc.received).toContain('JOIN #cantina'))

    irc.push(':han!h@host PRIVMSG #cantina :r2d2: status?')
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    expect(inbound[0]!.msg).toMatchObject({ platform: 'irc', channel: '#cantina', mentionedBots: ['r2d2'] })
    expect(inbound[0]!.ids).toEqual(['irc-install'])

    // Idempotent: a second pass finds the live connection instead of opening another.
    await reconciler.reconcileIrcConnections()
    expect(irc.connections()).toBe(1)
  })

  it('shares one connection between two agents installed on the same login', async () => {
    const irc = await server()
    const second = (base: LoadedAgent): LoadedAgent =>
      ({
        ...base,
        id: 'agent-2',
        integrations: [{ ...base.integrations[0]!, id: 'irc-install-2' }]
      }) as unknown as LoadedAgent
    const first = agentOn(irc.port)
    const { reconciler, inbound, bound } = harness(() => [first, second(first)])
    await reconciler.reconcileIrcConnections()

    // One login is one socket, however many agents reuse the bot behind it.
    expect(reconciler.ircPool.all()).toHaveLength(1)
    expect(irc.connections()).toBe(1)
    // Both installs are bound, so each agent's routing rules can arbitrate the same message.
    expect([...bound.keys()].sort()).toEqual(['irc-install', 'irc-install-2'])
    expect(bound.get('irc-install-2')).toBe('r2d2')

    irc.push(':han!h@host PRIVMSG #cantina :r2d2: status?')
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    expect(inbound[0]!.ids).toEqual(['irc-install', 'irc-install-2'])
  })

  it('binds the configured nick even when the server hands out a fallback', async () => {
    const irc = await server({ takenNicks: ['r2d2'] })
    const { reconciler, bound } = harness(() => [agentOn(irc.port)])
    await reconciler.reconcileIrcConnections()
    expect(irc.received).toContain('NICK r2d2_')
    expect(bound.get('irc-install')).toBe('r2d2')
  })

  it('retries a login whose server was down at boot, instead of waiting for a config change', async () => {
    const down = await server()
    const deadPort = down.port
    await down.close()
    servers = []
    let port = deadPort
    const { reconciler, bound, timers } = harness(() => [agentOn(port)])
    await reconciler.reconcileIrcConnections()
    expect(reconciler.ircPool.all()).toHaveLength(0)
    expect(timers).toHaveLength(1)

    const irc = await server()
    port = irc.port
    timers[0]!()
    await vi.waitFor(() => expect(bound.get('irc-install')).toBe('r2d2'))
    expect(reconciler.ircPool.all()).toHaveLength(1)
  })
})
