; Windows Installer Script for TikTok LIVE Recorder (Inno Setup 6)
; Compile locally or in CI with:
;   ISCC.exe /DMyAppVersion=1.4.2 /DSourceDir=... /DOutputDir=... packaging\windows\installer.iss

#ifndef MyAppVersion
  #define MyAppVersion "2.0.0"
#endif

#ifndef SourceDir
  #define SourceDir "..\..\release-dist\staging\tiktok-live-recorder-v" + MyAppVersion + "-windows-x64"
#endif

#ifndef OutputDir
  #define OutputDir "..\..\release-dist\artifacts"
#endif

#ifndef OutputBaseName
  #define OutputBaseName "tiktok-live-recorder-v" + MyAppVersion + "-windows-x64-setup"
#endif

[Setup]
AppId={{B4E7F192-6C38-4E2A-9D51-7F83C12E4A90}
AppName=TikTok LIVE Recorder
AppVersion={#MyAppVersion}
AppVerName=TikTok LIVE Recorder v{#MyAppVersion}
AppPublisher=XploitVoid
AppPublisherURL=https://github.com/XploitVoid/tiktok-live-recorder
AppSupportURL=https://github.com/XploitVoid/tiktok-live-recorder/issues
AppUpdatesURL=https://github.com/XploitVoid/tiktok-live-recorder/releases
LicenseFile=..\..\LICENSE
DefaultDirName={localappdata}\Programs\TikTok LIVE Recorder
DefaultGroupName=TikTok LIVE Recorder
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayName=TikTok LIVE Recorder
#if FileExists("app.ico")
SetupIconFile=app.ico
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: filesandordirs; Name: "{app}\app\lib"
Type: filesandordirs; Name: "{app}\app\routes"
Type: filesandordirs; Name: "{app}\app\client"
Type: filesandordirs; Name: "{app}\app\node_modules"
Type: filesandordirs; Name: "{app}\runtime"

[Icons]
Name: "{autoprograms}\TikTok LIVE Recorder\TikTok LIVE Recorder"; Filename: "{app}\TikTok LIVE Recorder.bat"; WorkingDir: "{app}"
Name: "{autoprograms}\TikTok LIVE Recorder\Open Recordings Folder"; Filename: "{app}\app\recordings"
Name: "{autoprograms}\TikTok LIVE Recorder\Uninstall TikTok LIVE Recorder"; Filename: "{uninstallexe}"
Name: "{autodesktop}\TikTok LIVE Recorder"; Filename: "{app}\TikTok LIVE Recorder.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\TikTok LIVE Recorder.bat"; Description: "{cm:LaunchProgram,TikTok LIVE Recorder}"; Flags: nowait postinstall skipifsilent shellexec
