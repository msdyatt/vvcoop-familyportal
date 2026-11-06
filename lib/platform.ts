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
 */
export type Platform = "ios" | "android" | "web";
export type Shell = "native" | "standalone" | "browser";

export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,c=window.Capacitor,ua=navigator.userAgent;
var native=!!(c&&c.isNativePlatform&&c.isNativePlatform());
var p=native&&c.getPlatform?c.getPlatform():(/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))?'ios':/Android/.test(ua)?'android':'web';
var s=native?'native':(matchMedia('(display-mode: standalone)').matches||navigator.standalone===true)?'standalone':'browser';
d.dataset.platform=p;d.dataset.shell=s;if(s!=='browser'&&p!=='web')d.dataset.app='1';}catch(e){}})();`;
