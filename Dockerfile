
# Use official Node.js LTS image and install tini for signal handling
FROM node:22
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

# Use non-root node user
USER node

# Create application directory
RUN mkdir -p /home/node/app

# Set working directory
WORKDIR /home/node/app

# Copy all source code (including tsconfig.json) first
COPY --chown=node:node . .

# Install dependencies (including dev)
RUN npm ci

# Build the application
RUN npm run build

# Remove devDependencies for production image
RUN npm prune --omit=dev

# Make entrypoint script executable
RUN chmod +x ./docker-entrypoint.sh

# Expose API port (if running in API mode)
EXPOSE 3000


# Entrypoint: use tini for proper signal forwarding
ENTRYPOINT ["/usr/bin/tini", "--", "/home/node/app/docker-entrypoint.sh"]

# Default to CLI mode
CMD ["cli"]

# CMD ["/bin/bash"]