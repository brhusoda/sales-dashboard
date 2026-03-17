@echo off
cd /d "%~dp0"
echo Starting QBR Dashboard...
echo.
echo Importing data from Excel files...
node import.js
echo.
echo Starting server...
node server.js
pause
