@echo off
REM Installs the DeepLore server plugin into SillyTavern's plugins directory.
REM Run from the extension directory, or pass SillyTavern root as argument.

set PLUGIN_ID=deeplore
set SCRIPT_DIR=%~dp0

if not "%~1"=="" (
    set ST_ROOT=%~1
) else (
    set ST_ROOT=%SCRIPT_DIR%..\..\..\..\..
)

if not exist "%ST_ROOT%\src\server-main.js" (
    echo Error: Could not find SillyTavern at '%ST_ROOT%'
    echo Usage: %~nx0 [path-to-SillyTavern]
    exit /b 1
)

set TARGET=%ST_ROOT%\plugins\%PLUGIN_ID%

if not exist "%TARGET%" mkdir "%TARGET%"
copy /Y "%SCRIPT_DIR%server\index.js" "%TARGET%\index.js"

echo.
echo Server plugin installed to: %TARGET%
echo Restart SillyTavern to load the plugin.
echo Make sure 'enableServerPlugins: true' is set in config.yaml
