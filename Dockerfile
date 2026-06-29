# Use official Node.js 18 image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (for faster builds)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy all project files
COPY . .

# Create required directories (in case they don't exist)
RUN mkdir -p media uploads

# Expose the port your app runs on
EXPOSE 3000

# Start the app
CMD ["node", "server.js"]
