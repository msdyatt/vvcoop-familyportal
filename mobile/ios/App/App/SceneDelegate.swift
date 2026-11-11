import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: windowScene)
        let frame = FrameController()
        window?.rootViewController = frame
        window?.makeKeyAndVisible()
        if let window {
            AppLock.shared.attach(to: window)
            AppLock.shared.isSignedIn = { [weak frame] in frame?.isSignedIn ?? false }
        }
        PushManager.shared.openPath = { [weak frame] in frame?.openFromPush($0) }
        PushManager.shared.tokenChanged = { [weak frame] in frame?.tokenChanged($0) }
        #if DEBUG
        // `-VVSimulatePushTap /path` behaves like tapping a notification whose url is /path, as the launch tap.
        if let path = UserDefaults.standard.string(forKey: "VVSimulatePushTap") {
            DispatchQueue.main.async { PushManager.shared.openPath?(PushManager.safePath(path)) }
        }
        #endif
    }

    func sceneWillResignActive(_ scene: UIScene) { AppLock.shared.willResignActive() }
    func sceneDidEnterBackground(_ scene: UIScene) { AppLock.shared.didEnterBackground() }
    func sceneDidBecomeActive(_ scene: UIScene) { AppLock.shared.didBecomeActive() }
}
