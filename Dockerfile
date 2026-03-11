# Use the LTS version of Node.js on Alpine Linux for a smaller footprint
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json (and package-lock.json if you have one)
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the application files (server.js, logic.js, src/, public assets, etc.)
COPY . .

# Set environment variables for production execution
# Note: Database secrets and API keys should NOT be set here. 
# They should be injected by your hosting provider at runtime.
ENV NODE_ENV=production
ENV PORT=4173

# Expose the default port your server.js listens on
EXPOSE 4173

# Start the Node.js server using the production script from package.json
CMD ["npm", "run", "start:prod"]
