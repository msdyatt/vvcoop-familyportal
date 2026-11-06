import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The app is a native shell around the live portal. It does not bundle the
 * portal: the site is server-rendered and signed-in, so there is nothing to
 * bundle, and every web deploy reaches the apps instantly with no store review.
 *
 * `www/` holds only the small launch page that checks the connection and then
 * hands over to the portal. What makes this an app rather than a bookmark is
 * the native layer around it (push notifications, biometric unlock, native
 * sharing and camera) -- see README.md for what exists and what is waiting on
 * store accounts.
 *
 * appId is the permanent identity in both stores. Changing it after the first
 * submission means publishing a different app, so settle it before then.
 */
const config: CapacitorConfig = {
  appId: "org.veritasvillage.family",
  appName: "Veritas Village",
  webDir: "www",
  // Navy, so the strip the native layer leaves under the status bar and home
  // indicator matches the launch page and the Admin header.
  backgroundColor: "#0b2a3d",
  server: {
    // Pages on these hosts load inside the app (and get the native bridge);
    // every other link opens in the system browser instead.
    allowNavigation: ["family.veritasvillage.org", "jtwemgyhxylbhjzxgyvh.supabase.co"],
    androidScheme: "https",
  },
  ios: {
    // The page handles the notch and home indicator itself with
    // env(safe-area-inset-*) (see globals.css); a native inset on top of that
    // would be doubled, and "always" did not stop the page drawing under the
    // status bar on iOS 26 anyway.
    contentInset: "never",
  },
  // Avoids a Swift Package Manager name clash between the Firebase plugins.
  experimental: {
    ios: {
      spm: {
        packageOptions: {
          "@capacitor-firebase/messaging": { symlink: true },
        },
      },
    },
  },
  plugins: {
    // Show the notification banner and play the sound even while the app is open.
    FirebaseMessaging: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    SplashScreen: {
      backgroundColor: "#0b2a3d",
      launchShowDuration: 0,
      launchAutoHide: true,
      showSpinner: false,
    },
  },
};

export default config;
