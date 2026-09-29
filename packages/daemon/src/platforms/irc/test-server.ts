import net from 'node:net'

/**
 * Just enough IRC server to drive the adapter's tests.
 *
 * A real network is the wrong dependency here: the whole question this slice
 * answers is what happens when the server DOESN'T advertise the IRCv3
 * capabilities, and you cannot ask Libera to stop supporting message-tags.
 * `caps` is the knob.
 */
export interface TestServerOptions {
  /** What the server advertises in CAP LS. Empty means a pre-IRCv3 network. */
  caps?: string[]
  members?: Record<string, string[]>
  channels?: { name: string; users: number; topic: string }[]
  /** Accept echo-message but never echo, to exercise the unconfirmed path. */
  withholdEcho?: boolean
  /** Nicks already held by someone else, answered with 433 at registration. */
  takenNicks?: string[]
  /** SASL PLAIN logins (account to password); when set, `sasl` is advertised. */
  saslAccounts?: Record<string, string>
}

export interface TestServer {
  port: number
  close(): Promise<void>
  /** Lines the server received, for asserting what the adapter actually sent. */
  received: string[]
  /** Accounts that logged in with SASL, in order. */
  authenticated: string[]
  /** Push a line at the connected client, e.g. an inbound PRIVMSG. */
  push(line: string): void
  /** Drop the current client's socket, as a netsplit or ping timeout would. */
  drop(): void
  /** How many connections the server has accepted. */
  connections(): number
  /** Nicks a client may not take; mutable, so a test can release one. */
  takenNicks: Set<string>
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const caps = [
    ...(options.caps ?? ['message-tags', 'server-time', 'echo-message', 'account-tag', 'multi-prefix']),
    ...(options.saslAccounts ? ['sasl'] : [])
  ]
  const authenticated: string[] = []
  const members = options.members ?? { '#cantina': ['@han', '+leia', 'chewie'] }
  const channels = options.channels ?? [{ name: '#cantina', users: 3, topic: 'no droids' }]

  const received: string[] = []
  let client: net.Socket | undefined
  let accepted = 0
  const takenNicks = new Set(options.takenNicks ?? [])

  const send = (line: string) => client?.write(line + '\r\n')

  const server = net.createServer((socket) => {
    client = socket
    accepted++
    let nick = '*'
    let userSent = false
    let buffer = ''
    let negotiating = false
    let registered = false
    const acked = new Set<string>()
    let msgSeq = 0

    // A real server withholds 001 until CAP END. Sending it early ends
    // registration before the client has asked for anything, which is exactly
    // how this mock hid a working adapter behind four failing tests.
    const welcome = () => {
      if (registered || nick === '*' || !userSent) return
      registered = true
      send(`:server 001 ${nick} :Welcome to the test network`)
      send(`:server 005 ${nick} CHANTYPES=#& NETWORK=testnet :are supported`)
      send(`:server 376 ${nick} :End of MOTD`)
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\r\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line) continue
        received.push(line)
        const [command = '', ...args] = line.split(' ')

        switch (command.toUpperCase()) {
          case 'CAP': {
            const sub = (args[0] ?? '').toUpperCase()
            if (sub === 'LS') {
              negotiating = true
              send(`:server CAP * LS :${caps.join(' ')}`)
            } else if (sub === 'END') {
              negotiating = false
              welcome()
            } else if (sub === 'REQ') {
              const asked = line
                .slice(line.indexOf(':') + 1)
                .split(' ')
                .filter(Boolean)
              const granted = asked.filter((c) => caps.includes(c))
              const refused = asked.filter((c) => !caps.includes(c))
              granted.forEach((c) => acked.add(c))
              if (granted.length) send(`:server CAP ${nick} ACK :${granted.join(' ')}`)
              if (refused.length) send(`:server CAP ${nick} NAK :${refused.join(' ')}`)
            }
            break
          }

          case 'NICK': {
            const wanted = args[0] ?? '*'
            if (takenNicks.has(wanted)) {
              send(`:server 433 ${nick} ${wanted} :Nickname is already in use`)
              break
            }
            nick = wanted
            if (!negotiating) welcome()
            break
          }

          case 'AUTHENTICATE': {
            const arg = args[0] ?? ''
            if (arg === 'PLAIN') {
              send('AUTHENTICATE +')
              break
            }
            // authzid NUL authcid NUL password, base64-encoded.
            const [, account = '', password = ''] = Buffer.from(arg, 'base64').toString('utf8').split('\0')
            if (options.saslAccounts?.[account] === password && password) {
              authenticated.push(account)
              send(`:server 900 ${nick} ${nick}!u@h ${account} :You are now logged in as ${account}`)
              send(`:server 903 ${nick} :SASL authentication successful`)
            } else send(`:server 904 ${nick} :SASL authentication failed`)
            break
          }

          case 'USER':
            userSent = true
            if (!negotiating) welcome()
            break

          case 'JOIN': {
            const channel = args[0] ?? ''
            send(`:${nick}!u@h JOIN ${channel}`)
            send(`:server 332 ${nick} ${channel} :${channels.find((c) => c.name === channel)?.topic ?? ''}`)
            send(`:server 353 ${nick} = ${channel} :${(members[channel] ?? []).join(' ')}`)
            send(`:server 366 ${nick} ${channel} :End of /NAMES list`)
            break
          }

          case 'NAMES': {
            const channel = args[0] ?? ''
            send(`:server 353 ${nick} = ${channel} :${(members[channel] ?? []).join(' ')}`)
            send(`:server 366 ${nick} ${channel} :End of /NAMES list`)
            break
          }

          case 'LIST':
            for (const c of channels) {
              send(`:server 322 ${nick} ${c.name} ${c.users} :${c.topic}`)
            }
            send(`:server 323 ${nick} :End of /LIST`)
            break

          case 'WHOIS': {
            const target = args[0]
            send(`:server 311 ${nick} ${target} ~user host * :Real Name Of ${target}`)
            send(`:server 318 ${nick} ${target} :End of /WHOIS list`)
            break
          }

          case 'PRIVMSG': {
            if (!acked.has('echo-message') || options.withholdEcho) break
            const target = args[0] ?? ''
            const text = line.slice(line.indexOf(' :') + 2)
            const tags = [
              ...(acked.has('message-tags') ? [`msgid=srv${++msgSeq}`] : []),
              ...(acked.has('server-time') ? [`time=${new Date().toISOString()}`] : [])
            ]
            send(`${tags.length ? `@${tags.join(';')} ` : ''}:${nick}!u@h PRIVMSG ${target} :${text}`)
            break
          }

          case 'QUIT':
            socket.end()
            break
        }
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port

  return {
    port,
    received,
    authenticated,
    push: (line) => send(line),
    drop: () => client?.destroy(),
    connections: () => accepted,
    takenNicks,
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy()
        server.close(() => resolve())
      })
  }
}
