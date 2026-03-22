import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { io, Socket } from 'socket.io-client'
import './App.css'

type SongResult = {
  id: number
  trackName: string
  artistName: string
  previewUrl: string
  clipDurationSeconds?: number
  artworkUrl100?: string
  collectionName?: string
}

type Player = {
  id: string
  name: string
  score: number
  songsQueued: number
  lastQueuedRound: number
}

type ActiveRound = {
  turnPlayerId: string
  maskedTitle: string
  totalLength: number
  roundStartAt: number
  startedAt: number
  roundSeconds: number
  previewUrl: string
  artworkUrl100?: string
}

type RoomState = {
  roomCode: string
  category: string
  hostId: string
  status: 'lobby' | 'playing' | 'finished'
  roundNumber: number
  totalRounds: number
  turnOrder: string[]
  players: Player[]
  activeRound: ActiveRound | null
}

type ChatItem = {
  id: string
  kind: 'chat' | 'system' | 'guess'
  playerName?: string
  text: string
  tone?: 'ok' | 'warn' | 'neutral'
}

function makeChatItem(text: string, tone?: 'ok' | 'warn' | 'neutral', kind: 'chat' | 'system' | 'guess' = 'system', playerName?: string): ChatItem {
  return {
    id: crypto.randomUUID(),
    kind,
    playerName,
    text,
    tone
  }
}

const API_BASE = import.meta.env.VITE_API_BASE || ''
const APP_NAME = 'Sampled'
const JOIN_BASE_URL = (import.meta.env.VITE_APP_BASE_URL || 'https://sampled.pitcocks.org').replace(/\/$/, '')
const categories = [
  'Any',
  'Pop',
  'Hip-Hop',
  'Rock',
  'Country',
  'R&B',
  'K-Pop',
  'Video Game Music',
  'Cartoon Themes',
  'Anime Openings',
  'Disney',
  'Movie Soundtracks',
  'TV Themes',
  'Meme Songs'
]

let socket: Socket | null = null

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}

