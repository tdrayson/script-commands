#!/usr/bin/osascript

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Enable VoiceOver
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 🗣️
# @raycast.packageName Accessibility

# Documentation:
# @raycast.description Enables VoiceOver by directly launching VoiceOverStarter. Skips splash screen after first run.
# @raycast.author taylor_drayson
# @raycast.authorURL https://raycast.com/taylor_drayson

try
	set doNotShowSplashScreen to (do shell script "defaults read com.apple.VoiceOverTraining doNotShowSplashScreen") as integer as boolean
on error
	set doNotShowSplashScreen to false
end try

if doNotShowSplashScreen then
	do shell script "/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter"
else
	do shell script "defaults write com.apple.VoiceOverTraining doNotShowSplashScreen -bool true && /System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter"
end if

log "VoiceOver enabled"