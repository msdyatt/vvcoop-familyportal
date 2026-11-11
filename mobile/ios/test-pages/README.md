# Frame test pages

Small static pages for checking the native frame without signing in to the portal. Debug builds
only: `-VVBaseURL` is ignored by a release build.

```
cd mobile/ios/test-pages && python3 -m http.server 8765
xcrun simctl launch --terminate-running-process <udid> org.veritasvillage.family \
  -VVBaseURL http://localhost:8765 -VVStartPath /test-frame/index.html
```

What each page proves is listed on the page itself. `path-configuration.json` has rules for
`/test-frame/sheet*` (opens as a sheet) and `/test-frame/replace*` (swaps the current page).
