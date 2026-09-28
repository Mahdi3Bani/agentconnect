# IRC platform adapter — where this is up to

Untracked working notes. Read this first.

## What this is

An IRC adapter for AgentConnect, contributed upstream (there is no plugin
system -- `docs/designs/integration-plugin-architecture.md` §13 says third-party
extensibility is deferred, so a platform lives in this repo or nowhere).

A maintainer said on issue #2262 that they welcome contributions adding widely
used chat platforms. Nothing has been posted to them yet -- no issue, no PR.
They do not know about this.

## Status: slices 0 and 1 are done and passing

The **required half** of `PlatformConnection` (`../platforms/contract.ts`), which
is six methods. Everything else in that interface is optional and probed for at
runtime.

```sh
cd ~/agentconnect/packages/daemon
npx vitest run test/irc-connection.test.ts test/irc-split.test.ts # 30/30
npx tsc --noEmit -p tsconfig.typecheck.json | grep irc            # clean
cd ../message && npx vitest run test/irc-message.test.ts          # 14/14
```

Use `tsconfig.typecheck.json`: it resolves workspace siblings from source. Plain
`tsconfig.json` reports ~900 pre-existing errors, including "cannot find
`@agentconnect.md/message`" in 18 files, because that package's `dist` is unbuilt.

| file                                | what                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `connection.ts`                     | the adapter                                                        |
| `test-server.ts`                    | a minimal IRC server whose advertised capabilities are a parameter |
| `irc-framework.d.ts`                | types -- the library ships none                                    |
| `split.ts`                          | the 512-byte line budget and grapheme-safe splitting               |
| `flood.ts`                          | RFC 1459 §8.10 flood pacing, as a `PlatformSendQueue` gate         |
| `../../test/irc-connection.test.ts` | 19 tests, against the test server                                  |
| `../../test/irc-split.test.ts`      | 11 tests, pure                                                     |
| `message/src/irc-message.ts`        | pure inbound normalization, beside QQ's (`message/test` has 14)    |

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

Not in this slice: NAMES/WHOIS/LIST bypass the flood gate (they should share it
before a busy bot meets a strict server); no outbound `+draft/reply` tag; no
markdown-to-IRC rendering (agent markdown goes out literally); no Layer-2 turn
output. `sendText` is the primitive a turn output would call.

## Then the expensive part, not started

Registry entries across daemon, protocol, control-plane and web, plus the
manifest entry. Their QQ adapter touched 71 files. Guidance from #2262: do not
add a Prisma migration (reuse `Bot.platform` / `platformConfig` / `BotSecret`),
do not add a feature flag, do not refactor their registries -- copy the newest
platform's registration entries in the current style.

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
8. The module location: newer platforms live in `src/platforms/<id>/` (qq,
   googlechat), older ones in `src/<id>/`. This is in `src/irc/`; move it before
   the PR, to match "the newest platform's style".

## Environment

Node >= 24.12.0 (25.4 works). pnpm is not installed globally -- use
`npx pnpm@11.19.0`. `pnpm install` is already done here; `irc-framework` is
already added to this package.

A second copy of just these files, with its own README, is at
`~/agentconnect-irc` (a git repo) in case this checkout is ever blown away.
