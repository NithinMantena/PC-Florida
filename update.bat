@echo off
REM ============================================================
REM  Florida P&C Market Explorer — refresh data and open site
REM  Run this after dropping a new quarter's .xlsx into this folder.
REM
REM  The hosted API (Supabase) is refreshed by GitHub when you commit and
REM  push the new .xlsx. To upload from this PC instead, set FLPC_URL and
REM  FLPC_LOAD_TOKEN (a token with the 'load' scope) before running this.
REM ============================================================
cd /d "%~dp0"
set PUSH=
if defined FLPC_LOAD_TOKEN if defined FLPC_URL set PUSH=--push
echo Rebuilding dataset from .xlsx files in this folder...
python etl\ingest.py %PUSH%
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
