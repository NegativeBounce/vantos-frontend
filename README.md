# vantos-frontend

VantosEdge frontend — a **map-first intelligence workspace**. Vite + React + TypeScript SPA
with **Mapbox GL**, Tailwind, and TanStack Query. Deployed as a **DigitalOcean App Platform
static site** in the same `vantos` app as the backend (topology A: `/` → frontend,
`/api` → backend; same origin, no CORS).

- **Governing repo (product truth):** `NegativeBounce/vantos-intelligence-reporting`
- **Backend API:** `NegativeBounce/vantos-backend`
- Frontend holds **no private credentials**. The only client token is the public,
  URL-restricted `VITE_MAPBOX_TOKEN`.

## Structure
```
src/main.tsx              entry (providers: QueryClient, Auth, Router)
src/App.tsx               routes (login + workspace)
src/pages/Login.tsx       login — NO sign-up (admin-provisioned accounts, D-32)
src/pages/Workspace.tsx   map workspace: Mapbox + layer rail + region panel + backend status
src/components/MapView.tsx Mapbox GL map
src/lib/api.ts            backend client (calls /api on the same origin)
src/lib/auth.tsx          PLACEHOLDER local auth gate (real auth is a later backend slice)
```

## Local development
```bash
cp .env.example .env      # set VITE_MAPBOX_TOKEN; leave VITE_API_BASE_URL empty (or point at the backend)
npm install
npm run dev
```

## Env (set in App Platform, BUILD_TIME)
- `VITE_MAPBOX_TOKEN` — public Mapbox client token (URL-restricted).
- `VITE_API_BASE_URL` — empty for topology A (same app); else the backend's URL.

## Status (Phase 1 scaffold)
Login → Mapbox workspace shell with layer toggles (placeholder) and **live backend wiring**
(health status + regions list from `/api`). Next: real AIS + ADS-B/GNSS-interference layers,
area selection (circle/bbox), and the report modal. Plan:
`vantos-intelligence-reporting/docs/technical-briefs/technical-brief_VantosEdge_Frontend-Plan-Map-First-Workspace_2026-06-16.md`.
