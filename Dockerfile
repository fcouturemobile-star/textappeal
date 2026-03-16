FROM node:20-alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package.json ./
RUN npm install --production

# Copy built application and data files
COPY dist/ ./dist/
COPY server/data/memory.tmx ./server/data/memory.tmx
COPY server/data/glossary.csv ./server/data/glossary.csv

# Create uploads directory
RUN mkdir -p server/data/uploads

# Expose port
EXPOSE 5000

# Start the application
ENV NODE_ENV=production
ENV PORT=5000
CMD ["node", "dist/index.cjs"]
