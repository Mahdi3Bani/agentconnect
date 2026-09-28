# IRC platform adapter — where this is up to

Untracked working notes. Read this first.

## What this is

An IRC adapter for AgentConnect, contributed upstream (there is no plugin
system -- `docs/designs/integration-plugin-architecture.md` §13 says third-party
extensibility is deferred, so a platform lives in this repo or nowhere).

A maintainer said on issue #2262 that they welcome contributions adding widely
used chat platforms. Nothing has been posted to them yet -- no issue, no PR.
They do not know about this.

## Status: slice 0 is done and passing

The **required half** of `PlatformConnection` (`../platforms/contract.ts`), which
is six methods. Everything else in that interface is optional and probed for at
runtime.

```sh
cd ~/agentconnect/packages/daemon
npx vitest run test/irc-connection.test.ts       # 10/10
npx tsc --noEmit -p tsconfig.json | grep src/irc # clean
```

Note: `tsc --noEmit` reports ~900 errors across the package as a whole. That is
pre-existing and not from this work -- they build with tsdown, not plain tsc. Only
grep for `src/irc`.

| file                                | what                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `connection.ts`                     | the adapter                                                        |
| `test-server.ts`                    | a minimal IRC server whose advertised capabilities are a parameter |
| `irc-framework.d.ts`                | types -- the library ships none                                    |
| `../../test/irc-connection.test.ts` | 10 tests                                                           |

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

## Next: slice 1

Independent of the question above, so it does not wait on anyone.

- normalize an inbound PRIVMSG into their message shape (msgid from tags where
  granted, fallback where not)
- send outbound, using `echo-message` for confirmation where granted
- the 512-byte line limit: split on grapheme boundaries, not bytes
- flood pacing -- `../platforms/send-queue.ts` looks like the right seam

## Then the expensive part, not started

Registry entries across daemon, protocol, control-plane and web, plus the
manifest entry. Their QQ adapter touched 71 files. Guidance from #2262: do not
add a Prisma migration (reuse `Bot.platform` / `platformConfig` / `BotSecret`),
do not add a feature flag, do not refactor their registries -- copy the newest
platform's registration entries in the current style.

## Five things that only showed up by building it

1. `irc-framework` ships no type declarations, hence the local `.d.ts`.
2. `echo-message` is opt-in -- irc-framework requests it only if you pass
   `enable_echomessage`. Delivery confirmation depends on asking.
3. ISUPPORT (005) arrives **after** the `registered` event, so anything derived
   from it must be a lazy getter.
4. `CHANTYPES` returns a string on some ircds and an array on others.
5. `userlist` only fires for channels the client has joined, so `listMembers`
   reads RPL_NAMREPLY/RPL_ENDOFNAMES directly.

## Environment

Node >= 24.12.0 (25.4 works). pnpm is not installed globally -- use
`npx pnpm@11.19.0`. `pnpm install` is already done here; `irc-framework` is
already added to this package.

A second copy of just these files, with its own README, is at
`~/agentconnect-irc` (a git repo) in case this checkout is ever blown away.
