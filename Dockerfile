FROM node:22-alpine

WORKDIR /app

# Copy application files (excluding files in .dockerignore)
COPY . /app

ENV PORT=80
ENV HOST=0.0.0.0
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/healthz || exit 1

CMD ["node", "server.js"]

