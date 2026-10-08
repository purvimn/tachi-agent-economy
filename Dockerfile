# Single web process: Express serves the API and the built dashboard on $PORT.
# Deploy target is Tachi signet (testnet sats), so the run buttons are safe to expose publicly.
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm install && npm run build
ENV TACHI_NETWORK=signet
# Railway sets $PORT; the server honours it (defaults to 4402 locally).
EXPOSE 4402
# tsx runs the server straight from source; the vault ledger is written under /app/data
# (mount a Railway volume there so it survives redeploys).
CMD ["npx", "tsx", "apps/server/src/index.ts"]
