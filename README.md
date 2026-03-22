# Sampled (songl.io-style MVP)

Multiplayer music guessing game inspired by songl.io / skribbl.io:
- Players join a shared room code link
- Host picks a category
- Each player queues songs from a search bar
- Game cycles through each player’s queued songs
- 30–60 second preview snippet plays each round (currently 60s)
- Guess title quickly for higher points
- Hints reveal characters over time

## Stack
- Client: React + TypeScript (Vite) in `client/`
- Server: Express + Socket.IO in `server/`
- Song search + previews: iTunes Search API (`/api/search`)

## Run locally
1. Install dependencies:
   - `npm install`
   - `npm --prefix server install`
   - `npm --prefix client install`
2. Start app:
   - `npm run dev`
3. Open the client URL from Vite output (typically `http://localhost:5173`)

## Scripts
- `npm run dev` — run server + client together
- `npm run build` — build client
- `npm run start` — start server only

## Docker / Compose
- Build and start both services:
   - `docker compose up --build -d`
- Open app:
   - Client: `http://localhost:8080`
   - Server: `http://localhost:3001`
- Stop containers:
   - `docker compose down`

### API base URL for client build
- By default, the client image is built with `VITE_API_BASE=http://localhost:3001`.
- Override it at build time if needed:
   - `VITE_API_BASE=https://sampled.pitcocks.org docker compose up --build -d`

## Notes
- This MVP uses iTunes preview audio clips for zero-auth setup.
- If you want Spotify/Apple Music accounts and full catalog behavior, the server can be extended with OAuth and provider APIs.
- Room/game state is held in-memory (good for local + prototype use).
