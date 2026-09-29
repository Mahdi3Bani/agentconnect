# IRC platform adapter — where this is up to

Working notes. Read this first. Drop or rewrite this file before the PR.

## What this is

An IRC adapter for AgentConnect, contributed upstream (there is no plugin
system -- `docs/designs/integration-plugin-architecture.md` §13 says third-party
extensibility is deferred, so a platform lives in this repo or nowhere).

A maintainer said on issue #2262 that they welcome contributions adding widely
used chat platforms. Nothing has been posted to them yet -- no issue, no PR.
The branch is pushed to the fork `Mahdi3Bani/agentconnect` (remote `fork`);
`origin` is still upstream, for pulling.

## Status: slices 0 to 3 are done and passing

Slice 0 is the required half of `PlatformConnection` (`../contract.ts`), slice 1
message normalization and sending, slice 2 the per-turn output surface and staying
connected, slice 3 the registry wiring: IRC is installable from the console and
the daemon opens, binds and routes it.

```sh
cd ~/agentconnect/packages/daemon
npx vitest run test/irc-*.test.ts                        # 52/52
npx tsc --noEmit -p tsconfig.typecheck.json | grep irc   # clean
cd ../message && npx vitest run test/irc-message.test.ts # 14/14
```

Use `tsconfig.typecheck.json`: it resolves workspace siblings from source. Plain
`tsconfig.json` reports ~900 pre-existing errors, including "cannot find
`@agentconnect.md/message`" in 18 files, because that package's `dist` is unbuilt.

| file                          | what                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| `connection.ts`               | the adapter: lifecycle, reconnect, inbound, `sendText`, the read port |
| `turn-output.ts`              | Layer 2: converger, per-turn state, applier                           |
| `surface.ts`                  | the `TurnOutputSurface` a daemon registry entry would register        |
| `render.ts`                   | markdown to IRC text, and formatting carried across lines             |
| `split.ts`                    | the 512-byte line budget and grapheme-safe splitting                  |
| `flood.ts`                    | RFC 1459 §8.10 flood pacing, as a `PlatformSendQueue` gate            |
| `test-server.ts`              | a minimal IRC server whose advertised capabilities are a parameter    |
| `irc-framework.d.ts`          | types -- the library ships none                                       |
| `message/src/irc-message.ts`  | pure inbound normalization, beside QQ's                               |
| `../../../test/irc-*.test.ts` | connection (28, against the test server), split (11), output (13)     |

The contract fits: `IrcConnection implements PlatformConnection` typechecks
against their real contract. `listMembers` is NAMES, `listChannels` is LIST,
`getUserProfile` is WHOIS, `downloadFile` returns null forever (IRC has no
attachments), `workspaceId()` returns undefined (IRC has no tenant).

## The open design question

Message ids, timestamps and send confirmation come from IRCv3 capabilities
negotiated **per connection** (`message-tags`, `server-time`, `echo-message`).
Ergo, InspIRCd 3+, UnrealIRCd 6 and Soju grant them; older networks grant
nothing. `PlatformManifest` describes a platform, not a connection -- so this
cannot be a manifest constant the way `membershipEnumeration` is.

§5.1 of the integration design hit the same shape with `identityScope` and moved
the axis to the assignment. That is the precedent to argue from.

There is a test server in here precisely so this is demonstrable rather than
asserted -- you cannot ask Libera.Chat to stop supporting `message-tags`.

## Slice 1: what was built

- **Inbound**: `normalizeIrcMessage` in the message package. msgId is
  `irc:<channel>:<native>`, where native is the `msgid` tag or a connection-minted
  `local-<ms>-<n>`. It has to be that shape: core reads the tail after the last
  `:` as the native id and the transcript dedup key (`wire-coordinates.ts`,
  `session-manager.ts transcriptCoords`), so `:` inside a msgid is escaped.
  `platformTimeMs` is always set (server-time, else receipt time). A DM's channel
  is the sender's nick. Sender id is `account:<name>` under account-tag, else
  `nick:<nick>`. `nick: text` addressing is stripped and counts as a mention;
  mentions fold under the server's CASEMAPPING. Own echoes, CTCP and blank lines
  are dropped; ACTION becomes `* nick text`; the IRCv3 `bot` tag sets isBot.
  `thread` is a constant (`channel`/`dm`), as QQ does, because core falls back to
  msgId as the session key when thread is absent.
- **Outbound**: `IrcConnection.sendText(target, text)` returns one receipt per
  line: `confirmed` only when echo-message returned it, `id` the server msgid when
  tagged. The target is validated, since it is interpolated into a raw line.
- **512 bytes**: the budget subtracts the `:nick!user@host ` prefix the server
  adds when relaying, assuming a 63-byte host until irc-framework learns ours.
  irc-framework's own `say` splitter uses a fixed 350 bytes and the old
  `grapheme-splitter` package; this uses `Intl.Segmenter`.
- **Flood**: `IrcFloodGate` gives a burst of 4, then one line per 2s. The window is 8s,
  below the RFC's 10s, for headroom.

## Slice 2: what was built

