import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3001;
const DEFAULT_CLIP_SECONDS = 30;
const HINT_REVEAL_SECONDS = 15;
const PRE_ROUND_COUNTDOWN_SECONDS = 3;

const rooms = new Map();

function makeRoom(roomCode) {
  return {
    roomCode,
    category: 'Any',
    hostId: null,
    players: new Map(),
    turnOrder: [],
    currentTurnIndex: 0,
    roundNumber: 0,
    totalRounds: 10,
    status: 'lobby',
    activeRound: null,
    timers: {
      roundTimeout: null,
      hintTimeouts: []
    }
  };
}

function serializePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    songsQueued: player.songQueue.length,
    submittedCurrentTurnSong: player.songQueue.length > 0,
    lastQueuedRound: player.lastQueuedRound ?? -1
  };
}

function maskedTitle(title, revealedIndexes) {
  return title
    .split('')
    .map((ch, idx) => {
      if (ch === ' ') return ' ';
      return revealedIndexes.has(idx) ? ch : '_';
    })
    .join('');
}

function publicRoomState(room) {
  const activeRound = room.activeRound
    ? {
        turnPlayerId: room.activeRound.turnPlayerId,
        maskedTitle: room.activeRound.maskedTitle,
        totalLength: room.activeRound.answerTitle.length,
        roundStartAt: room.activeRound.roundStartAt,
        startedAt: room.activeRound.startedAt,
        roundSeconds: room.activeRound.roundSeconds,
        previewUrl: room.activeRound.previewUrl,
        artworkUrl100: room.activeRound.artworkUrl100
      }
    : null;

  return {
    roomCode: room.roomCode,
    category: room.category,
    hostId: room.hostId,
    status: room.status,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: room.turnOrder,
    players: Array.from(room.players.values()).map(serializePlayer),
    activeRound
  };
}

function emitRoomState(room) {
  io.to(room.roomCode).emit('room:update', publicRoomState(room));
}

function emitSystemChat(roomCode, text) {
  io.to(roomCode).emit('chat:message', {
    id: crypto.randomUUID(),
    type: 'system',
    text,
    sentAt: Date.now()
  });
}

function clearTimers(room) {
  if (room.timers.roundTimeout) {
    clearTimeout(room.timers.roundTimeout);
    room.timers.roundTimeout = null;
  }
  room.timers.hintTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
  room.timers.hintTimeouts = [];
}

function normalize(input) {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function computeGuessPoints(startedAt, roundSeconds) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const ratioLeft = Math.max(0, (roundSeconds - elapsed) / roundSeconds);
  return Math.max(50, Math.round(500 * ratioLeft));
}

