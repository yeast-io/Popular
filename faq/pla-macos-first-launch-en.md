# `PLA` First launch on macOS

## English

**If macOS says it cannot verify that Popular Link Agent is free of malware, allow it through System Settings using the steps below.** Installation and first launch take approximately 2–3 minutes, excluding the download.

### Why this appears

The current Popular Link Agent (PLA) release has not completed Developer ID signing and Apple notarization. macOS may show **“Popular Link Agent” Not Opened**, with only a **Done** button.

This means macOS cannot complete its security verification. It does not establish that malware was detected or that the app is safe. Continue only if you trust the source and obtained the file from this project's release page.

### Install and open

1. Download `pla-<version>-universal.dmg` from the matching PLA release on the [Popular releases page](https://github.com/yeast-io/Popular/releases). This package supports Apple Silicon and Intel Macs; `pla-<version>.zip` is for Windows. Test releases are marked Pre-release.
2. Open the DMG and drag **Popular Link Agent.app** into **Applications** in Finder.
3. Open PLA from Applications. If macOS blocks it with the verification warning, dismiss the alert with **Done**.
4. Open **System Settings → Privacy & Security**. Scroll to Security and choose **Open Anyway** beside the PLA warning.
5. Authenticate if requested, then choose **Open** in the confirmation dialog.

macOS saves an exception for the app. Replacing or updating the package may require another confirmation. Labels and locations can vary by macOS version.

### Check that PLA is running

Look for the PLA icon in the menu bar at the top of the screen. If no window appears, use its menu to open settings, then enter your Gateway address, user API key and downloader configuration as directed by the interface.

Closing the settings window leaves PLA running in the menu bar. Use the menu's quit option to exit.

### Troubleshooting

| Situation | Action |
| --- | --- |
| Open Anyway is missing | Try opening PLA from Applications again, dismiss the alert, then revisit Privacy & Security. |
| The option is disabled or blocked on a managed Mac | Contact your device administrator. |
| macOS says the app will damage your computer, detects malware, or reports that the app is damaged | Stop. Do not force it open using this guide. Report the full alert, PLA version and macOS version to the project maintainers. |
| PLA still crashes or fails after approval | Report the PLA version, macOS version, Mac chip type and full error message for investigation. |

You do not need to disable Gatekeeper, enable apps from anywhere, or run terminal commands to remove quarantine attributes. This guide covers an exception for one app from a source you trust.

Reference: [Apple: Safely open apps on your Mac](https://support.apple.com/en-au/102445). A manual exception does not notarize the app.
