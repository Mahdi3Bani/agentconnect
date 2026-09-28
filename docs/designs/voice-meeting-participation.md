# Voice Meeting Participation

> **Status:** Draft — a research assessment with a phased plan; nothing here is
> implemented. It answers [issue #2361](https://github.com/agentconnect-md/agentconnect/issues/2361)
> ("be able to talk or group meet in voice with agent"). File/line references describe
> the shipped machinery as of 2026-09-28; platform facts in §3 were checked against
> vendor documentation on the same date and are the part of this document most likely
> to go stale.
>
> **Scope:** daemon and protocol, with one console surface per phase. Every chat
> platform the daemon owns is assessed; the external meeting products (Google Meet,
> Zoom, Microsoft Teams, Slack huddles) are assessed as a separate provider seam. Speech
> models are external services in every phase — no Claude or Codex runtime accepts
> audio today (§3.7).
>
> Related documents:
> [architecture.md](architecture.md) (the Control Plane stays off the hot path — audio is
> message content),
> [integration-plugin-architecture.md](integration-plugin-architecture.md) (the seam every
> host change lands in),
> [message-intake.md](message-intake.md) (a spoken utterance is one channel-record row),
> [decisions.md](decisions.md) (the addressing gate and the provider-key seam),
> [channel-session-mode.md](channel-session-mode.md) (a room is an `append` conversation),
> [loop-breaker-design.md](loop-breaker-design.md) (an agent's own voice must not re-enter),
> [agent-authored-attachments.md](agent-authored-attachments.md) (the outbound byte path a
> spoken reply reuses),
> [inbound-file-attachments.md](inbound-file-attachments.md) (the inbound landing zone a
> voice note reuses),
> [webchat-multi-agents.md](webchat-multi-agents.md) (the console conversation a voice
> session extends),
> [../product-conventions.md](../product-conventions.md).

## 1. Background and goal

Issue #2361 asks for two things in one line: **talk in voice with an agent**, and **group
meet in voice with an agent**. The issue carries no body, so this document fixes what each
ask means before it fixes how to build it.

- _Talk in voice_ is one human and one agent, where the human speaks instead of typing and
  may prefer to hear the answer. It is asynchronous today (a voice note in Telegram) and
  synchronous tomorrow (a live microphone in the console).
- _Group meet in voice_ is several humans in a call — a Discord voice channel, a Google
  Meet, a Slack huddle — with an agent in the room as a participant: it hears what is said,
  answers when addressed, and carries the discussion into work it does afterwards.

The answer, up front:

- **A coding agent cannot be a voice assistant.** One ACP turn takes seconds to minutes and
  the runtime never accepts audio. The agent therefore joins a meeting the way it joins a
  Slack channel: as a participant that listens continuously, is addressed by name, answers
  in a bounded spoken form, and keeps working after the call. §2 makes that model precise;
  every later section is downstream of it.
- **Every platform needs the same core** (§5): a speech-provider seam, a voice room that
  turns audio into channel-record rows and spoken replies, and turn-taking rules on top of
  machinery the daemon already has — steering into a live turn, the addressing ladder,
  the Decision gate, and the turn output surface.
- **Discord is the only platform the daemon already owns whose voice API is open** (§3.1).
  It is the first real room. Slack has no huddle API and forbids bots in huddles (§3.2);
  Telegram's Bot API cannot join a group call (§3.6); Google Meet's media API is
  receive-only and gated (§3.3); Zoom's streaming API is receive-only and its participant
  SDK is native C++ (§3.4); Teams' media bot is .NET on Windows (§3.5). External meetings
  are therefore a **provider seam** (§5.5, phase 3), fronted by a meeting-bot service the
  organization runs or subscribes to, never by browser automation the daemon owns.
- **The first shippable slice is voice notes** (§6.1): every platform already delivers
  audio files the daemon drops or hands over as an opaque link. Transcribing them and
  answering with a spoken note is a small change on the attachment path and is the
  foundation the rooms stand on.

## 2. What "join a meeting" has to mean for a coding agent

### 2.1 The latency argument

A voice assistant answers within a second because a single model call produces the whole
reply. AgentConnect drives Claude Code or Codex over ACP: `AcpHost.prompt`
(`packages/daemon/src/acp/acp-host.ts:1258`) is one blocking `session/prompt`, the runtime
reads files, runs tools and thinks, and a turn that touches a repository routinely runs a
minute or more. Speech-to-speech models that bypass the runtime would answer fast and would
not be the agent the user asked for; §6.6 rejects that shortcut.

So the agent in a meeting is not the party you take turns with. It is the colleague who
sits in, says "let me check" when asked, and comes back with an answer while the
discussion has moved on. Three consequences shape the whole design:

1. **Listening is recording, not reacting.** Every utterance in the room is a channel-record
   row ([message-intake.md](message-intake.md) §3), whether or not any agent responds. A
   later activation is given the recent window as context, so "what did we decide about the
   migration" works because the transcript is there, not because the agent was awake.
2. **Answering is admission.** An utterance that addresses the agent is admitted into its
   session and starts a turn — or, when a turn is already running, is **steered** into it
   over `_session/steering` (`steerIntoLiveTurn`, `packages/daemon/src/daemon.ts:11430`),
   exactly as a follow-up Slack message is today. Nothing new is needed to let a human say
   "actually, also check the tests" mid-turn.
3. **Speaking is a bounded rendering of the reply.** The spoken form is one more turn
   output surface ([integration-plugin-architecture.md](integration-plugin-architecture.md)
   §7.3): a few sentences, never reasoning or tool output, with the full written reply
   posted to the room's text companion.

### 2.2 Three room modes

| Mode        | Who is admitted                                    | Typical use                                                      |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `listen`    | Nobody; every utterance is an observation          | Note-taker; "catch up on the meeting" from Slack later           |
| `addressed` | Utterances that name the agent, or pass a Decision | Group meeting with an agent in the room (the issue's second ask) |
| `talk-back` | Every utterance from the owner                     | One human, one agent (the issue's first ask)                     |

`addressed` reuses the two admission mechanisms the shared-bot path already has: the
name-match ladder and the **By decision** gate ([decisions.md](decisions.md) §4). Speech
recognition mangles names ("Claude" arrives as "cloud"), so the name match takes a per-agent
alias list and the Decision is the fallback for a room whose owner wants "answer when we are
clearly asking you" rather than a keyword.

### 2.3 Turn-taking rules

- **Acknowledge on admission.** The turn-start `react(seen)` intent (§7.1 of the plugin
  design) has a spoken counterpart: core names the intent, the voice surface picks a short
  phrase ("On it."). Without it a room hears nothing for a minute and assumes the agent
  missed the question.
- **Speak final text only** by default; a `medium` room may also speak progress notices,
  which are already a distinct action in every converger (`notice`/`progress` in
  `packages/daemon/src/discord/render.ts:35-48`). Reasoning and tool output are never spoken.
- **Bound the spoken reply.** The session's voice-mode prompt hint asks for a spoken answer
  of at most three sentences followed by the written detail; the surface additionally caps
  speech at a configurable length (default 45 s of audio) and says where the rest was
  posted. Both are needed: the hint keeps replies shaped, the cap keeps a runaway reply
  from holding the floor.
- **Barge-in.** A human speaking while the agent speaks stops playback; the written reply
  is unaffected. The dropped remainder is not re-spoken.
- **Never hear yourself.** An agent's own speech, and any other bot's, must not re-enter
  as an utterance. Discord identifies each speaker, so bot users are dropped at the source,
  the same identity rule the echo-drop uses. A mixed stream from a meeting provider relies
  on the provider's speaker labels and on muting the transcriber while the agent speaks.
  This is the voice arm of [loop-breaker-design.md](loop-breaker-design.md).

## 3. Platform landscape

What each platform lets a bot do in a call, checked on 2026-09-28. "Bot" here means an
application identity, not a signed-in human account.

| Platform              | Bot joins the call           | Receives audio                                                         | Sends audio      | Verdict                              |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| Discord voice channel | Yes, gateway voice           | Per speaker, decrypted with DAVE                                       | Yes              | **First room** (§6.2)                |
| Slack huddles         | No API; bots are blocked     | Only through a signed-in human account in a browser                    | Same             | Provider seam only, flagged (§3.2)   |
| Google Meet           | Media API: no participant    | Media API: receive-only, developer preview, every participant enrolled | No               | Provider seam (headless participant) |
| Zoom                  | Meeting SDK for Linux (C++)  | RTMS (GA, receive-only) or SDK raw audio                               | SDK only         | Provider seam                        |
| Microsoft Teams       | Graph calling bot            | App-hosted media, .NET on Windows only                                 | Same             | Provider seam                        |
| Feishu / Lark         | No real-time media API found | Post-meeting recordings and Minutes                                    | No               | Not a room; voice notes only (§3.6)  |
| Telegram              | Bot API cannot join calls    | User account over MTProto only                                         | Same             | Not a room; voice notes only         |
| Webchat (console)     | Our own surface              | Browser microphone                                                     | Browser playback | Second room, one human (§6.3)        |

### 3.1 Discord

A bot connects to a voice channel over the gateway with the `GuildVoiceStates` intent and
the `CONNECT` and `SPEAK` permissions, sends Opus over UDP, and receives one stream per
speaker. discord.js ships this as `@discordjs/voice`. Two facts set the cost:

- **End-to-end encryption is mandatory.** Discord finished rolling out its DAVE protocol to
  voice channels and enforces it for every client since March 2026. `@discordjs/voice`
  gained DAVE in the change merged on 2025-07-13 (voice 0.19) through the `@snazzah/davey`
  library, including decryption on the receive side. Any older voice stack cannot join.
- **Receiving is not officially documented.** Discord documents sending; receiving works
  and is what every transcription bot uses, but there is no support commitment. This is a
  stability risk, not an availability one, and §8 carries it.

Voice channels also have a built-in text chat, which is the natural text companion (§5.3).

### 3.2 Slack huddles

Slack exposes no API for huddle audio or transcripts and does not admit third-party bots
to a huddle. The only working approach in the wild is a **signed-in human Slack account**
driving a browser: a dedicated user joins the huddle, page audio is captured, and a virtual
microphone plays synthesized speech back. OpenClaw's huddle plugin and the `claw-huddle`
project both do exactly that. It costs a licensed seat per agent, runs against Slack's
intended use, and every review of OpenClaw's change centred on proving the bot could not be
tricked into the wrong huddle. AgentConnect should not ship it as a first-party module; an
organization that wants it can point the provider seam (§5.5) at a runner of its own.

Slack's own transcript products are the better fit. An **audio clip** posted in a channel
is a file whose object carries Slack's transcription once Slack has produced one, so phase 0
gets Slack voice notes with no speech provider at all. A **huddle** with AI notes leaves a
notes canvas in the huddle thread with the transcript embedded in it; today the Slack
normalizer reduces that canvas to a file link (`packages/message/src/slack-message.ts:139-155`)
and nothing reads its contents automatically, but the agent can open it on request through
the Slack canvas read port (`packages/daemon/src/platforms/read-ports.ts:168`). Reading
huddle notes into the channel record automatically is a phase-0 follow-up on that port, not
new transport.

### 3.3 Google Meet

The Meet Media API gives an app the conference's real-time audio and video over WebRTC —
and only that. Every media stream is receive-only, so an app cannot speak; the API is in
developer preview; and the Cloud project, the OAuth principal, and **every participant** of
the conference must be enrolled in the preview program. That rules it out for a product
feature. Meeting-bot products (Recall.ai, Attendee, Vexa, ScreenApp) join Meet as an
ordinary participant from a headless Chrome instead, and that is what the provider seam
gets for Meet.

### 3.4 Zoom

Two official routes, neither complete on its own:

- **Realtime Media Streams (RTMS)** is GA and streams per-participant audio, transcript and
  chat over WebSocket with no bot in the meeting — but it is a data pipeline, not a
  participant: an app cannot send audio or interact. It needs a Developer Pack subscription
  and account-level approval.
- **Meeting SDK for Linux** lets a headless C++ bot join as a participant, read raw audio
  per speaker, and feed a synthetic microphone. It requires the raw-data entitlement, an
  OBF token for meetings outside the account since February 2026, and a container with a
  virtual display and sound server.

Both are provider-seam material. A daemon never links the Zoom SDK.

### 3.5 Microsoft Teams

An application-hosted media bot receives and sends 20 ms audio frames through the Graph
Communications SDK, which exists only as a .NET library that must run on Windows; Microsoft
has no REST, WebSocket or other-language route and none on the roadmap. Provider seam only.

### 3.6 Feishu / Lark, Telegram, QQ

- **Feishu / Lark** exposes meeting management, cloud recordings, and Minutes (妙记)
  through its open platform; no real-time media or participant API was found. Treat this as
  unverified rather than settled (§7), and ship voice notes there in phase 0.
- **Telegram** bot accounts cannot join group voice or video chats; the libraries that do
  (tgcalls, pytgcalls) drive a **user** account over MTProto and need admin rights in the
  chat. Voice notes (`voice`, `audio`, `video_note`) are ordinary Bot API fields.
- **QQ** already delivers a voice message as an `audio/wav` attachment
  (`packages/message/src/qq-message.ts:86`).

### 3.7 Speech models

Neither runtime the daemon drives accepts audio. The Claude Messages API takes text and
images; audio input is an open feature request, and Claude Code's own voice feature is
client-side dictation into a text prompt. ACP defines an `audio` prompt block gated by
`promptCapabilities.audio`, which the daemon records
(`packages/daemon/src/acp/acp-host.ts:581-582`, `917`) but has never had a runtime
advertise (the ACP matrix profile pins `audio: false`,
`packages/daemon/test/acp-matrix/profiles.ts:492`). Speech-to-text and text-to-speech are
therefore external services in every phase, chosen per organization (§5.1), and the day a
runtime advertises `audio` the voice-note path gains a second, richer block without
changing the room design.

## 4. What already exists

The room design in §5 is mostly composition. The pieces, and where each falls short today:

| Piece                           | Where                                                                                                          | Gap for voice                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Attachment → ACP block          | `packages/daemon/src/session/attachment-block.ts:32-75`                                                        | Audio becomes an embedded blob or a `resource_link`; never an `audio` block, never text                                                |
| Telegram normalizer             | `packages/message/src/telegram-message.ts:53-54`, `75-76`                                                      | Models `photo` and `document` only; a voice note normalizes to an empty message                                                        |
| Feishu normalizer               | `packages/message/src/feishu-message.ts:64`                                                                    | Accepts `image` and `file` only; audio is dropped                                                                                      |
| Slack and Discord normalizers   | `slack-message.ts:139-155`, `discord-message.ts:74-86`                                                         | Audio passes through as a file; Discord's `duration_secs`/`waveform` and the voice-message flag are not read                           |
| Discord connection              | `packages/daemon/src/discord/connection.ts:239-249`, `138-148`                                                 | Text intents only; no `GuildVoiceStates`; invite permissions lack `CONNECT`/`SPEAK` (mirrored in `web/.../discord/invite.ts:17-24`)    |
| Agent-callable read ports       | `packages/daemon/src/platforms/read-ports.ts:190-198`                                                          | The registry that would gate a `joinVoiceChannel` tool by platform, before any connection exists                                       |
| Turn output surface             | `packages/daemon/src/platforms/turn-output.ts:82-144`; Discord registered at `daemon.ts:1372-1378`             | One surface per platform; a spoken surface is a second implementer on the same turn                                                    |
| Steering                        | `packages/daemon/src/acp/steering.ts`, `daemon.ts:11430-11463`, `daemon/steering-admission.ts`                 | Text only, ten steers per turn, ordinary user messages only — all fine for utterances                                                  |
| Channel record and observations | [message-intake.md](message-intake.md)                                                                         | Rows have no speaker timing; §5.3 adds a `voice` annotation                                                                            |
| Decision gate and provider keys | [decisions.md](decisions.md) §4, §5                                                                            | The provider-key model and data-plane rule a speech provider copies                                                                    |
| Webchat browser socket          | `packages/relay/src/relay-browser-server.ts:27`; frames `packages/protocol/src/frames/relay-daemon.ts:314-331` | JSON text only (binary frames are dropped, `packages/connection/src/ws-server-transport.ts:40`); 256 KiB cap; request-plus-ack per hop |
| Daemon packaging                | `packages/daemon/tsdown.config.ts`, `scripts/assert-self-contained.mjs`, `docker/Dockerfile:168-232`           | One self-contained bundle with no runtime dependencies; no native addons; no ffmpeg in the image; Windows CI                           |

Two of these decide the shape of phase 1. The **packaging rule** means codecs and DAVE
must be pure JavaScript or WASM (`opusscript`, `libsodium-wrappers` or `node:crypto`
AES-GCM, `@snazzah/davey`'s WASM build) and any native acceleration stays an optional
external like `bufferutil` is today. The **text-only webchat socket** means a live
microphone needs a new leg (§6.3), while everything after transcription — the turn, the
steer, the written reply — rides the socket unchanged.

## 5. Design

### 5.1 Speech providers

A daemon-side seam with two interfaces, configured per organization the way Decision
providers are ([decisions.md](decisions.md) §5): keys are saved in the console's Provider
keys page, delivered to capable daemons under a lease, and never injected into an agent's
environment. Audio bytes and transcripts travel only between the daemon and the provider;
the Control Plane sees configuration and body-free telemetry.

```ts
interface SpeechToText {
  // A live stream: PCM frames in, utterances out. `speaker` is the platform's identity
  // where the transport separates speakers, else the provider's diarization label.
  stream(opts: { sampleRate; language?; speaker? }): SttStream;
  // One file: the voice-note path. Returns text plus segments with timing.
  transcribe(bytes: Buffer, mimeType: string, opts?): Promise<Transcript>;
}
interface TextToSpeech {
  // Text in, audio frames out, with a cancel for barge-in.
  synthesize(text: string, opts: { voice?; language? }): TtsStream;
}
```

First implementers: the OpenAI speech endpoints (one key serves both directions), Deepgram
for streaming STT, and ElevenLabs for TTS. A self-hosted `whisper.cpp` or a local TTS is a
provider that speaks HTTP to a sidecar the operator runs; it is not linked into the daemon.
Provider choice, voice, and language are agent-level settings; the room mode (§2.2) is
per conversation.

### 5.2 The voice room

A room is a daemon-owned object: one platform call the agent is in. Its driver is a new
optional facet of the daemon platform module, declared in a registry the way read ports
are, so the `joinVoiceChannel`/`leaveVoiceChannel` tools are injected only for sessions on a
platform that has one:

```ts
interface VoiceRoomDriver {
  join(target: VoiceTarget, signal): Promise<VoiceRoom>;
}
interface VoiceRoom {
  readonly id: string;
  readonly participants: ReadonlyMap<string, { name; isBot }>;
  // One decoded PCM stream per speaker where the transport separates them (Discord); one
  // mixed stream with provider speaker labels otherwise (meeting providers).
  audioIn: AsyncIterable<{ speaker?: string; pcm: Buffer; at: number }>;
  speak(audio: TtsStream): Promise<void>; // resolves when played or cancelled
  cancelSpeech(): void;
  leave(): Promise<void>;
  onParticipants(cb): void;
  onEnded(cb): void;
}
```

Core owns the **voice host** around it: STT fan-in per speaker, utterance segmentation,
channel-record writes, the addressing ladder, dispatch or steer, the spoken turn output
surface, and the loop guard. The driver owns only transport: how to join, decode, encode,
and who is speaking. This is the same split as the three-facet adapter — connection and
identity in the module, sequencing in core — and it holds the two rules of the plugin
design: no platform name in core, and no manifest field, because nothing reads a room
capability before dispatch.

Where a room runs is where the daemon runs. Self-hosted, that is the operator's machine;
in the managed pool, the pod — which must be allowed UDP egress to Discord's voice servers
(§7). A room is a long-lived connection like a Slack socket, not a session, and survives
the agent's turns coming and going.

### 5.3 Records

- **One utterance, one row.** The voice host writes each final utterance to the channel
  record as a `text` row whose sender is the speaker's platform identity (Discord user id)
  or a provider label, with a `voice` annotation: start and end offsets, confidence, and
  the room id. A row a speaker corrected mid-sentence is replaced before it is final; partial
  hypotheses are never recorded.
- **Session coordinate.** A room is an `append` conversation
  ([channel-session-mode.md](channel-session-mode.md)): one ongoing session per agent per
  room, keyed on the platform conversation the call belongs to — a Discord voice channel
  id, a meeting id from the provider. The room's **text companion** (the voice channel's
  chat on Discord, the linked chat thread for a meeting, the webchat transcript in the
  console) receives every written reply and the join/leave notices, so a person who was not
  on the call can read what happened and continue it in text.
- **Audio is never persisted.** No recording, no buffering beyond what segmentation needs,
  no copy on the Control Plane. Recording as a product feature is out of scope and would be
  its own design with its own consent model.
- **Announce on join.** The room speaks a one-line notice ("<agent> has joined and is
  transcribing") and posts it to the companion; on by default, per-organization switch.
  Many jurisdictions require notice before transcription, and the notice is also how
  humans learn the agent is listening.
- **Audience.** The session's audience is the room's participants
  ([session-visibility.md](session-visibility.md)), resolved through the platform's identity
  where the transport gives one and left as display names from a meeting provider.

### 5.4 Spoken turn output

A `VoiceTurnOutputSurface` is a Layer-2 implementer registered beside the platform's text
surface for the same turn. It consumes the same action stream the converger produces:
`post`/`live-reply` final text is spoken once, bounded per §2.3; `notice` is spoken only in
a `medium` room; everything else is ignored. The text surface is untouched, so the written
reply lands in the companion exactly as it does today. Barge-in and the loop guard are core
concerns wired between `audioIn` and `speak`, not surface concerns.

The session prompt gains a voice-mode hint while the session is bound to a room, in the
same place platform context is injected today: the agent is told it is in a voice meeting,
who is in it, that the first three sentences of its reply will be spoken, and to put detail
after them.

### 5.5 The meeting-provider seam

External meetings do not get a platform module. A `MeetingBotProvider` is a second
implementer of `VoiceRoomDriver` whose transport is a service the daemon dials: it joins a
meeting by URL, streams mixed or per-speaker audio to the daemon over a WebSocket, accepts
audio to play, and reports participants. The room's conversation coordinate is
`meeting:<provider>:<meetingId>`, and its text companion is whichever chat the join was
requested from (the Slack thread where someone said "join this meeting").

Two provider kinds cover the market:

- **Hosted**: Recall.ai (Zoom, Meet, Teams, Webex, Slack huddles through a desktop SDK)
  with real-time audio in both directions over WebSocket.
- **Self-hosted**: an open-source meeting-bot runner the organization deploys beside its
  daemons — Attendee, Vexa, or ScreenApp's bot, all of which join Meet and Teams from a
  headless Chrome and Zoom through the Meeting SDK; audio output support differs by
  project and by version (Attendee lists it on its roadmap), so the implementer to pick is
  a phase-3 decision.

The daemon never automates a browser and never links a meeting SDK. That keeps the
packaging rule, keeps Zoom and Teams entitlements out of the daemon's configuration, and
lets an organization swap providers without a daemon release. A **join** is requested from
chat ("@agent join https://meet.google.com/…") or by a calendar trigger, which is future
work on the cron/hook seam.

### 5.6 Console

Product conventions apply: no internal component names, audience language for visibility.

- Agent settings, per platform that has a room driver: enable voice, room mode default,
  speech provider, voice, language, announce-on-join, spoken-reply cap.
- Session detail: the existing transcript view shows utterance rows with a speaker label,
  a small `voice` badge and the offset; the join/leave notices are ordinary chrome rows.
- Phase 2 adds the console's own microphone and playback controls to the Playground.

## 6. Phases

### 6.1 Phase 0 — voice notes (all platforms)

The smallest change that answers "talk in voice with agent", and the foundation for the
rest.

1. `Attachment` gains `kind: 'voice'` plus `durationMs`. Telegram maps `voice`, `audio`
   and `video_note`; Feishu maps its audio type; Discord reads the voice-message flag;
   Slack keeps the file and reads its `transcription` object when present; QQ keeps its
   `audio/wav`.
2. The speech-provider seam (§5.1), STT first, **run at intake, above the channel record.**
   The intake ladder records first and routes second ([message-intake.md](message-intake.md)
   §5): the channel-record row is written in `onInboundOutcome`
   (`packages/daemon/src/daemon.ts:8906-8927`) before the addressing ladder and the By decision
   gate ever see the message, and both judge the row's text. A voice note transcribed only at
   prompt build would therefore be recorded as an empty message with an opaque attachment,
   could not be admitted by the name it speaks in a shared channel, and could not be judged on
   its words. Transcription is instead a normalization step in the slot Telegram thread
   canonicalization occupies today (`daemon.ts:8916-8919`): it has no store writes, and it
   produces the text step 1 records. The row's text is the transcript, marked as spoken and
   carrying the `voice` annotation of §5.3, with the original file still attached and
   materialized through the landing zone of
   [inbound-file-attachments.md](inbound-file-attachments.md) §2 once that ships. Everything
   downstream — the ladder, the Decision, admission, steering, the prompt — then treats a
   voice note exactly like a typed message.

   Conditions, so the step costs nothing where it cannot matter: it runs only when an agent
   the message can reach on this connection has an STT provider configured, and a per-agent
   setting chooses **everywhere** or **direct messages only**, because record-first means an
   observed shared channel transcribes every note whether or not one is admitted. Bytes are
   fetched through the platform read port under the existing attachment cap and a duration
   cap. When there is no provider, the download fails, or the cap is exceeded, the note is
   recorded as it is today: an attachment the agent can open, never a spoken mention. A
   runtime that advertises `audio` also gets the ACP `audio` block (`attachment-block.ts`),
   which is the one line that changes there.

   **Relay-forwarded shared bots take the host route.** The slot above is Case A of
   [message-intake.md](message-intake.md) §5, daemon-owned ingress. A shared Slack or Feishu
   bot is Case B (§6): the relay arbitrates the target from the wire message — channel
   ownership, thread continuity, the agent-slug keyword, the channel default, the bot default
   (`packages/relay/src/bot-arbitration.ts`) — before any daemon sees it, and `handleRelayIm`
   (`daemon.ts:9623-9676`) records and routes the pre-addressed copy without passing through
   `onInboundOutcome`. The relay persists nothing and calls no provider, so it cannot
   transcribe, and a voice-only note has no text for the slug or a Decision to read: agent B's
   spoken name would land on default agent A or nowhere. Phase 0 therefore gives a voice-only
   note the one-copy-to-a-host mechanism Case B already has for By decision routing:

   - The relay recognizes it from the wire alone — empty `text` and one `audio/*` attachment,
     a content-free pre-dispatch read — and forwards its single copy to the conversation's
     **transcription host** with a routing disposition, exactly as a By decision message goes
     to its evaluation host.
   - The host is the projected `evaluationDaemonId` where the conversation has one; otherwise
     the same Control Plane rule computes it for voice (the bot's default agent's daemon, else
     the earliest-created daemon among the candidate agents' daemons), restricted to daemons
     that advertised `voice-note-stt-v1` in `rd/hello` and hold an STT provider, and projected
     as a second field on `rc/bot-assign`.
   - The host downloads the bytes with the bot credential it already holds for reads,
     transcribes, records the row with the transcript as its text, runs Case A steps 2–4 on
     that text — the slug, the mention, and a bound Decision all see the spoken words — and
     distributes the frozen set: local targets admit directly, remote targets travel as
     `rd/route` with the transcript in `payload.text`, so no target transcribes twice. This is
     `hostRoutedIm` (`daemon.ts:19515`) with a transcription step ahead of its ladder, not a
     second distribution path.
   - **Where the host route is unavailable** — no daemon on the bot advertises the capability,
     or the relay or Control Plane predates the projection — but some agent on the bot holds a
     provider, the note takes today's path: the relay's arbitration on empty text selects the
     channel or bot default agent, whose daemon transcribes at its own intake (the Case A slot)
     for its own prompt, and a spoken name cannot select another agent. That is the narrowed
     promise for relay platforms, and the bot's settings page says which of these a bot has.
   - **Where no agent on the bot holds a provider**, nothing transcribes anywhere: the same
     arbitration picks the default agent, and its daemon keeps the note as an attachment under
     the no-provider rule above.

3. Spoken replies: when a turn was started by a voice note and the agent's TTS is
   configured, the final reply is also synthesized and sent through the platform's
   `uploadFile` path as a voice note where the platform has one (Telegram `sendVoice`,
   Discord voice message, Slack audio file). This reuses the outbound byte path of
   [agent-authored-attachments.md](agent-authored-attachments.md) and needs no new surface.

Cost: normalizers, one intake-ladder step, the host route's transcription step and its
`rc/bot-assign` projection, one attachment-path change, a provider seam with one implementer,
and a Provider keys entry. No new connection, no codec, no packaging change.

### 6.2 Phase 1 — Discord voice channels (the first room)

1. `@discordjs/voice` with `@snazzah/davey`; `GuildVoiceStates` intent; `CONNECT` and
   `SPEAK` in the invite permissions (both copies). Pure-JS/WASM Opus and encryption; any
   native speedup stays external. The voice facet is absent on platforms that cannot load
   it, and the Windows unit suites skip the room tests.
2. The Discord `VoiceRoomDriver`: join by channel id, one decoded PCM stream per speaker,
   bot speakers dropped at the source, Opus playback with cancel.
3. The voice host in core (§5.2–§5.4): segmentation, channel-record rows, the addressing
   ladder with aliases and the Decision fallback, dispatch and steer, the spoken surface,
   the prompt hint, announce-on-join.
4. Entry points: the `joinVoiceChannel`/`leaveVoiceChannel` tools gated by the read-port
   style registry, and a `/voice join|leave` slash command beside the existing command
   chrome. A room ends when the channel empties or the agent is told to leave.
5. Console: the agent's Discord settings gain the voice block (§5.6); the session detail
   view gains the speaker label.

Behind a `voice.discord` feature flag until the receive path has run in production for a
release, because of §3.1's second fact.

### 6.3 Phase 2 — webchat voice (one human, the console)

Audio cannot ride the webchat socket (§4). Two options, one recommended:

- **Recommended: a media leg beside the socket.** The browser captures the microphone and
  sends 20 ms Opus frames over a second WebSocket at the relay, authenticated with the
  same conversation token, which the relay forwards to the owning daemon over a
  capability-gated binary `rd/*` stream; playback comes back the same way. The daemon runs
  the same voice host as Discord with a `webchat` room driver. The relay still persists
  nothing and the Control Plane still carries nothing. WebRTC through a media server is
  the same shape at higher cost and is not needed for one speaker.
- **Fallback: browser-side recognition.** The console transcribes with the browser's own
  speech API and sends ordinary `turn` and `steer: true` frames; playback uses browser
  speech synthesis. Zero server audio, no provider cost, uneven quality and privacy across
  browsers. Worth shipping as the no-provider mode, not as the design.

A webchat conversation has one human owner, so this is the issue's first ask done live,
not a group room; several humans in one console room is a later extension of the
multi-agent roster.

### 6.4 Phase 3 — external meetings

The `MeetingBotProvider` seam (§5.5) with one hosted and one self-hosted implementer,
Meet and Zoom first because both providers cover them, Teams through the same providers,
Slack huddles only where an organization brings its own signed-in runner. Join from chat;
calendar-driven joins on the trigger seam later.

### 6.5 Sequencing and dependencies

```
phase 0 voice notes ──► phase 1 Discord room ──► phase 2 webchat room
  (speech providers)       (voice host)            (media leg)
                                 └──────────────► phase 3 meeting providers
```

Phase 0 ships alone. Phase 1 needs phase 0's seam and builds the host; phases 2 and 3 are
new drivers on that host and can proceed in either order.

### 6.6 Deliberately not done

- **No browser automation in the daemon**, for huddles or any meeting product (§3.2, §5.5).
- **No recordings** and no audio persistence anywhere (§5.3).
- **No speech-to-speech model in place of the agent.** A fast voice model that answers
  without running the ACP turn is a different product; the agent's value is the work it
  does, and a fast "ack" is all the room needs (§2.3).
- **No Telegram group calls** and **no Feishu meetings** until an official bot route exists.
- **No manifest field.** Room support is a host-contract facet; nothing reads it before
  dispatch.

## 7. Open questions to verify before implementation

1. Discord's receive path under DAVE in `@discordjs/voice` 0.19+: stability across the
   session-downgrade cases the PR handles, and whether Discord's developer terms say
   anything about bots consuming voice.
2. Whether pool pods may open UDP to Discord's voice servers, and what the sandbox
   NetworkPolicy needs ([k8s-daemon-pool.md](k8s-daemon-pool.md) D3 covers only the shim).
3. Whether a WASM DAVE and Opus stack keeps up with a busy room on the daemon's CPU
   budget, or native acceleration must be the documented default for voice-enabled daemons.
4. Feishu / Lark: an official real-time media or participant API, if one exists for
   enterprise plans.
5. Which self-hosted meeting-bot runner supports audio output today, and under what
   licence.
6. Speech-provider cost per meeting hour at streaming STT rates, and whether the Cloud
   deployment funds it through the same credit path as Decisions.
7. Whether `claude-agent-acp` or `codex-acp` plan to advertise `promptCapabilities.audio`.
8. Consent requirements for automatic transcription in the jurisdictions Cloud serves,
   beyond the announce-on-join default.

## 8. Risks

- **Undocumented receive on Discord** (§3.1). Mitigation: the feature flag, a health probe
  that detects silent decryption failure, and a fallback to `listen`-less presence (speak
  only) if receive breaks in a Discord change.
- **Speech recognition mangling names** makes `addressed` mode miss or over-trigger.
  Mitigation: aliases, the Decision fallback, and the talk-back mode for one-on-one use.
- **A room holds a socket open for hours.** Reconciliation, drain, and upgrade flows treat
  it as a platform connection; an upgrade mid-meeting drops the agent from the call, which
  the daemon must announce in the companion.
- **Loops between agents** in one room (§2.3). Speaker identity on Discord makes this
  cheap; provider labels are weaker, so a meeting room defaults to one agent.
- **Provider dependence.** Every phase needs a third-party speech model; an organization
  without a configured provider gets phase 0's Slack transcripts and phase 2's browser
  fallback and nothing else. The console must say so plainly.
- **Cost surprise.** Streaming STT for a room that nobody addresses is the same price as
  one that is used. Rooms default to leaving after a configurable idle period.

## 9. Recommended sequencing

1. Phase 0 now. It closes the first ask asynchronously on five platforms, is small, and
   creates the provider seam every later phase needs.
2. Phase 1 next, behind a flag, on the one platform whose API is open. It is the proof of
   the room model — steering, addressing, and the spoken surface — on a transport the
   daemon already owns.
3. Phase 2 once the host is stable, because the console is where a one-on-one voice
   conversation is most natural and where AgentConnect controls both ends.
4. Phase 3 when a provider partner or a self-hosted runner is chosen; nothing in it changes
   the host.

## 10. Sources

- [Issue #2361](https://github.com/agentconnect-md/agentconnect/issues/2361)
- Discord: [End-to-End Encryption for Audio and Video](https://support.discord.com/hc/en-us/articles/25968222946071-End-to-End-Encryption-for-Audio-and-Video),
  [DAVE protocol](https://daveprotocol.com/),
  [discord.js DAVE support PR](https://github.com/discordjs/discord.js/pull/10921) and
  [issue](https://github.com/discordjs/discord.js/issues/10735),
  [@discordjs/voice](https://www.npmjs.com/package/@discordjs/voice),
  [voice messages API documentation](https://github.com/discord/discord-api-docs/pull/6082)
- Slack: [Recall.ai on Slack huddles](https://www.recall.ai/product/slack-huddles-api),
  [OpenClaw huddle plugin PR](https://github.com/openclaw/openclaw/pull/159879),
  [claw-huddle](https://github.com/jlgrimes/claw-huddle),
  [Record audio and video clips in Slack](https://slack.com/help/articles/4406235165587-Record-audio-and-video-clips-in-Slack)
- Google Meet: [Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview),
  [concepts](https://developers.google.com/workspace/meet/media-api/guides/concepts)
- Zoom: [Realtime Media Streams](https://developers.zoom.us/docs/rtms/),
  [Meeting SDK Linux raw recording sample](https://github.com/zoom/meetingsdk-linux-raw-recording-sample)
- Microsoft Teams: [Real-time media calls and meetings for bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)
- Telegram: [tgcalls](https://github.com/MarshalX/tgcalls)
- Feishu: [Meeting solutions on the open platform](https://open.feishu.cn/solutions/detail/meetings?lang=zh-CN)
- Meeting-bot providers: [Recall.ai meeting-bot](https://github.com/recallai/meeting-bot),
  [Attendee](https://github.com/attendee-labs/attendee), [Vexa](https://vexa.ai/),
  [ScreenApp meeting-bot](https://github.com/screenappai/meeting-bot),
  [Meeting BaaS speaking bots](https://www.meetingbaas.com/en/api/speaking-bots-api)
- Speech and Claude: [audio input feature request](https://github.com/anthropics/anthropic-sdk-python/issues/1198),
  [Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation)
