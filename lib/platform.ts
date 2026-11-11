/**
 * Which kind of device and shell the page is running in. The same function is
 * inlined into the document head (app/layout.tsx) so the page is styled
 * correctly before it paints; this copy is for code that needs the answer.
 *
 *   platform: "ios" | "android" | "web"
 *   shell:    "native"     inside the iOS/Android app
 *             "standalone" added to a phone's home screen
 *             "browser"    an ordinary tab
 *
 * Platform styling (the tab bar, bottom sheets, system fonts, glass or tonal
 * surfaces) applies only to "native" and "standalone": on the website in a
 * browser the brand design is left alone.
 *
 * The iPhone app is a native frame around the site (docs/native-ios-frame.md).
 * Its web views get `window.VVNative` before any page script runs; then
 * `html[data-frame]` is set as well as the attributes above, and the frame
 * draws the navigation bar and tab bar itself. Android still runs inside
 * Capacitor and has no `data-frame`.
 */
export type Platform = "ios" | "android" | "web";
export type Shell = "native" | "standalone" | "browser";

export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,c=window.Capacitor,f=window.VVNative,ua=navigator.userAgent;
var frame=!!(f&&f.frame);
var native=frame||!!(c&&c.isNativePlatform&&c.isNativePlatform());
var p=frame?(f.platform||'ios'):native&&c.getPlatform?c.getPlatform():(/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))?'ios':/Android/.test(ua)?'android':'web';
var s=native?'native':(matchMedia('(display-mode: standalone)').matches||navigator.standalone===true)?'standalone':'browser';
d.dataset.platform=p;d.dataset.shell=s;if(frame)d.dataset.frame=p;if(s!=='browser'&&p!=='web')d.dataset.app='1';}catch(e){}})();`;
