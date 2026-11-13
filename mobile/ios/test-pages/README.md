# Frame test pages

Small static pages for checking the native frame without signing in to the portal. Debug builds
only: `-VVBaseURL` is ignored by a release build.

```
cd mobile/ios/test-pages && python3 -m http.server 8765
xcrun simctl launch --terminate-running-process <udid> org.veritasvillage.family \
  -VVBaseURL http://localhost:8765 -VVStartPath /test-frame/index.html
```

Tabs: start at `/test-frame/signin.html`, press Sign in; `tabs.html`, `photos.html`, `messages.html`
and `teacher.html` send the same `state` message the portal sends.

What each page proves is listed on the page itself. `path-configuration.json` has rules for
`/test-frame/sheet*` (opens as a sheet) and `/family-village/notifications` (the bell's sheet) and `/test-frame/replace*` (swaps the current page).

## Native Messages

`family-village/native-session/` stands in for the portal's `/family-village/native-session` page: it hands the frame a session for a
local mock Supabase (default `http://localhost:54431`, a script that serves invented people and conversations; never production) and
answers `session.refresh`. Start the mock, serve this folder, open the `messages.html` tab: the Messages tab is the native list.
`-VVNativeMessages NO` brings back the web page for comparison.

`mobile/ios/addfiles.py` registers new Swift files in `App.xcodeproj` (the project lists files explicitly):
`python3 addfiles.py Messages/NewFile.swift` from `mobile/ios`.