function App() {
  const [playerName, setPlayerName] = useState('')
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [selfId, setSelfId] = useState('')
  const [linkedRoomCode, setLinkedRoomCode] = useState('')
  const [room, setRoom] = useState<RoomState | null>(null)
  const [roundPreviewUrl, setRoundPreviewUrl] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SongResult[]>([])
  const [chatItems, setChatItems] = useState<ChatItem[]>([])
  const [chatInput, setChatInput] = useState('')
  const [timeLeft, setTimeLeft] = useState(0)
  const [countdownLeft, setCountdownLeft] = useState(0)
  const [queuedSongIds, setQueuedSongIds] = useState<Set<number>>(new Set())
  const [copiedInvite, setCopiedInvite] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomFromLink = params.get('room')?.toUpperCase().trim() || ''
    if (roomFromLink) {
      setLinkedRoomCode(roomFromLink)
      setRoomCodeInput(roomFromLink)
    }
  }, [])

  useEffect(() => {
    socket = io(API_BASE, {
      autoConnect: true,
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnectionAttempts: 20
    })

    socket.on('connect', () => {
      setConnected(true)
      setSelfId(socket?.id || '')
    })

    socket.on('disconnect', () => {
      setConnected(false)
    })

    socket.on('room:update', (state: RoomState) => {
      setRoom(state)
    })

    socket.on('round:started', (payload) => {
      setRoundPreviewUrl(payload.previewUrl || '')
      setChatItems((prev) => [
        makeChatItem(`${payload.submittedBy} is up this round. Starting in ${payload.countdownSeconds}...`, 'neutral', 'system'),
        ...prev
      ].slice(0, 80))
    })

    socket.on('round:ended', (payload) => {
      setRoundPreviewUrl('')
      setChatItems((prev) => [makeChatItem(`Round over. Song: ${payload.answerTitle}`, 'neutral', 'system'), ...prev].slice(0, 80))
    })

    socket.on('chat:message', (payload) => {
      if (payload.type === 'chat') {
        setChatItems((prev) => [
          makeChatItem(payload.text, 'neutral', 'chat', payload.playerName),
          ...prev
        ].slice(0, 80))
        return
      }

      setChatItems((prev) => [makeChatItem(payload.text, 'neutral', 'system'), ...prev].slice(0, 80))
    })

    socket.on('guess:submitted', (payload) => {
      const guessSummary = payload.correct
        ? `"${payload.guess}" ✅ (+${payload.guessPoints})`
        : payload.close
          ? `"${payload.guess}" 🟨 Close!`
          : `"${payload.guess}" ❌`

      setChatItems((prev) => [
        makeChatItem(guessSummary, payload.correct ? 'ok' : payload.close ? 'neutral' : 'warn', 'guess', payload.playerName),
        ...prev
      ].slice(0, 80))
    })

    socket.on('game:finished', ({ leaderboard }) => {
      const top = leaderboard[0]
      if (top) {
        setChatItems((prev) => [makeChatItem(`Game finished. Winner: ${top.name} (${top.score})`, 'neutral', 'system'), ...prev].slice(0, 80))
      }
    })

    socket.on('game:error', ({ message }) => {
      setChatItems((prev) => [makeChatItem(message, 'warn', 'system'), ...prev].slice(0, 80))
    })

    return () => {
      socket?.disconnect()
      socket = null
    }
  }, [])

  useEffect(() => {
    const activeRound = room?.activeRound

    if (!activeRound) {
      setTimeLeft(0)
      setCountdownLeft(0)
      return
    }

    const tick = () => {
      const now = Date.now()
      const countdown = Math.max(0, Math.ceil((activeRound.roundStartAt - now) / 1000))
      setCountdownLeft(countdown)

      const elapsed = Math.max(0, Math.floor((now - activeRound.startedAt) / 1000))
      setTimeLeft(Math.max(0, activeRound.roundSeconds - elapsed))
    }

    tick()
    const interval = setInterval(tick, 500)
    return () => clearInterval(interval)
  }, [room?.activeRound])

  useEffect(() => {
    setQueuedSongIds(new Set())
  }, [room?.roomCode, room?.roundNumber])

  const me = useMemo(() => room?.players.find((p) => p.id === selfId), [room?.players, selfId])
  const amHost = room?.hostId === selfId
  const amTurnOwner = room?.activeRound?.turnPlayerId === selfId
  const activePreviewUrl = room?.activeRound?.previewUrl || roundPreviewUrl
  const activeArtworkUrl = room?.activeRound?.artworkUrl100 || ''
  const isRoundLive = !!room?.activeRound && countdownLeft <= 0
  const canGuess = !!room?.activeRound && !amTurnOwner && room?.status === 'playing' && isRoundLive
  const canUseChatInput = !amTurnOwner || !room?.activeRound
  const canQueueNow = !!room && (room.status === 'lobby' || (room.status === 'playing' && !room.activeRound))
  const isLobby = room?.status === 'lobby'
  const hasQueuedThisRound = !!room && !!me && me.lastQueuedRound === room.roundNumber
  const totalQueuedSongs = room?.players.reduce((sum, player) => sum + player.songsQueued, 0) || 0
  const inviteLink = room ? `${JOIN_BASE_URL}/?room=${encodeURIComponent(room.roomCode)}` : ''
  const roundProgress = room?.activeRound
    ? Math.min(1, Math.max(0, (room.activeRound.roundSeconds - timeLeft) / room.activeRound.roundSeconds))
    : 0
  const artworkBlurPx = room?.activeRound
    ? isRoundLive
      ? Math.max(8, 24 - roundProgress * 16)
      : 24
    : 24

  const joinRoom = (roomCode: string) => {
    if (!socket || !playerName.trim()) return
    const normalizedRoomCode = roomCode.toUpperCase().trim()
    if (!normalizedRoomCode) return
    socket.emit('room:join', { roomCode: normalizedRoomCode, name: playerName.trim() })
    const params = new URLSearchParams(window.location.search)
    params.set('room', normalizedRoomCode)
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`)
  }

  const copyInviteLink = async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopiedInvite(true)
      setTimeout(() => setCopiedInvite(false), 1500)
    } catch {
      window.prompt('Copy this invite link:', inviteLink)
    }
  }

  const onSearch = async (event: FormEvent) => {
    event.preventDefault()
    if (!room || !searchQuery.trim() || !canQueueNow) return

    setSearching(true)
    try {
      const params = new URLSearchParams({ q: searchQuery })
      const response = await fetch(`${API_BASE}/api/search?${params}`)
      const data = await response.json()
      setResults(data.results || [])
    } finally {
      setSearching(false)
    }
  }

  const queueSong = (song: SongResult) => {
    if (queuedSongIds.has(song.id)) return
    if (!room || hasQueuedThisRound || !canQueueNow) return
    socket?.emit('song:queue', { song })
    setQueuedSongIds((prev) => {
      const next = new Set(prev)
      next.add(song.id)
      return next
    })
  }

  const submitMessage = (event: FormEvent) => {
    event.preventDefault()
    const text = chatInput.trim()
    if (!text) return

    if (!canUseChatInput) {
      setChatItems((prev) => [makeChatItem('You cannot chat while your song is active.', 'warn', 'system'), ...prev].slice(0, 80))
      return
    }

    if (canGuess) {
      socket?.emit('guess:submit', { guess: text })
    } else {
      socket?.emit('chat:send', { text })
    }

    setChatInput('')
  }

  return (
    <main className="app-shell">
      <header>
        <h1>{APP_NAME}</h1>
        <p>Join by link code, queue songs, then guess title snippets faster for more points.</p>
      </header>

      {!room && (
        <section className="card join-grid">
          <label>
            Name
            <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Player name" />
          </label>
          <div className="inline-actions">
            <button onClick={() => joinRoom(makeRoomCode())} disabled={!connected || !playerName.trim()}>
              Create room
            </button>
          </div>
          <label>
            Room code
            <input value={roomCodeInput} onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())} placeholder="ABCDE" />
          </label>
          <button onClick={() => joinRoom(roomCodeInput)} disabled={!connected || !playerName.trim() || !roomCodeInput.trim()}>
            {linkedRoomCode ? 'Join from link' : 'Join room'}
          </button>
          {linkedRoomCode && <small>Invite link room detected: {linkedRoomCode}</small>}
          <small>Status: {connected ? 'connected' : 'disconnected'}</small>
        </section>
      )}

      {room && (
        <>
          {isLobby && (
            <>
              <section className="card top-bar lobby-bar">
                <div>
                  <strong>Room:</strong> {room.roomCode}
                </div>
                <div>
                  <button onClick={copyInviteLink}>{copiedInvite ? 'Copied!' : 'Copy invite link'}</button>
                </div>
                <div>
                  <strong>Category:</strong>{' '}
                  {amHost ? (
                    <select value={room.category} onChange={(e) => socket?.emit('room:setCategory', { category: e.target.value })}>
                      {categories.map((cat) => (
                        <option value={cat} key={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  ) : (
                    room.category
                  )}
                </div>
                <div>
                  <strong>Rounds:</strong>{' '}
                  {amHost ? (
                    <select value={room.totalRounds} onChange={(e) => socket?.emit('room:setRounds', { totalRounds: Number(e.target.value) })}>
                      {[3, 5, 8, 10, 12, 15, 20].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  ) : (
                    room.totalRounds
                  )}
                </div>
                <div>
                  <strong>Queued songs:</strong> {totalQueuedSongs}
                </div>
                {amHost && (
                  <button onClick={() => socket?.emit('game:start')} disabled={totalQueuedSongs === 0}>
                    Start game
                  </button>
                )}
              </section>

              <section className="grid-2">
                <article className="card">
                  <h2>Lobby players</h2>
                  <ul className="players">
                    {room.players.map((player) => (
                      <li key={player.id} className={player.id === selfId ? 'self' : ''}>
                        <span>
                          {player.name} {player.id === room.hostId ? '👑' : ''}
                        </span>
                        <span>{player.songsQueued} queued</span>
                      </li>
                    ))}
                  </ul>
                  <p className="subtle">Players join first, category is locked in lobby, and songs are queued before start.</p>
                </article>

                <article className="card">
                  <h2>Queue songs ({room.category})</h2>
                  <form onSubmit={onSearch} className="search-form">
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search songs..."
                      disabled={!canQueueNow}
                    />
                    <button type="submit" disabled={searching || !searchQuery.trim() || !canQueueNow}>
                      {searching ? 'Searching...' : 'Search'}
                    </button>
                  </form>
                  <ul className="results">
                    {results.map((song) => (
                      <li key={song.id}>
                        <div>
                          <strong>{song.trackName}</strong>
                          <p>
                            {song.artistName} {song.collectionName ? `· ${song.collectionName}` : ''}
                          </p>
                        </div>
                        <button
                          onClick={() => queueSong(song)}
                          disabled={!canQueueNow || hasQueuedThisRound || queuedSongIds.has(song.id)}
                          className={queuedSongIds.has(song.id) ? 'queued-btn' : ''}
                        >
                          {!canQueueNow ? 'Queue locked' : hasQueuedThisRound ? 'Queued this round' : queuedSongIds.has(song.id) ? 'Queued' : 'Queue'}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="subtle">One queue allowed per round. Queueing is open only after a round ends. Your pending songs: {me?.songsQueued ?? 0}</p>
                </article>
              </section>
            </>
          )}

          {!isLobby && (
            <section className="game-screen">
              <section className="card top-bar game-bar">
                <div>
                  <strong>Room:</strong> {room.roomCode}
                </div>
                <div>
                  <button onClick={copyInviteLink}>{copiedInvite ? 'Copied!' : 'Copy invite link'}</button>
                </div>
                <div>
                  <strong>Category:</strong> {room.category}
                </div>
                <div>
                  <strong>Round:</strong> {room.roundNumber} / {room.totalRounds}
                </div>
                <div>
                  <strong>Timer:</strong> {isRoundLive ? `${timeLeft}s` : `Starts in ${countdownLeft}s`}
                </div>
              </section>

              <section className="game-layout">
                <aside className="card players-panel">
                  <h2>Players</h2>
                  <ul className="players">
                    {room.players
                      .slice()
                      .sort((a, b) => b.score - a.score)
                      .map((player) => (
                        <li key={player.id} className={player.id === selfId ? 'self' : ''}>
                          <span>
                            {player.name} {player.id === room.hostId ? '👑' : ''}
                          </span>
                          <span>{player.score} pts</span>
                        </li>
                      ))}
                  </ul>

                  <div className="queue-next">
                    <h3>Queue next song</h3>
                    <form onSubmit={onSearch} className="search-form">
                      <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search songs..."
                        disabled={!canQueueNow}
                      />
                      <button type="submit" disabled={searching || !searchQuery.trim() || !canQueueNow}>
                        {searching ? 'Searching...' : 'Search'}
                      </button>
                    </form>
                    <ul className="results compact-results">
                      {results.slice(0, 6).map((song) => (
                        <li key={song.id}>
                          <div>
                            <strong>{song.trackName}</strong>
                            <p>{song.artistName}</p>
                          </div>
                          <button
                            onClick={() => queueSong(song)}
                            disabled={!canQueueNow || hasQueuedThisRound || queuedSongIds.has(song.id)}
                            className={queuedSongIds.has(song.id) ? 'queued-btn' : ''}
                          >
                            {!canQueueNow ? 'Queue locked' : hasQueuedThisRound ? 'Queued this round' : queuedSongIds.has(song.id) ? 'Queued' : 'Queue'}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="subtle">Queueing opens only between rounds. One queue per round.</p>
                  </div>
                </aside>

                <article className="card music-panel">
                  <h2>Now playing</h2>
                  {amTurnOwner && room.activeRound && (
                    <p className="owner-turn-banner">Your song is playing right now</p>
                  )}
                  <p>
                    Masked title: <strong>{room.activeRound?.maskedTitle || 'Waiting for next song'}</strong>
                  </p>
                  {room.activeRound && (
                    <p className="subtle">
                      Everyone hears the same round track. Guesses appear in the chat panel.
                    </p>
                  )}

                  {room.activeRound && !isRoundLive && (
                    <p className="countdown">Round starts in {countdownLeft}s...</p>
                  )}

                  <div className="cover-wrap">
                    {activeArtworkUrl ? (
                      <img
                        src={activeArtworkUrl}
                        alt="Album cover"
                        className="cover-image"
                        style={{ filter: `blur(${artworkBlurPx}px)` }}
                      />
                    ) : (
                      <div className="cover-placeholder">Album cover hidden</div>
                    )}
                  </div>

                  {activePreviewUrl && isRoundLive && (
                    <audio
                      key={activePreviewUrl}
                      controls
                      autoPlay
                      preload="auto"
                      playsInline
                      src={activePreviewUrl}
                      className="player"
                    />
                  )}

                </article>

                <aside className="card chat-panel">
                  <h2>Chat</h2>
                  {amTurnOwner && room.activeRound && <p className="subtle">It is your song this round. Chat is disabled until this round ends.</p>}

                  <ul className="chat-list">
                    {chatItems.map((item) => (
                      <li key={item.id} className={`chat-item ${item.tone || 'neutral'} ${item.kind}`}>
                        {item.playerName ? <strong>{item.playerName}: </strong> : null}
                        {item.text}
                      </li>
                    ))}
                    {chatItems.length === 0 && <li className="subtle">No messages yet.</li>}
                  </ul>
                  <form onSubmit={submitMessage} className="chat-form side-guess-form">
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={canUseChatInput ? (canGuess ? 'Type your guess...' : 'Send a message...') : 'Chat disabled while your song is playing'}
                      disabled={!canUseChatInput}
                    />
                    <button type="submit" disabled={!chatInput.trim() || !canUseChatInput}>
                      {canGuess ? 'Guess' : 'Send'}
                    </button>
                  </form>
                </aside>
              </section>
            </section>
          )}
        </>
      )}
    </main>
  )
}

export default App