- **Queries share the flood gate**, and their targets are validated like sends
  (NAMES and WHOIS interpolated them raw). The gate wait comes before each
  query's timeout, so a busy gate cannot eat the reply window.
- **One id scheme** (`ircUserId` / `parseIrcUserId`): `listMembers` and
  `getUserProfile` now return `nick:`/`account:` ids like message senders, and
  `getUserProfile` accepts one (WHOIS on `nick:han` asked the server about a
  user literally named that). An `account:` id WHOISes the last nick seen using it.
- **Turn output** (`turn-output.ts`, `surface.ts`), modelled on QQ's group output
  because neither platform can edit: nothing streams, the final answer is posted
  once. Progress is completed intermediate messages only: in a channel only in
  `high` mode, in a DM from `medium`; at most 2, 15s apart, one line each. A
  channel answer is addressed `nick: ...`; answers are cut at 12 lines in a
  channel and 40 in a DM, with a notice line. No admission feedback: IRC has no
  reactions, and a "working on it" line in a shared channel is noise.
- **Markdown**: bold and italics become mIRC codes, links show their URL, code
  fences are dropped but lines kept. Clients reset formatting at every line
  end, so `carryFormatting` closes and reopens it across each split.
- **Staying connected**: the adapter runs its own reconnect loop (backoff to
  5 min, never gives up) instead of irc-framework's, which stops after 3
  failures and does not retry at all when a server closes before 001. It rejoins
  `config.channels` on every registration and re-reads the granted caps, since
  a reconnect may land on a different server. A send while disconnected throws
  (irc-framework drops it silently). A taken nick falls back to `nick_`,
  `nick__`, `nick3`...; mentions follow the nick actually held.

Not built yet: outbound `+draft/reply` tags; reclaiming the configured nick
after a fallback (NickServ REGAIN); elicitation cards (absent means the core
declines the ask with a notice).

## Slice 3: the registry wiring

Copied from QQ's registration, per #2262: no Prisma migration, no feature flag,
no registry refactors.

- **protocol**: `IntegrationIrcConfig`, `irc` in `KNOWN_PLATFORMS`, and a manifest
  row whose one earned axis is `dmChannelPattern` (a DM's channel is a nick, and
  a nick never starts with `#&!+`).
- **control plane**: `platforms/irc/provider.ts`. The public login rides
  `Bot.platformConfig`; the SASL password is the `botToken` slot, the server
  password `appToken`. One nick per network is one bot (the D6 fence). No live
  check at install: the daemon reaches the network, and a private server may be
  invisible from the control plane.
- **daemon**: `consolidateIrc` + `ircConnKey`, an `ircPool` in the reconciler,
  and the binding map, turn surface, command chrome, egress and read port in
  `daemon.ts`. A login whose server is down at boot retries every 60s; once up,
  the connection keeps itself connected. Connection scope is the nick on its
  network (a password rotation keeps it); the tenant is the network.
- **web**: `components/console/platforms/irc/`, a form on the shared
  `TokenGuidePane`.
- **Found while wiring**: routing matches `mentionedBots` exactly against the
  bound nick, so after a fallback (`nick_`) mentions stopped routing. The
  normalizer now detects the live nick and reports the configured one. The bot
  also joins channels it is `/invite`d to, which makes the wizard's "invite the
  bot" hint true.

## Next

The live test on the team VM (Ergo + this branch), then the issue and PR.

## Things that only showed up by building it

1. `irc-framework` ships no type declarations, hence the local `.d.ts`.
2. `echo-message` is opt-in -- irc-framework requests it only if you pass
   `enable_echomessage`. Delivery confirmation depends on asking.
3. ISUPPORT (005) arrives **after** the `registered` event, so anything derived
   from it must be a lazy getter.
4. `CHANTYPES` returns a string on some ircds and an array on others.
5. `userlist` only fires for channels the client has joined, so `listMembers`
   reads RPL_NAMREPLY/RPL_ENDOFNAMES directly.
6. Lazy getters were not enough for #3: slice 0's `start()` resolved on
   `registered`, and under parallel load "reports the network" failed about 1 run
   in 6. `start()` now resolves on end-of-MOTD (376/422), which follows 005.
7. Without echo-message a "sent" line has only reached the local socket, not the
   server. The receipt says so (`confirmed: false`) instead of pretending.
8. Newer platforms live in `src/platforms/<id>/` (qq, googlechat), older ones in
   `src/<id>/`. This moved from `src/irc/` to `src/platforms/irc/` in slice 2.
9. irc-framework's `raw()` on a closed socket returns without writing or
   throwing, so a send during a reconnect would vanish without the check.
10. irc-framework does not handle ERR_NICKNAMEINUSE at all: registration just
    hangs until the timeout, which after a drop is the normal case, since the
    ghost of the old connection holds the nick.

## Environment

Node >= 24.12.0 (25.4 works). pnpm is not installed globally -- use
`npx pnpm@11.19.0`. `pnpm install` is already done here; `irc-framework` is
already added to this package.

A second copy of just these files, with its own README, is at
`~/agentconnect-irc` (a git repo) in case this checkout is ever blown away.
