@echo off
echo Starting WhatsApp CRM + ngrok...

:: Kill any existing instances
pm2 delete all 2>nul

:: Start Node.js server
pm2 start server.js --name "whatsapp-crm"

:: Start ngrok tunnel
pm2 start "ngrok http 3000 --domain=procurer-affecting-hypnoses.ngrok-free.dev" --name "ngrok-tunnel" --interpreter none

:: Save PM2 process list
pm2 save

echo.
echo Done! Both services are running in background.
echo App URL: https://procurer-affecting-hypnoses.ngrok-free.dev
echo.
pm2 list
pause
