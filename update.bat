@echo off
REM ============================================================
REM  Florida P&C Market Explorer — refresh data and open site
REM  Run this after dropping a new quarter's .xlsx into this folder.
REM ============================================================
cd /d "%~dp0"
echo Rebuilding dataset from .xlsx files in this folder...
python etl\ingest.py
if errorlevel 1 (
  echo.
  echo *** ETL FAILED — see message above. ***
  pause
  exit /b 1
)
echo.
echo Opening the explorer in your browser...
start "" "%~dp0web\index.html"
echo Done. (You can close this window.)
