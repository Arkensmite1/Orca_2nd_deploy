# ORCA frontend

React (CRA + CRACO), Tailwind, shadcn/ui, Leaflet.

```bash
cp .env.example .env   # set REACT_APP_BACKEND_URL
yarn install
yarn start             # dev server on :3000
yarn build             # production build in ./build
```

Deploy on Vercel with Root Directory `frontend` and the env var `REACT_APP_BACKEND_URL`. See the root README.
