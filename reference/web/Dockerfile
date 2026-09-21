# care_fe from develop and the care-abdm frontend at CARE_ABDM_REF, served by nginx with CARE's API proxied.
# ADD resolves a branch to its latest commit on every build, so new care_fe commits rebuild its stage.

FROM node:22-bookworm-slim AS care-fe
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ADD https://github.com/ohcnetwork/care_fe.git#develop /app
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm install --ignore-scripts && npm run postinstall
ARG CARE_API_URL=http://localhost:4400
RUN REACT_CARE_API_URL="${CARE_API_URL}" npm run build

FROM node:22-bookworm-slim AS care-abdm-fe
ARG CARE_ABDM_REF=main
ADD https://github.com/ohcnetwork/care-abdm.git#${CARE_ABDM_REF} /src
WORKDIR /src/frontend
# Under /plugs/abdm/ so the files collide neither with care_fe's /assets/ nor with the /abdm/
# routes the plug adds to care_fe.
RUN npm ci --ignore-scripts && npx tsc -b && npx vite build --base=/plugs/abdm/

FROM nginx:stable-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=care-fe /app/build /usr/share/nginx/html
COPY --from=care-abdm-fe /src/frontend/dist /usr/share/nginx/plugs/abdm
