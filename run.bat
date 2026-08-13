@echo off
title GPS Tracker
cd /d "%~dp0"

start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080"

where python >nul 2>nul
if %errorlevel%==0 (
    python server.py
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        py server.py
    ) else (
        echo Python not found. Install Python or use another server.
        pause
        exit /b 1
    )
)