function finishGame(room) {
  room.status = 'finished';
  io.to(room.roomCode).emit('game:finished', {
    leaderboard: Array.from(room.players.values())
      .map((p) => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score)
  });
  emitRoomState(room);
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function isCloseGuess(guessNormalized, answerNormalized) {
  if (!guessNormalized || !answerNormalized) return false;
  if (guessNormalized === answerNormalized) return false;

  const maxLen = Math.max(guessNormalized.length, answerNormalized.length);
  if (maxLen < 5) {
    return levenshteinDistance(guessNormalized, answerNormalized) <= 1;
  }

  const threshold = Math.max(2, Math.floor(maxLen * 0.22));
  return levenshteinDistance(guessNormalized, answerNormalized) <= threshold;
}

function revealHint(room) {
  if (!room.activeRound) return;
  const { answerTitle, revealedIndexes } = room.activeRound;
  const candidates = [];

  for (let i = 0; i < answerTitle.length; i++) {
    const ch = answerTitle[i];
    if (ch !== ' ' && !revealedIndexes.has(i)) {
      candidates.push(i);
    }
  }

  if (candidates.length === 0) return;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  revealedIndexes.add(pick);
  room.activeRound.maskedTitle = maskedTitle(answerTitle, revealedIndexes);
  emitRoomState(room);
}

function endRound(room, reason = 'time_up') {
  if (!room.activeRound) return;
  clearTimers(room);

  io.to(room.roomCode).emit('round:ended', {
    reason,
    answerTitle: room.activeRound.answerTitle,
    byPlayerId: room.activeRound.turnPlayerId
  });

  room.activeRound = null;

  if (room.turnOrder.length === 0) {
    room.status = 'finished';
    emitRoomState(room);
    return;
  }

  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;

  const stillHasSongs = room.turnOrder.some((playerId) => {
    const p = room.players.get(playerId);
    return p && p.songQueue.length > 0;
  });

  if (room.roundNumber >= room.totalRounds || !stillHasSongs) {
    finishGame(room);
    return;
  }

  setTimeout(() => startNextRound(room), 1500);
  emitRoomState(room);
}

function startNextRound(room) {
  if (room.status === 'finished') return;

  clearTimers(room);

  let attempts = 0;
  let turnPlayer = null;

  while (attempts < room.turnOrder.length) {
    const candidateId = room.turnOrder[room.currentTurnIndex];
    const candidate = room.players.get(candidateId);
    if (candidate && candidate.songQueue.length > 0) {
      turnPlayer = candidate;
      break;
    }
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    attempts++;
  }

  if (!turnPlayer) {
    finishGame(room);
    return;
  }

  const song = turnPlayer.songQueue.shift();
  room.roundNumber += 1;
  room.status = 'playing';
  const roundSeconds = Math.max(10, Number(song.clipDurationSeconds) || DEFAULT_CLIP_SECONDS);

  const answerTitle = song.trackName.trim();
  const revealedIndexes = new Set();
  room.activeRound = {
    turnPlayerId: turnPlayer.id,
    answerTitle,
    answerNormalized: normalize(answerTitle),
    revealedIndexes,
    maskedTitle: maskedTitle(answerTitle, revealedIndexes),
    previewUrl: song.previewUrl,
    artworkUrl100: song.artworkUrl100 || '',
    roundSeconds,
    roundStartAt: Date.now() + PRE_ROUND_COUNTDOWN_SECONDS * 1000,
    startedAt: Date.now() + PRE_ROUND_COUNTDOWN_SECONDS * 1000,
    guessedPlayerIds: new Set()
  };

  io.to(room.roomCode).emit('round:started', {
    turnPlayerId: turnPlayer.id,
    submittedBy: turnPlayer.name,
    previewUrl: song.previewUrl,
    artworkUrl100: song.artworkUrl100 || '',
    countdownSeconds: PRE_ROUND_COUNTDOWN_SECONDS,
    roundStartAt: room.activeRound.roundStartAt,
    roundSeconds
  });

  const hintCount = Math.floor(roundSeconds / HINT_REVEAL_SECONDS) - 1;
  for (let i = 1; i <= hintCount; i++) {
    const timeoutId = setTimeout(
      () => revealHint(room),
      PRE_ROUND_COUNTDOWN_SECONDS * 1000 + HINT_REVEAL_SECONDS * i * 1000
    );
    room.timers.hintTimeouts.push(timeoutId);
  }

  room.timers.roundTimeout = setTimeout(
    () => endRound(room),
    (PRE_ROUND_COUNTDOWN_SECONDS + roundSeconds) * 1000
  );
  emitRoomState(room);
}

app.get('/api/search', async (req, res) => {
  const term = String(req.query.q || '').trim();

  if (!term) {
    return res.json({ results: [] });
  }

  const normalizedTerm = term.toLowerCase();
  const query = encodeURIComponent(term);
  const url = `https://itunes.apple.com/search?term=${query}&entity=song&attribute=songTerm&media=music&limit=40`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    const scored = (data.results || [])
      .filter((item) => item.previewUrl)
      .filter((item) => {
        if (!normalizedTerm) return true;
        const title = String(item.trackName || '').toLowerCase();
        const artist = String(item.artistName || '').toLowerCase();
        return title.includes(normalizedTerm) || artist.includes(normalizedTerm);
      })
      .map((item) => {
        const title = String(item.trackName || '').toLowerCase();
        const artist = String(item.artistName || '').toLowerCase();
        const titleExact = title === normalizedTerm;
        const titleStarts = title.startsWith(normalizedTerm);
        const titleIncludes = title.includes(normalizedTerm);
        const artistIncludes = artist.includes(normalizedTerm);

        let score = 0;
        if (titleExact) score += 100;
        if (titleStarts) score += 60;
        if (titleIncludes) score += 40;
        if (artistIncludes) score += 20;

        return {
          score,
          item
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, 15)
      .map((item) => ({
        id: item.trackId,
        trackName: item.trackName,
        artistName: item.artistName,
        artworkUrl100: item.artworkUrl100,
        previewUrl: item.previewUrl,
        collectionName: item.collectionName,
        clipDurationSeconds: DEFAULT_CLIP_SECONDS
      }));

    res.json({ results: scored });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch songs.' });
  }
});

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomCode, name }) => {
    if (!roomCode || !name) return;

    const normalizedRoom = roomCode.toUpperCase();
    let room = rooms.get(normalizedRoom);
    if (!room) {
      room = makeRoom(normalizedRoom);
      rooms.set(normalizedRoom, room);
    }

    const player = {
      id: socket.id,
      name: String(name).slice(0, 20),
      score: 0,
      songQueue: [],
      lastQueuedRound: -1
    };

    room.players.set(socket.id, player);
    room.turnOrder.push(socket.id);

    if (!room.hostId) room.hostId = socket.id;

    socket.join(normalizedRoom);
    socket.data.roomCode = normalizedRoom;

    emitRoomState(room);
    emitSystemChat(normalizedRoom, `${player.name} joined the room.`);
  });

  socket.on('room:setCategory', ({ category }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;

    room.category = String(category || 'Any').slice(0, 40);
    emitRoomState(room);
  });

  socket.on('room:setRounds', ({ totalRounds }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;

    const normalized = Math.max(1, Math.min(30, Number(totalRounds) || 10));
    room.totalRounds = normalized;
    emitRoomState(room);
  });

  socket.on('song:queue', ({ song }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !song?.trackName || !song?.previewUrl) return;

    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.status === 'finished') return;

    const queueWindowOpen = room.status === 'lobby' || (room.status === 'playing' && !room.activeRound);
    if (!queueWindowOpen) {
      socket.emit('game:error', { message: 'Queueing opens after the current round ends.' });
      return;
    }

    if (player.lastQueuedRound === room.roundNumber) {
      socket.emit('game:error', { message: 'You can queue only one song this round.' });
      return;
    }

    if (player.songQueue.length >= room.totalRounds) return;

    player.songQueue.push({
      trackName: song.trackName,
      previewUrl: song.previewUrl,
      artistName: song.artistName || '',
      artworkUrl100: song.artworkUrl100 || '',
      clipDurationSeconds: Number(song.clipDurationSeconds) || DEFAULT_CLIP_SECONDS
    });
    player.lastQueuedRound = room.roundNumber;

    emitRoomState(room);
  });

  socket.on('game:start', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;

    const hasAnySongs = Array.from(room.players.values()).some((p) => p.songQueue.length > 0);
    if (!hasAnySongs) {
      socket.emit('game:error', { message: 'At least one song is required to start.' });
      return;
    }

    room.currentTurnIndex = 0;
    startNextRound(room);
  });

  socket.on('chat:send', ({ text }) => {
    const roomCode = socket.data.roomCode;
    const messageText = String(text || '').trim();
    if (!roomCode || !messageText) return;

    const room = rooms.get(roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;

    if (room.activeRound && room.activeRound.turnPlayerId === socket.id) {
      socket.emit('game:error', { message: 'You cannot chat while your song is playing.' });
      return;
    }

    io.to(roomCode).emit('chat:message', {
      id: crypto.randomUUID(),
      type: 'chat',
      playerId: player.id,
      playerName: player.name,
      text: messageText.slice(0, 180),
      sentAt: Date.now()
    });
  });

  socket.on('guess:submit', ({ guess }) => {
    const roomCode = socket.data.roomCode;
    const guessText = String(guess || '').trim();
    if (!roomCode || !guessText) return;

    const room = rooms.get(roomCode);
    if (!room || !room.activeRound || room.status !== 'playing') return;

    const activeRound = room.activeRound;
    const player = room.players.get(socket.id);
    if (!player) return;

    if (Date.now() < activeRound.roundStartAt) {
      socket.emit('game:error', { message: 'Round is starting. Guessing opens after countdown.' });
      return;
    }

    if (socket.id === activeRound.turnPlayerId) return;

    const guessNormalized = normalize(guessText);

    if (guessNormalized === activeRound.answerNormalized) {
      if (activeRound.guessedPlayerIds.has(socket.id)) return;

      activeRound.guessedPlayerIds.add(socket.id);
      const guessPoints = computeGuessPoints(activeRound.startedAt, activeRound.roundSeconds);
      const ownerPoints = Math.round(guessPoints * 0.5);

      player.score += guessPoints;
      const owner = room.players.get(activeRound.turnPlayerId);
      if (owner) owner.score += ownerPoints;

      io.to(room.roomCode).emit('guess:correct', {
        playerId: socket.id,
        playerName: player.name,
        guessPoints,
        ownerPoints
      });

      io.to(room.roomCode).emit('guess:submitted', {
        id: crypto.randomUUID(),
        playerId: socket.id,
        playerName: player.name,
        guess: guessText,
        correct: true,
        guessPoints,
        close: false,
        sentAt: Date.now()
      });

      const nonTurnPlayers = room.turnOrder.filter((id) => id !== activeRound.turnPlayerId);
      const allNonTurnGuessed = nonTurnPlayers.every((id) => activeRound.guessedPlayerIds.has(id));

      emitRoomState(room);

      if (allNonTurnGuessed) {
        endRound(room, 'all_guessed');
      }
    } else {
      const close = isCloseGuess(guessNormalized, activeRound.answerNormalized);

      io.to(room.roomCode).emit('guess:wrong', {
        playerId: socket.id,
        playerName: player.name
      });

      io.to(room.roomCode).emit('guess:submitted', {
        id: crypto.randomUUID(),
        playerId: socket.id,
        playerName: player.name,
        guess: guessText,
        correct: false,
        close,
        sentAt: Date.now()
      });

      if (close) {
        socket.emit('game:error', { message: 'Close! You are very near the correct title.' });
      }
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    room.turnOrder = room.turnOrder.filter((id) => id !== socket.id);

    if (room.activeRound?.turnPlayerId === socket.id) {
      endRound(room, 'owner_left');
    }

    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(roomCode);
      return;
    }

    if (wasHost) {
      room.hostId = room.turnOrder[0] || null;
    }

    emitRoomState(room);
    emitSystemChat(roomCode, 'A player left the room.');
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
