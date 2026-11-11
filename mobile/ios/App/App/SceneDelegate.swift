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
    }

    func sceneWillResignActive(_ scene: UIScene) { AppLock.shared.willResignActive() }
    func sceneDidEnterBackground(_ scene: UIScene) { AppLock.shared.didEnterBackground() }
    func sceneDidBecomeActive(_ scene: UIScene) { AppLock.shared.didBecomeActive() }
}
