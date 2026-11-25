# PCVR with Quest Link

Render an XR Blocks scene on a Windows PC and display it in a Quest headset
through an existing OpenXR runtime and Meta Horizon Link (formerly Quest Link).
The SDK uses browser WebXR for stereo views, head tracking, and controller input.
Meta's software owns USB transport, video encoding, and headset presentation.

## Run

1. Install Meta Horizon Link on your Windows PC. Connect the Quest 3 with a USB
   data cable and choose wired Link in the headset. Use the Link app's cable test
   to check the connection. Air Link must be off for wired acceptance testing.
2. In the Link app, open **Settings > General** and set Link as the active
   **OpenXR runtime**. Allow applications from unknown sources if required by
   your runtime. Close other immersive applications.
3. From the repository root, install and build the SDK, then start the server:

   ```sh
   npm ci
   npm run pcvr
   ```

   `npm ci` runs the repository's prepare build. On Windows, an SDK-only rebuild
   can also be run from PowerShell:

   ```powershell
   $env:XRBLOCKS_BUILD = 'sdk'
   npx rolldown -c
   Remove-Item Env:XRBLOCKS_BUILD
   ```

4. The command opens the PCVR page in your default browser. If it is not
   Chrome or Edge, copy the address into one of those browsers. On the **PC**, open
   `http://127.0.0.1:8080/templates/16_pcvr/` in current Chrome or Edge. Open the
   **XR** menu at the upper right and select **Enter PCVR**. Accept the browser's XR permission prompt if shown. Keep the
   page open on the PC while wearing the headset.

The sample uses the SDK's `enablePCVR()` preset to request `immersive-vr`
with the WebXR WebGL base layer for Quest Link compatibility. The preset
disables the desktop simulator and camera access. Initial loading needs
internet access for the import-map dependencies.

For scanned scenes, open the [3DGS Walkthrough](http://127.0.0.1:8080/samples/xr_realism/3dgs_walkthrough/) and select **Switch to PCVR** from the **XR** menu. It uses the Spark WebGL renderer and the same WebXR base layer. In VR, hold a controller trigger to switch between New York City and Alameda.

## Verify on the real headset

- See the blue cube and floor grid in stereo. Move and rotate your head: the
  scene must remain fixed in space.
- Aim either controller at the cube and release its trigger. The cube changes
  color. The PC page reports XR frames, stereo views, tracked inputs, and selections.
- End the session, reconnect Link if necessary, and enter again. The SDK
  refreshes availability on WebXR `devicechange` events and after session end.
- Confirm the Link app reports a cable connection. WebXR cannot identify the
  USB transport, distinguish USB from Air Link, or prove the headset model.

These checks require a physical headset. An emulated WebXR test does not verify
USB streaming, latency, headset presentation, or tracking quality.

## Troubleshooting

- **No PCVR headset available:** the initial headset check waits up to 10
  seconds. The entry button can recover when the browser reports availability.
  If the headset remains unavailable, start Link, verify the active OpenXR
  runtime, and reload the PC page. Runtime changes can require a browser restart.
- **Still unavailable:** Windows Chromium requires an OpenXR runtime that
  supports `XR_EXT_win32_appcontainer_compatible`. Check browser and runtime
  compatibility. An SDK setting cannot add a missing native runtime extension.
- **Entering XR takes a long time:** the browser has up to 150 seconds to enter
  VR. A detected disconnect or a timeout returns control to the page. After
  reconnecting Link, select **Enter PCVR** again. If the browser is still
  resetting the XR renderer, reload the page.
- **Browser permissions or session failure:** read the error below the entry
  button; close another XR session and try again. Use a top-level localhost or
  HTTPS page, not an insecure LAN address or a restricted iframe.
- **The VR session starts but no picture appears:** the page waits for a
  rendered stereo frame and reports a delay after 15 seconds. Keep Link active
  and the headset awake, or select **Exit XR** and retry. A late stereo frame
  clears the warning.
- **Exiting XR fails:** if the browser still has the session, the page reports
  the error and lets you select **Exit XR** again. If Link has disconnected,
  reconnect the headset before trying again.
- **Flat desktop screen in the headset:** select **Enter PCVR** in the PC page.
  Merely opening Link's desktop view does not start an immersive WebXR session.
- **Quest Browser:** this is the wrong browser for PC rendering. USB ADB port
  forwarding serves the PC's files to the headset, but rendering still happens
  on the Quest. This sample rejects that route.
- **Camera or depth samples fail:** PCVR does not imply access to standalone
  Quest passthrough, depth, or hand tracking. Use supported controllers and
  ordinary VR content first.

## References

- [Meta: set up Link with a cable](https://www.meta.com/help/quest/509273027107091/)
- [Meta: use Link for development and select the OpenXR runtime](https://developers.meta.com/vr/documentation/unreal/unreal-link/)
- [Chromium: supported WebXR runtimes on Windows](https://chromium.googlesource.com/chromium/src/+/main/device/vr/README.md)
