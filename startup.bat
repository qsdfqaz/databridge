@echo off
echo Starting DataBridge...
cd /d "C:\Users\徐民华\airtable-plugin-proto"

:: Start server
start "DataBridge" /MIN node server.js

:: Wait for server
timeout /t 3 /nobreak >nul

:: Start ngrok tunnel
start "ngrok" /MIN ngrok http 3000

echo DataBridge started! Check ngrok dashboard for URL.
