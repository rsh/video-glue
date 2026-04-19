#!/bin/bash
set -e

echo "Starting frontend development server..."

# Check if node_modules exists
if [ ! -d "frontend/node_modules" ]; then
    echo "Error: node_modules not found at frontend/node_modules"
    echo "Please run ./setup.sh first"
    exit 1
fi

# Start webpack dev server
cd frontend
echo "Starting webpack dev server on http://localhost:3000"
npm run dev
